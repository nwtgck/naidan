import { describe, expect, it, vi } from 'vitest';
import type { Core } from '@/features/llama-cpp-browser/runtime/core';
import { tokenizeChatText } from './native-chat';

function fixture() {
  let next = 100n;
  const allocations = new Map<bigint, Uint8Array>();
  const alloc = ({ bytes }: { bytes: number | bigint }): bigint => {
    const pointer = next++;
    allocations.set(pointer, new Uint8Array(Number(bytes)));
    return pointer;
  };
  const tryAlloc = vi.fn(({ bytes }: { bytes: number | bigint }): bigint | undefined => alloc({ bytes }));
  const free = vi.fn(({ pointer }: { pointer: bigint }) => {
    if (!allocations.delete(pointer)) throw new Error('unowned free');
  });
  const bytes = vi.fn(({ pointer, length }: { pointer: bigint, length: number | bigint }) => {
    const allocation = allocations.get(pointer);
    if (!allocation || Number(length) > allocation.length) throw new RangeError('out of bounds');
    return allocation.subarray(0, Number(length));
  });
  const utf8 = vi.fn(({ text }: { text: string }) => {
    const encoded = new TextEncoder().encode(text); const pointer = alloc({ bytes: encoded.length + 1 });
    allocations.get(pointer)!.set(encoded); return pointer;
  });
  const llama_tokenize = vi.fn(async (_vocab: bigint, _text: bigint, _length: number, pointer: bigint, capacity: number): Promise<number> => {
    if (capacity < 3) return -3;
    const view = new DataView(allocations.get(pointer)!.buffer);
    [11, 22, 33].forEach((token, index) => view.setInt32(index * 4, token, true));
    return 3;
  });
  const core = { utf8, alloc, tryAlloc, free, bytes, api: { llama_tokenize } } as unknown as Core;
  return { core, allocations, tryAlloc, free, bytes, llama_tokenize };
}

