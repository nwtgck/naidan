import { describe, expect, it, vi } from 'vitest';
import { capturePromptCheckpoint, disposePromptCheckpoint, promptCheckpointBoundary, restorePromptCheckpoint } from './prompt-checkpoint';

function fixture() {
  const storage = new Uint8Array(128);
  const api = {
    llama_get_memory: vi.fn(async () => 10n),
    llama_memory_seq_pos_min: vi.fn(async () => 2),
    llama_memory_seq_pos_max: vi.fn(async () => 3),
    llama_state_seq_get_size_ext: vi.fn(async () => 64n),
    llama_state_seq_get_data_ext: vi.fn(async () => 64n),
    llama_state_seq_set_data_ext: vi.fn(async () => 64n),
    llama_memory_seq_rm: vi.fn(async () => 1),
    llama_tokenize: vi.fn(async () => 3),
  };
  const core = {
    api,
    pointerBytes: 4 as const,
    tryAlloc: vi.fn((): bigint | undefined => 100n),
    bytes: vi.fn(() => storage),
    free: vi.fn(),
  };
  return { core, api, storage };
}

describe('owned host prompt checkpoints', () => {
  it('owns one host buffer until explicit disposal and preserves the captured native window', async () => {
    const { core, api } = fixture();
    const tokens = [1, 2, 3, 4];
    const checkpoint = await capturePromptCheckpoint({ core, context: 20n, tokens });
    expect(checkpoint).toEqual({ pointer: 100n, bytes: 64, tokens, positionMin: 2, positionMax: 3 });
    expect(api.llama_state_seq_get_data_ext).toHaveBeenCalledExactlyOnceWith(20n, 100n, 64n, 0, 1);
    expect(core.free).not.toHaveBeenCalled();
    tokens.push(5);
    if (!checkpoint) throw new Error('Expected a checkpoint');
    expect(checkpoint.tokens).toEqual([1, 2, 3, 4]);
    await expect(restorePromptCheckpoint({ core, context: 20n, checkpoint })).resolves.toBe(true);
    expect(api.llama_state_seq_set_data_ext).toHaveBeenCalledExactlyOnceWith(20n, 100n, 64n, 0, 1);
    expect(api.llama_memory_seq_rm).toHaveBeenCalledExactlyOnceWith(10n, 0, 4, -1);
    expect(api.llama_state_seq_set_data_ext.mock.invocationCallOrder[0]).toBeLessThan(api.llama_memory_seq_rm.mock.invocationCallOrder[0]!);
    disposePromptCheckpoint({ core, checkpoint });
    expect(core.free).toHaveBeenCalledExactlyOnceWith({ pointer: 100n });
  });
  it.each([0n, -1n, 1n << 32n, BigInt(Number.MAX_SAFE_INTEGER) + 1n])('declines an unsafe snapshot size %s before allocating', async size => {
    const { core, api } = fixture();
    api.llama_state_seq_get_size_ext.mockResolvedValue(size);
    await expect(capturePromptCheckpoint({ core, context: 20n, tokens: [1, 2, 3, 4] })).resolves.toBeUndefined();
    expect(core.tryAlloc).not.toHaveBeenCalled(); expect(api.llama_state_seq_get_data_ext).not.toHaveBeenCalled();
  });
  it('declines a null allocation without calling the native writer', async () => {
    const { core, api } = fixture(); core.tryAlloc.mockReturnValue(undefined);
    await expect(capturePromptCheckpoint({ core, context: 20n, tokens: [1, 2, 3, 4] })).resolves.toBeUndefined();
    expect(api.llama_state_seq_get_data_ext).not.toHaveBeenCalled(); expect(core.free).not.toHaveBeenCalled();
  });
  it.each(['short-write', 'write-trap', 'invalid-range'] as const)('frees an unpublished buffer after %s', async failure => {
    const { core, api } = fixture();
    switch (failure) {
    case 'short-write': api.llama_state_seq_get_data_ext.mockResolvedValue(63n); break;
    case 'write-trap': api.llama_state_seq_get_data_ext.mockRejectedValue(new WebAssembly.RuntimeError('fixture trap')); break;
    case 'invalid-range': core.bytes.mockImplementation(() => {
      throw new RangeError('fixture range');
    }); break;
    default: { const exhaustive: never = failure; throw new Error(`Unknown failure: ${exhaustive}`); }
    }
    const pending = capturePromptCheckpoint({ core, context: 20n, tokens: [1, 2, 3, 4] });
    if (failure === 'short-write') await expect(pending).resolves.toBeUndefined();
    else await expect(pending).rejects.toThrow();
    expect(core.free).toHaveBeenCalledExactlyOnceWith({ pointer: 100n });
  });
  it('keeps local ownership until an asynchronous native writer has settled', async () => {
    const { core, api } = fixture();
    const writer = Promise.withResolvers<bigint>();
    api.llama_state_seq_get_data_ext.mockReturnValue(writer.promise);
    const pending = capturePromptCheckpoint({ core, context: 20n, tokens: [1, 2, 3, 4] });
    await vi.waitFor(() => expect(api.llama_state_seq_get_data_ext).toHaveBeenCalledOnce());
    expect(core.free).not.toHaveBeenCalled();
    writer.resolve(64n);
    const checkpoint = await pending;
    expect(core.free).not.toHaveBeenCalled();
    disposePromptCheckpoint({ core, checkpoint });
    expect(core.free).toHaveBeenCalledOnce();
  });
  it.each(['short-read', 'refused-trim', 'lost-window', 'wrong-frontier'] as const)('rejects an unverifiable restored state: %s', async failure => {
    const { core, api } = fixture();
    const checkpoint = await capturePromptCheckpoint({ core, context: 20n, tokens: [1, 2, 3, 4] });
    if (!checkpoint) throw new Error('Expected checkpoint');
    switch (failure) {
    case 'short-read': api.llama_state_seq_set_data_ext.mockResolvedValue(63n); break;
    case 'refused-trim': api.llama_memory_seq_rm.mockResolvedValue(0); break;
    case 'lost-window': api.llama_memory_seq_pos_min.mockResolvedValue(3); break;
    case 'wrong-frontier': api.llama_memory_seq_pos_max.mockResolvedValue(4); break;
    default: { const exhaustive: never = failure; throw new Error(`Unknown failure: ${exhaustive}`); }
    }
    await expect(restorePromptCheckpoint({ core, context: 20n, checkpoint })).resolves.toBe(false);
    disposePromptCheckpoint({ core, checkpoint });
  });
  it.each([
    { suffix: 'GG', tokenized: [1, 2, 3], expected: 3 },
    { suffix: 'GG', tokenized: [1, 2, 99], expected: 2 },
    { suffix: 'GG', tokenized: [99, 2, 3], expected: 4 },
    { suffix: 'different', tokenized: [1, 2, 3], expected: 4 },
    { suffix: '', tokenized: [1, 2, 3], expected: 4 },
  ])('chooses a native token boundary for $suffix and $tokenized', async ({ suffix, tokenized, expected }) => {
    const { core, api, storage } = fixture();
    const view = new DataView(storage.buffer);
    tokenized.forEach((token, index) => view.setInt32(index * 4, token, true));
    expect(await promptCheckpointBoundary({ core, vocab: 30n, prompt: 'abcGG', promptPointer: 40n, generationPrompt: suffix, tokens: [1, 2, 3, 4, 5], onTokenize: () => {} })).toBe(expected);
    if (suffix === 'GG') {
      expect(api.llama_tokenize).toHaveBeenCalledWith(30n, 40n, 3, 100n, 4, 1, 1);
      expect(core.free).toHaveBeenCalledOnce();
    } else expect(api.llama_tokenize).not.toHaveBeenCalled();
  });
  it('does not invent a checkpoint boundary for a one-token prompt', async () => {
    const { core } = fixture();
    expect(await promptCheckpointBoundary({ core, vocab: 30n, prompt: '', promptPointer: 40n, generationPrompt: '', tokens: [1], onTokenize: () => {} })).toBe(0);
    expect(core.tryAlloc).not.toHaveBeenCalled();
  });
  it('uses one native call for an optional generation boundary', async () => {
    const { core, api, storage } = fixture();
    new DataView(storage.buffer).setInt32(0, 1, true);
    api.llama_tokenize.mockResolvedValue(1);
    const onTokenize = vi.fn();
    expect(await promptCheckpointBoundary({
      core,
      vocab: 30n,
      prompt: 'abcGG',
      promptPointer: 40n,
      generationPrompt: 'GG',
      tokens: [1, 2, 3],
      onTokenize,
    })).toBe(1);
    expect(api.llama_tokenize).toHaveBeenCalledExactlyOnceWith(30n, 40n, 3, 100n, 2, 1, 1);
    expect(onTokenize).toHaveBeenCalledOnce();
    expect(core.free).toHaveBeenCalledOnce();
  });
  it.each([0, -2, -2147483648, 4, NaN, 0.5])('falls back safely from optional native count %s', async count => {
    const { core, api } = fixture();
    api.llama_tokenize.mockResolvedValue(count);
    expect(await promptCheckpointBoundary({
      core,
      vocab: 30n,
      prompt: 'abcGG',
      promptPointer: 40n,
      generationPrompt: 'GG',
      tokens: [1, 2, 3],
      onTokenize: () => {},
    })).toBe(2);
    expect(core.tryAlloc).toHaveBeenCalledOnce();
    expect(core.free).toHaveBeenCalledOnce();
  });
  it('does not tokenize an optional boundary when allocation fails', async () => {
    const { core, api } = fixture(); core.tryAlloc.mockReturnValue(undefined);
    expect(await promptCheckpointBoundary({
      core,
      vocab: 30n,
      prompt: 'abcGG',
      promptPointer: 40n,
      generationPrompt: 'GG',
      tokens: [1, 2, 3],
      onTokenize: () => {},
    })).toBe(2);
    expect(api.llama_tokenize).not.toHaveBeenCalled(); expect(core.free).not.toHaveBeenCalled();
  });
  it('keeps the optional buffer owned until native failure has settled', async () => {
    const { core, api } = fixture();
    const native = Promise.withResolvers<number>(); api.llama_tokenize.mockReturnValue(native.promise);
    const pending = promptCheckpointBoundary({
      core,
      vocab: 30n,
      prompt: 'abcGG',
      promptPointer: 40n,
      generationPrompt: 'GG',
      tokens: [1, 2, 3],
      onTokenize: () => {},
    });
    const rejected = expect(pending).rejects.toThrow('native failure');
    expect(core.free).not.toHaveBeenCalled();
    native.reject(new Error('native failure'));
    await rejected;
    expect(core.free).toHaveBeenCalledOnce();
  });
  it('bounds speculation and retries a larger optional prefix exactly once', async () => {
    const { core, api } = fixture();
    const tokens = Array.from({ length: 70000 }, (_, index) => index);
    core.bytes.mockImplementation(() => new Uint8Array(70000 * 4));
    api.llama_tokenize.mockResolvedValueOnce(-66000).mockResolvedValueOnce(66000);
    // The second token differs, so the existing common-prefix proof stops at 1.
    expect(await promptCheckpointBoundary({
      core,
      vocab: 30n,
      prompt: 'abcGG',
      promptPointer: 40n,
      generationPrompt: 'GG',
      tokens,
      onTokenize: () => {},
    })).toBe(1);
    expect(core.tryAlloc.mock.calls).toEqual([[{ bytes: 262144 }], [{ bytes: 264000 }]]);
    expect(api.llama_tokenize).toHaveBeenCalledTimes(2); expect(core.free).toHaveBeenCalledTimes(2);
  });

  it('does not retry freeing the old checkpoint buffer when resizing cleanup throws', async () => {
    const { core, api } = fixture(); const failure = new Error('resize free failure');
    core.bytes.mockImplementation(() => new Uint8Array(262144));
    api.llama_tokenize.mockResolvedValueOnce(-66000);
    core.free.mockImplementationOnce(() => {
      throw failure;
    });
    await expect(promptCheckpointBoundary({
      core,
      vocab: 30n,
      prompt: 'abcGG',
      promptPointer: 40n,
      generationPrompt: 'GG',
      tokens: Array.from({ length: 70000 }, (_, index) => index),
      onTokenize: () => {},
    })).rejects.toBe(failure);
    expect(core.free).toHaveBeenCalledExactlyOnceWith({ pointer: 100n });
    expect(core.tryAlloc).toHaveBeenCalledOnce(); expect(api.llama_tokenize).toHaveBeenCalledOnce();
  });

});


describe('checkpoint boundary deallocation failure', () => {
  it('does not free a discarded speculative pointer twice', async () => {
    const { core, api } = fixture();
    const failure = new WebAssembly.RuntimeError('free trap');
    api.llama_tokenize.mockResolvedValueOnce(-65537);
    core.free.mockImplementationOnce(() => {
      throw failure;
    });
    await expect(promptCheckpointBoundary({
      core,
      vocab: 1n,
      prompt: 'prefix suffix',
      promptPointer: 1n,
      generationPrompt: 'suffix',
      tokens: Array.from({ length: 70000 }, () => 1),
      onTokenize: () => {},
    })).rejects.toBe(failure);
    expect(core.free).toHaveBeenCalledOnce();
    expect(core.tryAlloc).toHaveBeenCalledOnce();
  });
});
