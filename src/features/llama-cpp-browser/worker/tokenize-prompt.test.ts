import { describe, expect, it, vi } from 'vitest';
import { tokenizePrompt } from './tokenize-prompt';

function fixture() {
  let nextPointer = 100n;
  const allocations = new Map<bigint, Uint8Array>();
  const core = {
    tryAlloc: vi.fn(({ bytes }: { bytes: number | bigint }): bigint | undefined => {
      const pointer = nextPointer++;
      allocations.set(pointer, new Uint8Array(Number(bytes)));
      return pointer;
    }),
    free: vi.fn(({ pointer }: { pointer: bigint }) => {
      if (!allocations.delete(pointer)) throw new Error('Double or unowned free');
    }),
    bytes: vi.fn(({ pointer, length }: { pointer: bigint, length: number | bigint }) => {
      const bytes = allocations.get(pointer);
      if (!bytes || Number(length) > bytes.length) throw new RangeError('Out of bounds');
      return bytes.subarray(0, Number(length));
    }),
    api: {
      llama_tokenize: vi.fn(async (_vocab: bigint, _text: bigint, _length: number, pointer: bigint, capacity: number, _addSpecial: number, _parseSpecial: number): Promise<number> => {
        if (capacity < 3) return -3;
        const bytes = allocations.get(pointer)!;
        const view = new DataView(bytes.buffer);
        [1, 200, 999].forEach((token, index) => view.setInt32(index * 4, token, true));
        return 3;
      }),
    },
  };
  const onTokenize = vi.fn();
  const run = ({ contextTokens }: { contextTokens: number }) => tokenizePrompt({ core, vocab: 1n, prompt: 2n, promptBytes: 8, contextTokens, onTokenize });
  return { core, allocations, onTokenize, run };
}

