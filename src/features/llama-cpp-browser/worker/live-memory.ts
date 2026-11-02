import type { Core } from '@/features/llama-cpp-browser/runtime/core';

export type LiveNative = { core: Core, model: bigint, context: bigint, projector: bigint, vocab: bigint, memory: bigint, capacity: number, position: number };
type CheckpointHost = Pick<LiveNative, 'context' | 'memory' | 'position'> & {
  core: Pick<Core, 'alloc' | 'bytes' | 'free'> & { api: Pick<Core['api'], 'llama_memory_seq_pos_max' | 'llama_memory_clear' | 'llama_state_seq_get_size' | 'llama_state_seq_get_data' | 'llama_state_seq_set_data'> },
};
export type LiveCheckpoint = { pointer: bigint, bytes: bigint, position: number };

/** A full public state snapshot includes attention, recurrent and sliding-window
 * state. Partial KV trimming alone is not a rollback for these models. */
export async function captureLiveCheckpoint({ native }: { native: CheckpointHost }): Promise<LiveCheckpoint> {
  const { core, context, memory, position } = native;
  if (position === 0) {
    return { pointer: 0n, bytes: 0n, position };
  }
  if (await core.api.llama_memory_seq_pos_max(memory, 0) + 1 !== position) {
    throw new Error('Live context position changed before checkpoint');
  }
  const bytes = await core.api.llama_state_seq_get_size(context, 0);
  // Fail before mutating a turn rather than silently disabling safe interruption.
  if (bytes <= 0n || bytes > 512n * 1024n * 1024n) {
    throw new Error('Live checkpoint exceeds the 512 MiB session limit');
  }
  const pointer = core.alloc({ bytes });
  try {
    core.bytes({ pointer, length: bytes });
    if (await core.api.llama_state_seq_get_data(context, pointer, bytes, 0) !== bytes) {
      throw new Error('Incomplete live checkpoint');
    }
    return { pointer, bytes, position };
  } catch (error) {
    core.free({ pointer });
    throw error;
  }
}

export async function restoreLiveCheckpoint({ native, checkpoint }: { native: CheckpointHost, checkpoint: LiveCheckpoint }): Promise<void> {
  const { core, context, memory } = native;
  await core.api.llama_memory_clear(memory, 1);
  if (checkpoint.bytes > 0n && await core.api.llama_state_seq_set_data(context, checkpoint.pointer, checkpoint.bytes, 0) !== checkpoint.bytes) {
    throw new Error('Failed to restore live checkpoint; close the session');
  }
  if (await core.api.llama_memory_seq_pos_max(memory, 0) + 1 !== checkpoint.position) {
    throw new Error('Restored live position does not match the checkpoint');
  }
  native.position = checkpoint.position;
}

export function freeLiveCheckpoint({ native, checkpoint }: { native: CheckpointHost, checkpoint: LiveCheckpoint | undefined }): void {
  if (checkpoint?.pointer) {
    native.core.free({ pointer: checkpoint.pointer });
  }
}

/** Native record storage is width-aware and is released in reverse acquisition order. */
export function createLiveAllocations({ core }: { core: Core }) {
  const allocations: bigint[] = [];
  return {
    alloc({ bytes }: { bytes: number }): bigint {
      const pointer = core.alloc({ bytes });
      allocations.push(pointer);
      core.bytes({ pointer, length: bytes }).fill(0);
      return pointer;
    },
    record({ name }: { name: string }): bigint {
      const pointer = core.allocRecord({ name });
      allocations.push(pointer);
      return pointer;
    },
    text({ text }: { text: string }): bigint {
      const pointer = core.utf8({ text });
      allocations.push(pointer);
      return pointer;
    },
    release(): void {
      let failure: { error: unknown } | undefined;
      while (allocations.length) {
        try {
          core.free({ pointer: allocations.pop()! });
        } catch (error) {
          failure ??= { error };
        }
      }
      if (failure) {
        throw failure.error;
      }
    },
  };
}

export const TEST_ONLY = {
};
