import { logDiagnostic } from '@/features/llama-cpp-browser/debug-log';
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
export async function tokenizePrompt({ core, vocab, prompt, promptBytes, contextTokens, addSpecial, parseSpecial, onTokenize }: {
  core: TokenizeCore, vocab: bigint, prompt: bigint, promptBytes: number, contextTokens: number,
  addSpecial: boolean, parseSpecial: boolean, onTokenize: () => void,
}): Promise<{ pointer: bigint, tokens: number[] }> {
  const result = await tokenizePromptWithAllocation({ core, vocab, prompt, promptBytes, contextTokens, addSpecial, parseSpecial, onTokenize, allocation: 'required' });
  if (!result) {
    throw new LlamaCppBrowserError({ code: 'runtime-error' });
  }
  return result;
}

/** Optional optimization buffers must not turn a successful baseline into an
 * allocation failure. Native errors still propagate without being retried. */
export async function tryTokenizePrompt({ core, vocab, prompt, promptBytes, contextTokens, addSpecial, parseSpecial, onTokenize }: {
  core: TokenizeCore, vocab: bigint, prompt: bigint, promptBytes: number, contextTokens: number,
  addSpecial: boolean, parseSpecial: boolean, onTokenize: () => void,
}): Promise<{ pointer: bigint, tokens: number[] } | undefined> {
  return tokenizePromptWithAllocation({ core, vocab, prompt, promptBytes, contextTokens, addSpecial, parseSpecial, onTokenize, allocation: 'optional' });
}

async function tokenizePromptWithAllocation({ core, vocab, prompt, promptBytes, contextTokens, addSpecial, parseSpecial, onTokenize, allocation }: {
  core: TokenizeCore, vocab: bigint, prompt: bigint, promptBytes: number, contextTokens: number,
  addSpecial: boolean, parseSpecial: boolean, onTokenize: () => void, allocation: 'required' | 'optional',
}): Promise<{ pointer: bigint, tokens: number[] } | undefined> {
  if (!Number.isInteger(contextTokens) || contextTokens < (addSpecial ? 2 : 1) || contextTokens > maximumNativeCount
    || !Number.isInteger(promptBytes) || promptBytes < 0 || promptBytes > maximumNativeCount) {
    throw new LlamaCppBrowserError({ code: 'runtime-error' });
  }
  const maximumTokens = contextTokens - 1;
  // Size the speculative buffer for this prompt, not the resident context.
  // The small special-token allowance is only a hint; native negative counts
  // still trigger the exact-size retry, including unusual tokenizer families.
  let capacity = Math.max(1, Math.min(maximumTokens, speculativeTokens, promptBytes + 8));
  let pointer = core.tryAlloc({ bytes: capacity * 4 });
  if (pointer === undefined) {
    switch (allocation) {
    case 'required': break;
    case 'optional': return undefined;
    default: {
      const exhaustive: never = allocation;
      throw new Error(`Unknown allocation policy: ${exhaustive}`);
    }
    }
  }
  let transferred = false;
  const tokenize = async (): Promise<number> => {
    // Do not retain a view across native execution: Wasm memory may grow.
    if (pointer !== undefined) {
      core.bytes({ pointer, length: capacity * 4 });
    }
    onTokenize();
    const result = await core.api.llama_tokenize(vocab, prompt, promptBytes, pointer ?? 0n, pointer === undefined ? 0 : capacity, Number(addSpecial), Number(parseSpecial));
    if (!Number.isInteger(result) || result < -2147483648 || result > maximumNativeCount) {
      throw new LlamaCppBrowserError({ code: 'runtime-error' });
    }
    // INT32_MIN is the upstream overflow sentinel, not an allocatable length.
    if (result === -2147483648 || (result === 0 && addSpecial) || Math.abs(result) > maximumTokens) {
      logDiagnostic({ diagnostic: { event: 'failed', stage: 'tokenize', code: 'context-full', contextTokens, ...(result === -2147483648 ? {} : { tokens: Math.abs(result) }) } });
      throw new LlamaCppBrowserError({ code: 'context-full' });
    }
    return result;
  };
  try {
    let count = await tokenize();
    if (count < 0) {
      const required = -count;
      if (pointer !== undefined && required <= capacity) {
        throw new LlamaCppBrowserError({ code: 'runtime-error' });
      }
      const previous = pointer;
      // Consume ownership before freeing too: a failing destructor must never
      // be retried by finally, even if it freed the allocation before throwing.
      pointer = undefined;
      if (previous !== undefined) {
        core.free({ pointer: previous });
      }
      capacity = required;
      pointer = core.tryAlloc({ bytes: capacity * 4 });
      if (pointer === undefined) {
        switch (allocation) {
        case 'required': throw new LlamaCppBrowserError({ code: 'runtime-error' });
        case 'optional': return undefined;
        default: {
          const exhaustive: never = allocation;
          throw new Error(`Unknown allocation policy: ${exhaustive}`);
        }
        }
      }
      count = await tokenize();
      if (count !== required) {
        throw new LlamaCppBrowserError({ code: 'runtime-error' });
      }
    }
    if (count === 0 && pointer === undefined) {
      capacity = 1;
      pointer = core.tryAlloc({ bytes: 4 });
    }
    if (pointer === undefined || count > capacity) {
      throw new LlamaCppBrowserError({ code: 'runtime-error' });
    }
    const bytes = core.bytes({ pointer, length: count * 4 });
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const tokens = Array.from({ length: count }, (_, index) => view.getInt32(index * 4, true));
    transferred = true;
    return { pointer, tokens };
  } finally {
    if (!transferred && pointer !== undefined) {
      core.free({ pointer });
    }
  }
}

export const TEST_ONLY = {
};
