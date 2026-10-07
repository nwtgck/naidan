import { afterEach, expect, it, vi } from 'vitest';
import { writeImageInputs } from './image-input';
import { emptyImageInputs } from '@/features/image-generation/image-input-form';

function harness({ pointerBytes }: { pointerBytes: 4 | 8 }) {
  const memory = new Uint8Array(8192), fields = new Map<string, number | bigint>();
  const owned: bigint[] = [];
  let next = 1024n;
  const bitmap = { width: 2, height: 1, close: vi.fn() };
  const canvases: { width: number, height: number }[] = [];
  vi.stubGlobal('createImageBitmap', vi.fn(async () => bitmap));
  const context = { fillStyle: '', fillRect: vi.fn(), drawImage: vi.fn(), getImageData: vi.fn(() => ({ data: new Uint8ClampedArray([1, 2, 3, 255, 4, 5, 6, 255]) })) };
  vi.stubGlobal('OffscreenCanvas', class {
    width: number;
    height: number;
    constructor(width: number, height: number) {
      this.width = width; this.height = height; canvases.push(this);
    }
    getContext() {
      return context;
    }
  });
  const core = {
    pointerBytes,
    alloc: vi.fn((bytes: number | bigint) => {
      const ptr = next; next += BigInt(bytes); return ptr;
    }),
    bytes: vi.fn((pointer: bigint, length: number | bigint) => memory.subarray(Number(pointer), Number(pointer) + Number(length))),
    fieldAddress: vi.fn(() => 64n),
    recordSize: vi.fn(() => pointerBytes === 4 ? 16 : 24),
    setField: vi.fn((record: string, pointer: bigint, field: string, value: number | bigint) => {
      fields.set(`${record}:${pointer}:${field}`, value);
    }),
  };
  return {
    core,
    fields,
    memory,
    bitmap,
    canvases,
    context,
    owned,
    keep({ pointer }: { pointer: bigint }) {
      owned.push(pointer); return pointer;
    },
  };
}
const file = new File(['encoded image bytes'], 'source.png', { type: 'image/png' });

afterEach(() => vi.unstubAllGlobals());

it.each([4, 8] as const)('writes independent init and ordered reference records using %i-byte generated layout', async pointerBytes => {
  const h = harness({ pointerBytes });
  const decoded = vi.fn();
  await writeImageInputs({
    core: h.core,
    params: 8n,
    inputs: { initImage: file, strength: 0.4, referenceImages: [file, file] },
    keep: h.keep,
    checkCancelled() {},
    onDecoded: decoded,
  });
  expect(h.fields.get('sd_img_gen_params_t:8:strength')).toBe(0.4);
  expect(h.fields.get('sd_image_t:64:width')).toBe(2);
  expect(h.fields.get('sd_image_t:64:channel')).toBe(3);
  const pixels = BigInt(h.fields.get('sd_image_t:64:data')!);
  expect([...h.core.bytes(pixels, 6)]).toEqual([1, 2, 3, 4, 5, 6]);
  const refs = BigInt(h.fields.get('sd_img_gen_params_t:8:ref_images')!);
  expect(h.fields.get('sd_img_gen_params_t:8:ref_images_count')).toBe(2);
  expect(h.fields.get(`sd_image_t:${refs}:height`)).toBe(1);
  expect(h.fields.get(`sd_image_t:${refs + BigInt(pointerBytes === 4 ? 16 : 24)}:height`)).toBe(1);
  expect(h.bitmap.close).toHaveBeenCalledTimes(3);
  expect(h.canvases.every(canvas => canvas.width === 0 && canvas.height === 0)).toBe(true);
  expect(h.context.fillStyle).toBe('#ffffff');
  expect(decoded.mock.calls.map(([value]) => value.metadata.role)).toEqual(['initial', 'reference', 'reference']);
  // Native memory remains owned by the enclosing generation through its call.
  expect(h.owned).toHaveLength(4);
});

it('does no decoding or allocation for text-only generation', async () => {
  const h = harness({ pointerBytes: 4 });
  await writeImageInputs({ core: h.core, params: 8n, inputs: emptyImageInputs(), keep: h.keep, checkCancelled() {}, onDecoded() {} });
  expect(createImageBitmap).not.toHaveBeenCalled(); expect(h.core.alloc).not.toHaveBeenCalled();
});

it('closes a decoded bitmap when cancelled before copying pixels', async () => {
  const h = harness({ pointerBytes: 8 }); let checks = 0;
  await expect(writeImageInputs({
    core: h.core,
    params: 8n,
    inputs: { ...emptyImageInputs(), initImage: file },
    keep: h.keep,
    checkCancelled() {
      if (++checks === 2) throw new DOMException('Stopped', 'AbortError');
    },
    onDecoded() {},
  })).rejects.toMatchObject({ name: 'AbortError' });
  expect(h.bitmap.close).toHaveBeenCalledOnce(); expect(h.core.alloc).not.toHaveBeenCalled(); expect(h.canvases).toHaveLength(0);
});

it('rejects unsafe native dimensions before canvas/native allocation and closes the bitmap', async () => {
  const h = harness({ pointerBytes: 4 }); h.bitmap.width = 2147483647;
  await expect(writeImageInputs({ core: h.core, params: 8n, inputs: { ...emptyImageInputs(), initImage: file }, keep: h.keep, checkCancelled() {}, onDecoded() {} })).rejects.toThrow('addressable');
  expect(h.bitmap.close).toHaveBeenCalledOnce(); expect(h.core.alloc).not.toHaveBeenCalled();
});

it('does not publish a zero native allocation and still releases the bitmap/canvas', async () => {
  const h = harness({ pointerBytes: 8 }); h.core.alloc.mockReturnValue(0n);
  await expect(writeImageInputs({ core: h.core, params: 8n, inputs: { ...emptyImageInputs(), initImage: file }, keep: h.keep, checkCancelled() {}, onDecoded() {} })).rejects.toThrow('allocate input');
  expect(h.owned).toEqual([]); expect(h.core.setField).not.toHaveBeenCalled(); expect(h.bitmap.close).toHaveBeenCalledOnce();
  expect(h.canvases[0]).toMatchObject({ width: 0, height: 0 });
});