describe('chat text tokenization', () => {
  it('uses one native call when the byte-sized speculative buffer is sufficient', async () => {
    const { core, allocations, llama_tokenize } = fixture();
    await expect(tokenizeChatText({ core, vocab: 1n, text: 'abcdefgh' })).resolves.toEqual([11, 22, 33]);
    expect(llama_tokenize).toHaveBeenCalledTimes(1);
    expect(llama_tokenize.mock.calls[0]?.slice(3, 5)).toEqual([101n, 8]);
    expect(allocations.size).toBe(0);
  });

  it('resizes from a too-small speculative buffer without a separate size probe', async () => {
    const { core, allocations, llama_tokenize, free } = fixture();
    llama_tokenize.mockResolvedValueOnce(-12).mockImplementationOnce(async (_vocab, _text, _length, pointer, capacity) => {
      expect(capacity).toBe(12);
      const view = new DataView((allocations.get(pointer)!).buffer);
      for (let index = 0; index < 12; index++) view.setInt32(index * 4, index, true);
      return 12;
    });
    await expect(tokenizeChatText({ core, vocab: 1n, text: 'x' })).resolves.toEqual(Array.from({ length: 12 }, (_, index) => index));
    expect(llama_tokenize).toHaveBeenCalledTimes(2);
    expect(free).toHaveBeenCalledTimes(3); // text, first token buffer, resized token buffer
    expect(allocations.size).toBe(0);
  });

  it('falls back to the size-query path only if speculative allocation fails', async () => {
    const { core, allocations, tryAlloc, llama_tokenize } = fixture();
    tryAlloc.mockReturnValueOnce(undefined);
    llama_tokenize.mockResolvedValueOnce(-3);
    await expect(tokenizeChatText({ core, vocab: 1n, text: 'abc' })).resolves.toEqual([11, 22, 33]);
    expect(llama_tokenize.mock.calls.map(call => call.slice(3, 5))).toEqual([[0n, 0], [101n, 3]]);
    expect(allocations.size).toBe(0);
  });

  it('releases both buffers after a native rejection settles', async () => {
    const { core, allocations, llama_tokenize, free } = fixture();
    const pending = Promise.withResolvers<number>();
    llama_tokenize.mockReturnValueOnce(pending.promise);
    const result = tokenizeChatText({ core, vocab: 1n, text: 'abcd' });
    expect(free).not.toHaveBeenCalled();
    pending.reject(new WebAssembly.RuntimeError('trap'));
    await expect(result).rejects.toThrow('trap');
    expect(allocations.size).toBe(0);
  });

  it('frees the encoded text if the first token buffer allocation traps', async () => {
    const { core, allocations, tryAlloc, free, llama_tokenize } = fixture();
    const error = new WebAssembly.RuntimeError('first token allocation trap');
    tryAlloc.mockImplementationOnce(() => {
      throw error;
    });
    await expect(tokenizeChatText({ core, vocab: 1n, text: 'owned text' })).rejects.toThrow(error);
    expect(allocations.size).toBe(0); expect(free).toHaveBeenCalledExactlyOnceWith({ pointer: 100n });
    expect(llama_tokenize).not.toHaveBeenCalled();
  });

  it('frees the text and first buffer if the resized token allocation traps', async () => {
    const { core, allocations, tryAlloc, llama_tokenize } = fixture();
    const original = tryAlloc.getMockImplementation()!;
    tryAlloc.mockImplementationOnce(original).mockImplementationOnce(() => {
      throw new WebAssembly.RuntimeError('resized trap');
    });
    llama_tokenize.mockResolvedValueOnce(-12);
    await expect(tokenizeChatText({ core, vocab: 1n, text: 'x' })).rejects.toThrow('resized trap');
    expect(allocations.size).toBe(0); expect(llama_tokenize).toHaveBeenCalledOnce();
  });

  it('frees the text even when releasing the token buffer reports failure', async () => {
    const { core, allocations, free } = fixture(); const original = free.getMockImplementation()!;
    free.mockImplementationOnce(args => {
      original(args); throw new Error('token free failure');
    });
    await expect(tokenizeChatText({ core, vocab: 1n, text: 'text' })).rejects.toThrow('token free failure');
    expect(allocations.size).toBe(0); expect(free).toHaveBeenLastCalledWith({ pointer: 100n });
  });

  it.each(['日本語😀', 'a\0b', '\ud800'])('encodes helper text only once with the exact native byte length: %j', async text => {
    const { core, allocations, llama_tokenize } = fixture();
    const expected = new TextEncoder().encode(text); const original = llama_tokenize.getMockImplementation()!;
    llama_tokenize.mockImplementation(async (...args) => {
      expect(args[2]).toBe(expected.length);
      expect(allocations.get(args[1])!).toEqual(Uint8Array.from([...expected, 0]));
      return original(...args);
    });
    const encode = vi.spyOn(TextEncoder.prototype, 'encode');
    try {
      await tokenizeChatText({ core, vocab: 1n, text });
      expect(encode.mock.calls.filter(([value]) => value === text)).toHaveLength(1);
      expect(allocations.size).toBe(0);
    } finally {
      encode.mockRestore();
    }
  });

  it('does not retry freeing the old token buffer when resizing cleanup throws', async () => {
    const { core, allocations, free, tryAlloc, llama_tokenize } = fixture();
    llama_tokenize.mockResolvedValueOnce(-12); const original = free.getMockImplementation()!;
    free.mockImplementationOnce(args => {
      original(args); throw new Error('resize free failure');
    });
    await expect(tokenizeChatText({ core, vocab: 1n, text: 'x' })).rejects.toThrow('resize free failure');
    expect(free.mock.calls).toEqual([[{ pointer: 101n }], [{ pointer: 100n }]]);
    expect(tryAlloc).toHaveBeenCalledOnce(); expect(llama_tokenize).toHaveBeenCalledOnce(); expect(allocations.size).toBe(0);
  });
});

describe('chat tokenization allocation failures', () => {
  it('releases the acquired text when the first speculative allocation throws', async () => {
    const { core, allocations, tryAlloc, llama_tokenize } = fixture();
    const failure = new WebAssembly.RuntimeError('allocation trap');
    tryAlloc.mockImplementationOnce(() => {
      throw failure;
    });
    await expect(tokenizeChatText({ core, vocab: 1n, text: 'prefix' })).rejects.toBe(failure);
    expect(llama_tokenize).not.toHaveBeenCalled();
    expect(allocations.size).toBe(0);
  });

  it('does not free the old token buffer twice when releasing it throws', async () => {
    const { core, allocations, free, llama_tokenize } = fixture();
    const failure = new WebAssembly.RuntimeError('free trap');
    llama_tokenize.mockResolvedValueOnce(-12);
    free.mockImplementationOnce(({ pointer }) => {
      allocations.delete(pointer); throw failure;
    });
    await expect(tokenizeChatText({ core, vocab: 1n, text: 'x' })).rejects.toBe(failure);
    expect(free.mock.calls.map(([{ pointer }]) => pointer)).toEqual([101n, 100n]);
    expect(allocations.size).toBe(0);
  });

  it('still releases the text when the final token-buffer free throws', async () => {
    const { core, allocations, free } = fixture();
    const failure = new WebAssembly.RuntimeError('free trap');
    free.mockImplementationOnce(({ pointer }) => {
      allocations.delete(pointer); throw failure;
    });
    await expect(tokenizeChatText({ core, vocab: 1n, text: 'prefix' })).rejects.toBe(failure);
    expect(free.mock.calls.map(([{ pointer }]) => pointer)).toEqual([101n, 100n]);
    expect(allocations.size).toBe(0);
  });
});
