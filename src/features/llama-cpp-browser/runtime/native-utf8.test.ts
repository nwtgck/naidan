import { describe, expect, it, vi } from 'vitest';
import { copyNativeUtf8 } from './native-utf8';

function fixture() {
  let heap: Uint8Array = new Uint8Array(128).fill(0xaa);
  const pointer = 16n;
  const alloc = vi.fn(({ bytes: _bytes }: { bytes: number | bigint }) => pointer);
  const free = vi.fn((_args: { pointer: bigint }) => {});
  const bytes = vi.fn(({ pointer, length }: { pointer: bigint, length: number | bigint }) => {
    const start = Number(pointer); const size = Number(length);
    if (start + size > heap.length) throw new RangeError('fixture bounds');
    return heap.subarray(start, start + size);
  });
  return {
    core: { alloc, bytes, free },
    pointer,
    replaceHeap({ next }: { next: Uint8Array }): void {
      heap = next;
    },
    heap: () => heap,
  };
}

describe('owned encoded native text', () => {
  it.each(['', 'ascii', '日本語', '😀', '\ud800', '\udc00', 'a\0b', 'e\u0301'])('copies exact encoding and a separate terminator for %j', text => {
    const { core, pointer, heap } = fixture(); const data = new TextEncoder().encode(text);
    const before = data.slice();
    expect(copyNativeUtf8({ core, data })).toBe(pointer);
    expect(core.alloc).toHaveBeenCalledExactlyOnceWith({ bytes: data.length + 1 });
    expect(heap().slice(Number(pointer), Number(pointer) + data.length + 1)).toEqual(Uint8Array.from([...data, 0]));
    expect(heap()[Number(pointer) - 1]).toBe(0xaa);
    expect(heap()[Number(pointer) + data.length + 1]).toBe(0xaa);
    expect(data).toEqual(before); expect(core.free).not.toHaveBeenCalled();
  });

  it('copies only the requested view, with independent native ownership', () => {
    const { core, heap } = fixture(); const data = new Uint8Array([99, 65, 66, 88]);
    copyNativeUtf8({ core, data: data.subarray(1, 3) }); data.fill(17);
    expect(heap().slice(16, 19)).toEqual(new Uint8Array([65, 66, 0]));
  });

  it('reads the destination heap only after allocation has replaced it', () => {
    const { core, pointer, heap, replaceHeap } = fixture(); const previous = heap();
    core.alloc.mockImplementationOnce(() => {
      replaceHeap({ next: new Uint8Array(256) }); return pointer;
    });
    copyNativeUtf8({ core, data: new Uint8Array([1, 2, 3]) });
    expect(heap().slice(16, 20)).toEqual(new Uint8Array([1, 2, 3, 0]));
    expect(previous[16]).toBe(0xaa);
  });

  it('releases the native allocation when the destination is invalid', () => {
    const { core, pointer } = fixture(); const error = new RangeError('fixture invalid span');
    core.bytes.mockImplementationOnce(() => {
      throw error;
    });
    expect(() => copyNativeUtf8({ core, data: new Uint8Array([1]) })).toThrow(error);
    expect(core.free).toHaveBeenCalledExactlyOnceWith({ pointer });
  });

  it('releases the native allocation when copying fails', () => {
    const { core, pointer } = fixture(); const error = new Error('fixture copy failure');
    const destination = new Uint8Array(2); vi.spyOn(destination, 'set').mockImplementationOnce(() => {
      throw error;
    });
    core.bytes.mockReturnValueOnce(destination);
    expect(() => copyNativeUtf8({ core, data: new Uint8Array([1]) })).toThrow(error);
    expect(core.free).toHaveBeenCalledExactlyOnceWith({ pointer });
  });

  it('does not free an allocation which never succeeded', () => {
    const { core } = fixture(); const trap = new WebAssembly.RuntimeError('fixture malloc trap');
    core.alloc.mockImplementationOnce(() => {
      throw trap;
    });
    expect(() => copyNativeUtf8({ core, data: new Uint8Array(1) })).toThrow(trap);
    expect(core.free).not.toHaveBeenCalled(); expect(core.bytes).not.toHaveBeenCalled();
  });
});