describe('bounded single-pass prompt tokenization', () => {
  it('tokenizes once without a length probe and transfers an owned buffer', async () => {
    const { core, allocations, onTokenize, run } = fixture();
    const result = await run({ contextTokens: 32 });
    expect(result).toEqual({ pointer: 100n, tokens: [1, 200, 999] });
    expect(core.tryAlloc).toHaveBeenCalledExactlyOnceWith({ bytes: 16 * 4 });
    expect(core.api.llama_tokenize).toHaveBeenCalledExactlyOnceWith(1n, 2n, 8, 100n, 16, 1, 1);
    expect(onTokenize).toHaveBeenCalledOnce();
    expect(core.free).not.toHaveBeenCalled();
    core.free({ pointer: result.pointer });
    expect(allocations.size).toBe(0);
  });
  it('caps the speculative allocation independently of a huge context', async () => {
    const { core, onTokenize } = fixture();
    const result = await tokenizePrompt({ core, vocab: 1n, prompt: 2n, promptBytes: 1000000, contextTokens: 2147483647, onTokenize });
    expect(core.tryAlloc).toHaveBeenCalledExactlyOnceWith({ bytes: 262144 });
    core.free({ pointer: result.pointer });
  });
  it('resizes once using the native required count, freeing the old buffer first', async () => {
    const { core, allocations, onTokenize, run } = fixture();
    core.api.llama_tokenize.mockResolvedValueOnce(-65537).mockResolvedValueOnce(65537);
    const result = await run({ contextTokens: 100000 });
    expect(result.tokens).toHaveLength(65537);
    expect(core.tryAlloc.mock.calls).toEqual([[{ bytes: 16 * 4 }], [{ bytes: 65537 * 4 }]]);
    expect(core.free.mock.invocationCallOrder[0]).toBeLessThan(core.tryAlloc.mock.invocationCallOrder[1]!);
    expect(onTokenize).toHaveBeenCalledTimes(2);
    expect(allocations.size).toBe(1);
    core.free({ pointer: result.pointer });
  });
  it('uses a length probe only when speculative allocation fails', async () => {
    const { core, run } = fixture();
    core.tryAlloc.mockReturnValueOnce(undefined);
    const result = await run({ contextTokens: 32 });
    expect(core.api.llama_tokenize.mock.calls.map(call => [call[3], call[4]])).toEqual([[0n, 0], [100n, 3]]);
    expect(result.tokens).toEqual([1, 200, 999]);
    core.free({ pointer: result.pointer });
  });
  it.each([0, -32, -2147483648, 32])('rejects empty or oversized native count %s and releases storage', async count => {
    const { core, allocations, run } = fixture();
    core.api.llama_tokenize.mockResolvedValue(count);
    await expect(run({ contextTokens: 32 })).rejects.toThrow('context-full');
    expect(core.api.llama_tokenize).toHaveBeenCalledOnce();
    expect(core.free).toHaveBeenCalledOnce();
    expect(allocations.size).toBe(0);
  });
  it.each([NaN, Infinity, 1.5, -2147483649, -3])('rejects malformed native result %s', async count => {
    const { core, allocations, run } = fixture();
    core.api.llama_tokenize.mockResolvedValue(count);
    await expect(run({ contextTokens: 32 })).rejects.toThrow('runtime-error');
    expect(allocations.size).toBe(0);
  });
  it('does not read past the speculative buffer on an invalid positive result', async () => {
    const { core, allocations, run } = fixture();
    core.api.llama_tokenize.mockResolvedValue(65537);
    await expect(run({ contextTokens: 100000 })).rejects.toThrow('runtime-error');
    expect(allocations.size).toBe(0);
  });
  it.each([1, 0, -65537, 65536])('rejects a changed retry result %s', async second => {
    const { core, allocations, run } = fixture();
    core.api.llama_tokenize.mockResolvedValueOnce(-65537).mockResolvedValueOnce(second);
    await expect(run({ contextTokens: 100000 })).rejects.toThrow();
    expect(core.api.llama_tokenize).toHaveBeenCalledTimes(2);
    expect(allocations.size).toBe(0);
  });
  it('does not call native code after both allocations fail', async () => {
    const { core, run } = fixture();
    core.tryAlloc.mockReturnValue(undefined);
    await expect(run({ contextTokens: 32 })).rejects.toThrow('runtime-error');
    expect(core.api.llama_tokenize).toHaveBeenCalledOnce();
    expect(core.free).not.toHaveBeenCalled();
  });
  it('does not double-free when a resizing allocation throws', async () => {
    const { core, allocations, run } = fixture();
    const allocate = core.tryAlloc.getMockImplementation()!;
    core.tryAlloc.mockImplementationOnce(allocate).mockImplementationOnce(() => {
      throw new RangeError('allocation');
    });
    core.api.llama_tokenize.mockResolvedValueOnce(-65537);
    await expect(run({ contextTokens: 100000 })).rejects.toThrow('allocation');
    expect(core.free).toHaveBeenCalledOnce();
    expect(allocations.size).toBe(0);
  });
  it('waits for native rejection before freeing its writable buffer', async () => {
    const { core, allocations, run } = fixture();
    const native = Promise.withResolvers<number>();
    core.api.llama_tokenize.mockReturnValueOnce(native.promise);
    const pending = run({ contextTokens: 32 });
    const rejected = expect(pending).rejects.toThrow('trap');
    expect(core.free).not.toHaveBeenCalled();
    native.reject(new WebAssembly.RuntimeError('trap'));
    await rejected;
    expect(allocations.size).toBe(0);
    expect(core.free).toHaveBeenCalledOnce();
  });
  it('reacquires the heap view after native memory growth', async () => {
    const { core, allocations, run } = fixture();
    core.api.llama_tokenize.mockImplementationOnce(async (_vocab, _text, _length, pointer) => {
      const changed = new Uint8Array(124);
      new DataView(changed.buffer).setInt32(0, 12345, true);
      allocations.set(pointer, changed);
      return 1;
    });
    const result = await run({ contextTokens: 32 });
    expect(result.tokens).toEqual([12345]);
    core.free({ pointer: result.pointer });
  });
  it.each([0, 1, -1, NaN, Infinity, 2.5, 2147483648])('rejects unsafe context size %s before allocation', async contextTokens => {
    const { core, run } = fixture();
    await expect(run({ contextTokens })).rejects.toThrow('runtime-error');
    expect(core.tryAlloc).not.toHaveBeenCalled();
    expect(core.api.llama_tokenize).not.toHaveBeenCalled();
  });
  it('does not retry freeing the old prompt buffer when resizing cleanup throws', async () => {
    const { core, allocations, run } = fixture(); const original = core.free.getMockImplementation()!;
    core.api.llama_tokenize.mockResolvedValueOnce(-65537);
    core.free.mockImplementationOnce(args => {
      original(args); throw new Error('resize free failure');
    });
    await expect(run({ contextTokens: 100000 })).rejects.toThrow('resize free failure');
    expect(core.free).toHaveBeenCalledExactlyOnceWith({ pointer: 100n });
    expect(core.tryAlloc).toHaveBeenCalledOnce(); expect(core.api.llama_tokenize).toHaveBeenCalledOnce(); expect(allocations.size).toBe(0);
  });

});


describe('prompt-sized speculation and deallocation failures', () => {
  it('does not allocate a context-sized buffer for a short prompt', async () => {
    const { core, run } = fixture();
    const result = await run({ contextTokens: 32768 });
    expect(core.tryAlloc).toHaveBeenCalledExactlyOnceWith({ bytes: 64 });
    expect(core.api.llama_tokenize).toHaveBeenCalledOnce();
    core.free({ pointer: result.pointer });
  });
  it('retries from the native count when special tokens exceed the hint', async () => {
    const { core, onTokenize } = fixture();
    core.api.llama_tokenize.mockResolvedValueOnce(-17).mockResolvedValueOnce(17);
    const result = await tokenizePrompt({ core, vocab: 1n, prompt: 2n, promptBytes: 0, contextTokens: 32, onTokenize });
    expect(core.tryAlloc.mock.calls).toEqual([[{ bytes: 8 * 4 }], [{ bytes: 17 * 4 }]]);
    expect(result.tokens).toHaveLength(17);
    core.free({ pointer: result.pointer });
  });
  it('never retries a throwing deallocator during resizing', async () => {
    const { core, allocations, run } = fixture();
    const failure = new WebAssembly.RuntimeError('free trap');
    core.api.llama_tokenize.mockResolvedValueOnce(-17);
    core.free.mockImplementationOnce(({ pointer }) => {
      allocations.delete(pointer); throw failure;
    });
    await expect(run({ contextTokens: 32 })).rejects.toBe(failure);
    expect(core.free).toHaveBeenCalledOnce();
    expect(core.tryAlloc).toHaveBeenCalledOnce();
    expect(allocations.size).toBe(0);
  });
});
