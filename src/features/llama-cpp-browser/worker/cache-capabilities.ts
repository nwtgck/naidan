import type { Core } from '@/features/llama-cpp-browser/runtime/core';

export type SequenceRemoval = 'none' | 'full-only' | 'bounded' | 'partial';

/** Probe only a newly created context, following llama.cpp's common helper.
 * The two temporary tokens must never become an application's reusable prefix. */
export async function probeNewContextSequenceRemoval({ core, context }: {
  core: Pick<Core, 'alloc' | 'allocRecord' | 'bytes' | 'free'> & { api: Pick<Core['api'],
    'llama_get_memory' | 'llama_memory_clear' | 'llama_batch_get_one' | 'llama_decode'
    | 'llama_n_rs_seq' | 'llama_memory_seq_rm' | 'llama_synchronize'> },
  context: bigint,
}): Promise<SequenceRemoval> {
  const api = core.api;
  const memory = await api.llama_get_memory(context);
  if (memory === 0n) return 'none';
  let tokens = 0n;
  let batch = 0n;
  try {
    await api.llama_memory_clear(memory, 1);
    tokens = core.alloc({ bytes: 8 });
    core.bytes({ pointer: tokens, length: 8 }).fill(0);
    batch = core.allocRecord({ name: 'llama_batch' });
    await api.llama_batch_get_one(batch, tokens, 2);
    // A declined probe disables advanced reuse, not ordinary generation.
    // Exceptions still propagate so the session discards an unsafe context.
    if (await api.llama_decode(context, batch) !== 0) return 'none';
    if (await api.llama_n_rs_seq(context) > 0) return 'bounded';
    return await api.llama_memory_seq_rm(memory, 0, 1, -1) ? 'partial' : 'full-only';
  } finally {
    try {
      await api.llama_memory_clear(memory, 1);
      await api.llama_synchronize(context);
    } finally {
      if (batch !== 0n) core.free({ pointer: batch });
      if (tokens !== 0n) core.free({ pointer: tokens });
    }
  }
}
export const TEST_ONLY = {
};
