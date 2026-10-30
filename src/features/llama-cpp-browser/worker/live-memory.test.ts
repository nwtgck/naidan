import { describe, expect, it, vi } from 'vitest';
import { captureLiveCheckpoint, restoreLiveCheckpoint, freeLiveCheckpoint } from './live-memory';

function fixture() {
  let maximum = 3;
  const api = {
    llama_memory_seq_pos_max: vi.fn(async () => maximum),
    llama_memory_clear: vi.fn(async () => {
      maximum = -1;
    }),
    llama_state_seq_get_size: vi.fn(async () => 32n),
    llama_state_seq_get_data: vi.fn(async () => 32n),
    llama_state_seq_set_data: vi.fn(async () => {
      maximum = 3;
      return 32n;
    }),
  };
  const core = { api, alloc: vi.fn(() => 100n), bytes: vi.fn(() => new Uint8Array(32)), free: vi.fn() };
  const native = { core, context: 2n, memory: 3n, position: 4 };
  return { core, api, native };
}

describe('live full recurrent-state checkpoints', () => {
  it('uses full state and clears the intervening conversation before restoring', async () => {
    const { native, core, api } = fixture();
    const checkpoint = await captureLiveCheckpoint({ native });
    using resource = {
      [Symbol.dispose]() {
        freeLiveCheckpoint({ native, checkpoint });
      },
    };
    expect(api.llama_state_seq_get_data).toHaveBeenCalledWith(2n, 100n, 32n, 0);
    native.position = 21;
    await restoreLiveCheckpoint({ native, checkpoint });
    expect(native.position).toBe(4);
    expect(api.llama_memory_clear.mock.invocationCallOrder[0]).toBeLessThan(api.llama_state_seq_set_data.mock.invocationCallOrder[0]!);
    expect(core.free).not.toHaveBeenCalled();
    void resource;
  });

  it('restores an initially empty session without allocating a snapshot', async () => {
    const { native, core, api } = fixture();
    native.position = 0;
    const checkpoint = await captureLiveCheckpoint({ native });
    expect(core.alloc).not.toHaveBeenCalled();
    await restoreLiveCheckpoint({ native, checkpoint });
    expect(native.position).toBe(0);
    expect(api.llama_state_seq_set_data).not.toHaveBeenCalled();
  });

  it.each([0n, -1n, 512n * 1024n * 1024n + 1n])('rejects an unsafe checkpoint size %s before allocation', async bytes => {
    const { native, core, api } = fixture();
    api.llama_state_seq_get_size.mockResolvedValue(bytes);
    await expect(captureLiveCheckpoint({ native })).rejects.toThrow('limit');
    expect(core.alloc).not.toHaveBeenCalled();
  });

  it('frees a failed snapshot write', async () => {
    const { native, core, api } = fixture();
    api.llama_state_seq_get_data.mockResolvedValue(31n);
    await expect(captureLiveCheckpoint({ native })).rejects.toThrow('Incomplete');
    expect(core.free).toHaveBeenCalledExactlyOnceWith({ pointer: 100n });
  });

  it('fails closed when restored recurrent positions disagree', async () => {
    const { native, api } = fixture();
    const checkpoint = { pointer: 100n, bytes: 32n, position: 8 };
    await expect(restoreLiveCheckpoint({ native, checkpoint })).rejects.toThrow('position');
    expect(api.llama_memory_clear).toHaveBeenCalledOnce();
  });
});
