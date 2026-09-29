import { describe, expect, it, vi } from 'vitest';
import { probeNewContextSequenceRemoval } from './cache-capabilities';

function fixture() {
  let pointer = 100n;
  const allocations = new Set<bigint>();
  const temporaryTokens = new Uint8Array(8).fill(255);
  const api = {
    llama_get_memory: vi.fn(async () => 10n),
    llama_memory_clear: vi.fn(async () => {}),
    llama_batch_get_one: vi.fn(async () => {}),
    llama_decode: vi.fn(async () => 0),
    llama_n_rs_seq: vi.fn(async () => 0),
    llama_memory_seq_rm: vi.fn(async () => 1),
    llama_synchronize: vi.fn(async () => {}),
  };
  const allocate = () => {
    const result = ++pointer; allocations.add(result); return result;
  };
  const core = {
    api, alloc: allocate, allocRecord: allocate,
    bytes: () => temporaryTokens,
    free: ({ pointer }: { pointer: bigint }) => {
      allocations.delete(pointer);
    },
  };
  return { core, api, allocations, temporaryTokens };
}

describe('new-context native sequence removal probe', () => {
  it.each([
    { rollback: 0, removal: 1, expected: 'partial' },
    { rollback: 0, removal: 0, expected: 'full-only' },
    { rollback: 4, removal: 0, expected: 'bounded' },
  ] as const)('classifies native behavior as $expected and discards probe state', async ({ rollback, removal, expected }) => {
    const { core, api, allocations, temporaryTokens } = fixture();
    api.llama_n_rs_seq.mockResolvedValue(rollback);
    api.llama_memory_seq_rm.mockResolvedValue(removal);
    await expect(probeNewContextSequenceRemoval({ core, context: 20n })).resolves.toBe(expected);
    expect(Array.from(temporaryTokens)).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    expect(api.llama_batch_get_one).toHaveBeenCalledExactlyOnceWith(102n, 101n, 2);
    expect(api.llama_decode).toHaveBeenCalledExactlyOnceWith(20n, 102n);
    if (rollback > 0) expect(api.llama_memory_seq_rm).not.toHaveBeenCalled();
    else expect(api.llama_memory_seq_rm).toHaveBeenCalledExactlyOnceWith(10n, 0, 1, -1);
    expect(api.llama_memory_clear).toHaveBeenCalledTimes(2);
    expect(api.llama_memory_clear).toHaveBeenLastCalledWith(10n, 1);
    expect(api.llama_synchronize).toHaveBeenCalledExactlyOnceWith(20n);
    expect(allocations.size).toBe(0);
  });
  it('does not probe a context without native memory', async () => {
    const { core, api, allocations } = fixture();
    api.llama_get_memory.mockResolvedValue(0n);
    await expect(probeNewContextSequenceRemoval({ core, context: 20n })).resolves.toBe('none');
    expect(api.llama_decode).not.toHaveBeenCalled();
    expect(api.llama_memory_clear).not.toHaveBeenCalled();
    expect(allocations.size).toBe(0);
  });
  it('disables advanced reuse after a declined probe without rejecting ordinary generation', async () => {
    const { core, api, allocations } = fixture();
    api.llama_decode.mockResolvedValue(2);
    await expect(probeNewContextSequenceRemoval({ core, context: 20n })).resolves.toBe('none');
    expect(api.llama_memory_seq_rm).not.toHaveBeenCalled();
    expect(api.llama_memory_clear).toHaveBeenCalledTimes(2);
    expect(api.llama_synchronize).toHaveBeenCalledOnce();
    expect(allocations.size).toBe(0);
  });
  it.each(['decode-trap', 'removal-exception'] as const)('fails explicitly and releases temporary state after %s', async failure => {
    const { core, api, allocations } = fixture();
    switch (failure) {
    case 'decode-trap': api.llama_decode.mockRejectedValue(new WebAssembly.RuntimeError('fixture trap')); break;
    case 'removal-exception': api.llama_memory_seq_rm.mockRejectedValue(new Error('fixture removal failure')); break;
    default: { const exhaustive: never = failure; throw new Error(`Unknown probe failure: ${exhaustive}`); }
    }
    await expect(probeNewContextSequenceRemoval({ core, context: 20n })).rejects.toThrow();
    expect(api.llama_memory_clear).toHaveBeenCalledTimes(2);
    expect(api.llama_synchronize).toHaveBeenCalledOnce();
    expect(allocations.size).toBe(0);
  });
});
