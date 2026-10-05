import type { Core } from '@/features/llama-cpp-browser/runtime/core';
import { logDiagnostic } from '@/features/llama-cpp-browser/debug-log';

// Public llama.h ABI macro; unlike enums, it is absent from the generated schema.
const partialOnly = 1;

type CheckpointCore = Pick<Core, 'pointerBytes' | 'tryAlloc' | 'bytes' | 'free'> & {
  api: Pick<Core['api'], 'llama_get_memory' | 'llama_memory_seq_pos_min' | 'llama_memory_seq_pos_max'
    | 'llama_state_seq_get_size_ext' | 'llama_state_seq_get_data_ext' | 'llama_state_seq_set_data_ext'
    | 'llama_memory_seq_rm' | 'llama_tokenize'>,
};

export type PromptCheckpoint = {
  pointer: bigint,
  bytes: number,
  tokens: number[],
  positionMin: number,
  positionMax: number,
};

export function disposePromptCheckpoint({ core, checkpoint }: { core: Pick<Core, 'free'>, checkpoint: PromptCheckpoint | undefined }): void {
  if (checkpoint) core.free({ pointer: checkpoint.pointer });
}

/** Keep one host-side Wasm allocation, with no duplicate JavaScript state buffer.
 * ON_DEVICE copies outlive host blobs, so this path permits explicit disposal. */
export async function capturePromptCheckpoint({ core, context, tokens }: {
  core: CheckpointCore, context: bigint, tokens: number[],
}): Promise<PromptCheckpoint | undefined> {
  const started = performance.now();
  const api = core.api;
  const memory = await api.llama_get_memory(context);
  if (memory === 0n || tokens.length === 0) return undefined;
  const positionMin = await api.llama_memory_seq_pos_min(memory, 0);
  const positionMax = await api.llama_memory_seq_pos_max(memory, 0);
  if (positionMin < 0 || positionMin > positionMax || positionMax !== tokens.length - 1) return undefined;
  const size = await api.llama_state_seq_get_size_ext(context, 0, partialOnly);
  const pointerLimit = (1n << BigInt(core.pointerBytes * 8)) - 1n;
  if (size <= 0n || size > BigInt(Number.MAX_SAFE_INTEGER) || size > pointerLimit) {
    logDiagnostic({ diagnostic: { event: 'checkpoint-skipped', reason: 'checkpoint-size', tokens: tokens.length } });
    return undefined;
  }
  const bytes = Number(size);
  const pointer = core.tryAlloc({ bytes });
  if (pointer === undefined) {
    logDiagnostic({ diagnostic: { event: 'checkpoint-skipped', reason: 'checkpoint-allocation', bytes, tokens: tokens.length } });
    return undefined;
  }
  let owned = true;
  try {
    // Check the complete range before the native writer uses this pointer.
    core.bytes({ pointer, length: bytes });
    if (await api.llama_state_seq_get_data_ext(context, pointer, size, 0, partialOnly) !== size) {
      logDiagnostic({ diagnostic: { event: 'checkpoint-skipped', reason: 'checkpoint-invalid', bytes, tokens: tokens.length } });
      return undefined;
    }
    const checkpoint = { pointer, bytes, tokens: tokens.slice(), positionMin, positionMax };
    logDiagnostic({ diagnostic: { event: 'checkpoint-created', bytes, tokens: tokens.length, elapsedMs: performance.now() - started } });
    owned = false;
    return checkpoint;
  } finally {
    if (owned) core.free({ pointer });
  }
}

/** Partial restore leaves ordinary attention in place; trim its old suffix only
 * after restoring the recurrent/SWA state for the same verified token prefix. */
export async function restorePromptCheckpoint({ core, context, checkpoint }: {
  core: CheckpointCore, context: bigint, checkpoint: PromptCheckpoint,
}): Promise<boolean> {
  const started = performance.now();
  const { pointer, bytes, tokens, positionMin, positionMax, ...unhandled } = checkpoint;
  unhandled satisfies Record<PropertyKey, never>;
  const api = core.api;
  const memory = await api.llama_get_memory(context);
  if (memory === 0n) return false;
  if (await api.llama_state_seq_set_data_ext(context, pointer, BigInt(bytes), 0, partialOnly) !== BigInt(bytes)
    || !await api.llama_memory_seq_rm(memory, 0, tokens.length, -1)
    || await api.llama_memory_seq_pos_min(memory, 0) !== positionMin
    || await api.llama_memory_seq_pos_max(memory, 0) !== positionMax) return false;
  logDiagnostic({ diagnostic: { event: 'checkpoint-restored', bytes, tokens: tokens.length, elapsedMs: performance.now() - started } });
  return true;
}

/** Prefer the native generation suffix boundary only when both text and actual
 * tokenization agree. Retain a final token for fresh logits in every case. */
export async function promptCheckpointBoundary({ core, vocab, prompt, promptPointer, generationPrompt, tokens, onTokenize }: {
  core: CheckpointCore, vocab: bigint, prompt: string, promptPointer: bigint, generationPrompt: string, tokens: number[], onTokenize: () => void,
}): Promise<number> {
  const fallback = Math.max(0, tokens.length - 1);
  if (!generationPrompt || !prompt.endsWith(generationPrompt)) return fallback;
  const prefix = prompt.slice(0, -generationPrompt.length);
  const length = new TextEncoder().encode(prefix).length;
  if (tokens.length < 2) return fallback;
  let capacity = Math.min(tokens.length - 1, 65536);
  let pointer = core.tryAlloc({ bytes: capacity * 4 });
  if (pointer === undefined) return fallback;
  try {
    // Validate before passing native code a writable range, and reacquire the
    // view after it settles because tokenization can grow Wasm memory.
    core.bytes({ pointer, length: capacity * 4 });
    onTokenize();
    let count = await core.api.llama_tokenize(vocab, promptPointer, length, pointer, capacity, 1, 1);
    if (Number.isInteger(count) && count >= -2147483647 && count < -capacity && count > -tokens.length) {
      const required = -count;
      const previous = pointer; pointer = undefined;
      core.free({ pointer: previous });
      capacity = required;
      pointer = core.tryAlloc({ bytes: capacity * 4 });
      if (pointer === undefined) return fallback;
      core.bytes({ pointer, length: capacity * 4 });
      onTokenize();
      count = await core.api.llama_tokenize(vocab, promptPointer, length, pointer, capacity, 1, 1);
      if (count !== required) return fallback;
    }
    // A checkpoint is optional. Failed/overflowing tokenization must never
    // cause a huge allocation or invent a prefix boundary.
    if (!Number.isInteger(count) || count < 1 || count > capacity || count >= tokens.length) return fallback;
    const bytes = core.bytes({ pointer, length: count * 4 });
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let common = 0;
    while (common < count && view.getInt32(common * 4, true) === tokens[common]) common++;
    // Tokenization can merge across the generation suffix boundary. Capture
    // before that changed token instead of assuming the text split is a token split.
    return common > 0 ? common : fallback;
  } finally {
    if (pointer !== undefined) core.free({ pointer });
  }
}

export const TEST_ONLY = {
};
