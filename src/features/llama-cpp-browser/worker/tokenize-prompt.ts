import type { Core } from '@/features/llama-cpp-browser/runtime/core';
import { LlamaCppBrowserError } from '@/features/llama-cpp-browser/types';

// Speculate at most 256 KiB, independently of the model's context size. This
// bounds the common-case allocation without assuming a bytes/token ratio.
const speculativeTokens = 65536;
const maximumNativeCount = 2147483647;

type TokenizeCore = Pick<Core, 'tryAlloc' | 'bytes' | 'free'> & {
  api: Pick<Core['api'], 'llama_tokenize'>,
};

/** Transfers one native token buffer to the caller on success; otherwise frees
 * every allocation after the native call settles, including on a trap/rejection.
 * A failed speculative allocation falls back to the existing size-query path. */
export async function tokenizePrompt({ core, vocab, prompt, promptBytes, contextTokens, onTokenize }: {
  core: TokenizeCore, vocab: bigint, prompt: bigint, promptBytes: number, contextTokens: number,
  onTokenize: () => void,
}): Promise<{ pointer: bigint, tokens: number[] }> {
  if (!Number.isInteger(contextTokens) || contextTokens < 2 || contextTokens > maximumNativeCount
    || !Number.isInteger(promptBytes) || promptBytes < 0 || promptBytes > maximumNativeCount) {
    throw new LlamaCppBrowserError({ code: 'runtime-error' });
  }
  const maximumTokens = contextTokens - 1;
  let capacity = Math.min(maximumTokens, speculativeTokens);
  let pointer = core.tryAlloc({ bytes: capacity * 4 });
  let transferred = false;
  const tokenize = async (): Promise<number> => {
    // Do not retain a view across native execution: Wasm memory may grow.
    if (pointer !== undefined) core.bytes({ pointer, length: capacity * 4 });
    onTokenize();
    const result = await core.api.llama_tokenize(vocab, prompt, promptBytes, pointer ?? 0n, pointer === undefined ? 0 : capacity, 1, 1);
    if (!Number.isInteger(result) || result < -2147483648 || result > maximumNativeCount) {
      throw new LlamaCppBrowserError({ code: 'runtime-error' });
    }
    // INT32_MIN is the upstream overflow sentinel, not an allocatable length.
    if (result === -2147483648 || result === 0 || Math.abs(result) > maximumTokens) {
      throw new LlamaCppBrowserError({ code: 'context-full' });
    }
    return result;
  };
  try {
    let count = await tokenize();
    if (count < 0) {
      const required = -count;
      if (pointer !== undefined && required <= capacity) throw new LlamaCppBrowserError({ code: 'runtime-error' });
      const previous = pointer;
      // Consume ownership before freeing too: a failing destructor must never
      // be retried by finally, even if it freed the allocation before throwing.
      pointer = undefined;
      if (previous !== undefined) core.free({ pointer: previous });
      capacity = required;
      pointer = core.tryAlloc({ bytes: capacity * 4 });
      if (pointer === undefined) throw new LlamaCppBrowserError({ code: 'runtime-error' });
      count = await tokenize();
      if (count !== required) throw new LlamaCppBrowserError({ code: 'runtime-error' });
    }
    if (pointer === undefined || count > capacity) throw new LlamaCppBrowserError({ code: 'runtime-error' });
    const bytes = core.bytes({ pointer, length: count * 4 });
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const tokens = Array.from({ length: count }, (_, index) => view.getInt32(index * 4, true));
    transferred = true;
    return { pointer, tokens };
  } finally {
    if (!transferred && pointer !== undefined) core.free({ pointer });
  }
}

export const TEST_ONLY = {
};
