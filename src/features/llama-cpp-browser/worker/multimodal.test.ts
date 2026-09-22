import { afterEach, describe, expect, it, vi } from 'vitest';
import { prepareMultimodal, splitImagePrompt } from './multimodal';
import type { Core } from '@/features/llama-cpp-browser/runtime/core';
import { decodeImage } from '@/features/llama-cpp-browser/runtime/image-input';

vi.mock('../runtime/image-input', () => ({ decodeImage: vi.fn(async () => ({ width: 1, height: 1, rgb: new Uint8Array([10, 20, 30]) })) }));
afterEach(() => vi.clearAllMocks());

function fixture({ pointerBytes }: { pointerBytes: 4 | 8 }) {
  const memory = new Uint8Array(65536); let next = 16; const allocated = new Set<bigint>();
  const records = new Map<bigint, Record<string, number | bigint>>(); const observedParts: string[] = [];
  const allocate = ({ bytes }: { bytes: number }): bigint => {
    const pointer = BigInt(next); next += bytes + 16; allocated.add(pointer); return pointer;
  };
  const tokenPointer = allocate({ bytes: 8 }); new DataView(memory.buffer).setInt32(Number(tokenPointer), 7, true); new DataView(memory.buffer).setInt32(Number(tokenPointer) + 4, 8, true);
  const api = {
    mtmd_bitmap_init: vi.fn(async (_width: number, _height: number, _data: bigint) => allocate({ bytes: 16 })),
    mtmd_bitmap_free: vi.fn(async (pointer: bigint) => {
      allocated.delete(pointer);
    }),
    mtmd_input_chunks_init: vi.fn(async () => allocate({ bytes: 16 })),
    mtmd_input_chunks_free: vi.fn(async (pointer: bigint) => {
      allocated.delete(pointer);
    }),
    mtmd_tokenize_from_parts: vi.fn(async (_projector: bigint, _chunks: bigint, pointers: bigint, count: bigint) => {
      const view = new DataView(memory.buffer);
      for (let index = 0; index < Number(count); index++) {
        const offset = Number(pointers) + index * pointerBytes;
        const pointer = pointerBytes === 8 ? view.getBigUint64(offset, true) : BigInt(view.getUint32(offset, true));
        observedParts.push(records.get(pointer)?.bitmap ? 'image' : 'text');
      }
      return 0;
    }),
    mtmd_input_chunks_size: vi.fn(async () => 1n), mtmd_input_chunks_get: vi.fn(async () => 5000n),
    mtmd_input_chunk_get_type: vi.fn(async () => 0),
    mtmd_helper_get_n_pos: vi.fn(async () => 11), mtmd_helper_get_n_tokens: vi.fn(async () => 40n),
    mtmd_input_chunk_get_tokens_text: vi.fn(async (_chunk: bigint, size: bigint) => {
      const view = new DataView(memory.buffer); if (pointerBytes === 8) view.setBigUint64(Number(size), 2n, true); else view.setUint32(Number(size), 2, true); return tokenPointer;
    }),
    mtmd_helper_eval_chunks: vi.fn(async (_projector: bigint, _context: bigint, _chunks: bigint, _past: number, _sequence: number, _batch: number, _logits: number, output: bigint) => {
      new DataView(memory.buffer).setInt32(Number(output), 13, true); return 0;
    }),
  };
  const core = {
    pointerBytes, api, alloc: allocate,
    allocRecord: ({ name: _name }: { name: string }) => {
      const pointer = allocate({ bytes: 64 }); records.set(pointer, {}); return pointer;
    },
    free: ({ pointer }: { pointer: bigint }) => {
      allocated.delete(pointer);
    },
    bytes: ({ pointer, length }: { pointer: bigint, length: number }) => memory.subarray(Number(pointer), Number(pointer) + length),
    utf8: ({ text }: { text: string }) => {
      const data = new TextEncoder().encode(text); const pointer = allocate({ bytes: data.length + 1 }); memory.set(data, Number(pointer)); return pointer;
    },
    setField: ({ pointer, field, value }: { pointer: bigint, field: string, value: number | bigint }) => {
 records.get(pointer)![field] = value;
    },
    constant: () => 0,
  } as unknown as Core;
  return { core, api, allocated, tokenPointer, observedParts };
}
const blob = new Blob(['image'], { type: 'image/png' });
describe('native multimodal orchestration', () => {
  it.each([4, 8] as const)('uses %i-byte pointer arrays, preserves part order and trusts native next position', async pointerBytes => {
    const host = fixture({ pointerBytes });
    const prepared = await prepareMultimodal({ core: host.core, projector: 1n, prompt: 'before<marker>after', images: [{ marker: '<marker>', blob }] });
    expect(host.observedParts).toEqual(['text', 'image', 'text']);
    expect(prepared.positions).toBe(11); expect(prepared.tokenCount).toBe(40); expect(prepared.textTokens).toEqual([7, 8]);
    expect(await prepared.evaluate({ context: 2n, capacity: 100 })).toBe(13);
    expect(host.api.mtmd_helper_eval_chunks).toHaveBeenCalledWith(1n, 2n, expect.any(BigInt), 0, 0, 128, 1, expect.any(BigInt));
    expect(host.api.mtmd_bitmap_free).toHaveBeenCalledOnce();
    await prepared.dispose(); await prepared.dispose();
    expect(host.api.mtmd_input_chunks_free).toHaveBeenCalledOnce(); expect([...host.allocated]).toEqual([host.tokenPointer]);
  });
  it('frees native parts and bitmaps when preprocessing fails', async () => {
    const host = fixture({ pointerBytes: 8 }); host.api.mtmd_tokenize_from_parts.mockResolvedValue(2);
    await expect(prepareMultimodal({ core: host.core, projector: 1n, prompt: '<marker>after', images: [{ marker: '<marker>', blob }] })).rejects.toThrow('unsupported-input');
    expect([...host.allocated]).toEqual([host.tokenPointer]);
  });
  it('rejects an image-ending prompt without valid text logits', async () => {
    const host = fixture({ pointerBytes: 4 }); host.api.mtmd_input_chunk_get_type.mockResolvedValue(1);
    await expect(prepareMultimodal({ core: host.core, projector: 1n, prompt: '<marker>', images: [{ marker: '<marker>', blob }] })).rejects.toThrow('template-unsupported');
    expect([...host.allocated]).toEqual([host.tokenPointer]);
  });
  it('fails before decoding when no projector is loaded', async () => {
    await expect(prepareMultimodal({ core: fixture({ pointerBytes: 4 }).core, projector: 0n, prompt: '<marker>', images: [{ marker: '<marker>', blob }] })).rejects.toThrow('unsupported-input');
    expect(decodeImage).not.toHaveBeenCalled();
  });
  it('rejects templates that omit, duplicate or reorder image markers', () => {
    for (const prompt of ['none', '<a><a>', '<b><a>']) expect(() => splitImagePrompt({ prompt, images: [{ marker: '<a>', blob }, { marker: '<b>', blob }] })).toThrow('template-unsupported');
  });
  it.each([4, 8] as const)('passes decoder-produced RGB into native bitmap initialization using %i-byte pointers', async pointerBytes => {
    const input = await vi.importActual<typeof import('@/features/llama-cpp-browser/runtime/image-input')>('../runtime/image-input');
    vi.mocked(decodeImage).mockImplementationOnce(input.decodeImage);
    const host = fixture({ pointerBytes });
    const decoder = { decode: vi.fn(async () => ({ width: 1, height: 1, rgba: new Uint8Array([200, 100, 0, 128]) })), dispose: vi.fn() };
    const original = host.api.mtmd_bitmap_init.getMockImplementation()!;
    const observed: number[][] = [];
    host.api.mtmd_bitmap_init.mockImplementationOnce(async (width, height, data) => {
      observed.push([...host.core.bytes({ pointer: data, length: width * height * 3 })]);
      return original(width, height, data);
    });
    const signal = new AbortController().signal;
    const prepared = await prepareMultimodal({ core: host.core, projector: 1n, prompt: '<marker>after', images: [{ marker: '<marker>', blob }], decoder, signal });
    expect(decoder.decode).toHaveBeenCalledWith({ blob, signal });
    expect(observed).toEqual([[227, 177, 127]]);
    expect(decoder.dispose).not.toHaveBeenCalled();
    await prepared.dispose();
    expect([...host.allocated]).toEqual([host.tokenPointer]);
  });

  it('does not allocate an image bitmap when cancellation arrives during decoding', async () => {
    const host = fixture({ pointerBytes: 8 });
    const pending = Promise.withResolvers<Awaited<ReturnType<typeof decodeImage>>>();
    vi.mocked(decodeImage).mockReturnValueOnce(pending.promise);
    const controller = new AbortController();
    const prepared = prepareMultimodal({ core: host.core, projector: 1n, prompt: 'before<marker>after', images: [{ marker: '<marker>', blob }], signal: controller.signal });
    const rejected = expect(prepared).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(decodeImage).toHaveBeenCalledOnce());
    controller.abort();
    pending.resolve({ width: 1, height: 1, rgb: new Uint8Array([10, 20, 30]) });
    await rejected;
    expect(host.api.mtmd_bitmap_init).not.toHaveBeenCalled();
    expect(host.api.mtmd_tokenize_from_parts).not.toHaveBeenCalled();
    expect([...host.allocated]).toEqual([host.tokenPointer]);
  });

  it('owns and frees a native bitmap returned after cancellation during native initialization', async () => {
    const host = fixture({ pointerBytes: 4 });
    const controller = new AbortController();
    const original = host.api.mtmd_bitmap_init.getMockImplementation()!;
    host.api.mtmd_bitmap_init.mockImplementationOnce(async (...args) => {
      const pointer = await original(...args); controller.abort(); return pointer;
    });
    await expect(prepareMultimodal({ core: host.core, projector: 1n, prompt: '<marker>after', images: [{ marker: '<marker>', blob }], signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(host.api.mtmd_bitmap_free).toHaveBeenCalledOnce();
    expect(host.api.mtmd_tokenize_from_parts).not.toHaveBeenCalled();
    expect([...host.allocated]).toEqual([host.tokenPointer]);
  });

  it('does not begin evaluation after cancellation and keeps native chunks disposable', async () => {
    const host = fixture({ pointerBytes: 8 });
    const controller = new AbortController();
    const prepared = await prepareMultimodal({ core: host.core, projector: 1n, prompt: '<marker>after', images: [{ marker: '<marker>', blob }], signal: controller.signal });
    controller.abort();
    await expect(prepared.evaluate({ context: 2n, capacity: 100 })).rejects.toMatchObject({ name: 'AbortError' });
    expect(host.api.mtmd_helper_eval_chunks).not.toHaveBeenCalled();
    await prepared.dispose();
    expect([...host.allocated]).toEqual([host.tokenPointer]);
  });

});
