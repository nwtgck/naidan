import type { ChatPromptPart } from '@/features/llama-cpp-browser/runtime/chat-bindings';
import type { Core } from '@/features/llama-cpp-browser/runtime/core';
import { LlamaCppBrowserError } from '@/features/llama-cpp-browser/types';
import { tokenizePrompt } from './tokenize-prompt';

export type EncodedPromptPart = {
  byteOffset: number,
  byteLength: number,
  isInput: boolean,
};

export type TokenizedPromptPart = EncodedPromptPart & {
  tokenOffset: number,
  tokenCount: number,
  addSpecial: boolean,
};

/** Encode each native segment once. Only offsets, not views into Wasm memory,
 * survive asynchronous tokenization. Keep the existing total prompt limit. */
export function encodeChatPrompt({ parts }: { parts: readonly ChatPromptPart[] }): { data: Uint8Array, parts: EncodedPromptPart[] } {
  const encoder = new TextEncoder();
  const encoded: Uint8Array[] = [];
  const spans: EncodedPromptPart[] = [];
  let length = 0;
  for (const { text, isInput, ...unhandled } of parts) {
    unhandled satisfies Record<PropertyKey, never>;
    // UTF-8 is never shorter than the UTF-16 code-unit count. Reject a huge
    // segment before creating its temporary byte buffer.
    if (text.length > 4 * 1024 * 1024 - length) {
      throw new LlamaCppBrowserError({ code: 'context-full' });
    }
    const data = encoder.encode(text);
    if (data.byteLength > 4 * 1024 * 1024 - length) {
      throw new LlamaCppBrowserError({ code: 'context-full' });
    }
    if (data.byteLength === 0) {
      continue;
    }
    spans.push({ byteOffset: length, byteLength: data.byteLength, isInput });
    encoded.push(data);
    length += data.byteLength;
  }
  const data = encoded.length === 1 ? encoded[0]! : new Uint8Array(length);
  if (encoded.length > 1) {
    for (const [index, bytes] of encoded.entries()) {
      data.set(bytes, spans[index]!.byteOffset);
    }
  }
  if (!spans.length) {
    spans.push({ byteOffset: 0, byteLength: 0, isInput: false });
  }
  return { data, parts: spans };
}

type PromptCore = Pick<Core, 'alloc' | 'tryAlloc' | 'bytes' | 'free'> & {
  api: Pick<Core['api'], 'llama_tokenize' | 'llama_vocab_get_add_bos' | 'llama_vocab_get_add_eos'
    | 'llama_vocab_get_add_sep' | 'llama_vocab_bos' | 'llama_vocab_eos' | 'llama_vocab_sep'>,
};

/** Input text is never parsed as template special tokens. Automatic beginning,
 * end and separator tokens belong to the whole prompt, not each segment. */
export async function tokenizeChatPrompt({ core, vocab, prompt, parts, contextTokens, onTokenize }: {
  core: PromptCore, vocab: bigint, prompt: bigint, parts: readonly EncodedPromptPart[], contextTokens: number,
  onTokenize: () => void,
}): Promise<{ pointer: bigint, tokens: number[], parts: TokenizedPromptPart[] }> {
  if (!Number.isInteger(contextTokens) || contextTokens < 2 || contextTokens > 2147483647 || !parts.length) {
    throw new LlamaCppBrowserError({ code: 'runtime-error' });
  }
  let length = 0;
  for (const part of parts) {
    if (part.byteOffset !== length || !Number.isInteger(part.byteLength) || part.byteLength < 0
      || part.byteLength > 4 * 1024 * 1024 - length) {
      throw new LlamaCppBrowserError({ code: 'runtime-error' });
    }
    length += part.byteLength;
  }
  if (parts.length === 1) {
    const part = parts[0]!;
    const result = await tokenizePrompt({ core, vocab, prompt, promptBytes: part.byteLength, contextTokens, addSpecial: true, parseSpecial: !part.isInput, onTokenize });
    return { ...result, parts: [{ ...part, tokenOffset: 0, tokenCount: result.tokens.length, addSpecial: true }] };
  }
  const tokens: number[] = [];
  const suffix: number[] = [];
  const api = core.api;
  if (await api.llama_vocab_get_add_bos(vocab)) {
    tokens.push(await api.llama_vocab_bos(vocab));
  }
  if (await api.llama_vocab_get_add_eos(vocab)) {
    suffix.push(await api.llama_vocab_eos(vocab));
  }
  if (await api.llama_vocab_get_add_sep(vocab)) {
    suffix.push(await api.llama_vocab_sep(vocab));
  }
  for (const token of [...tokens, ...suffix]) {
    if (!Number.isInteger(token) || token < 0 || token > 2147483647) {
      throw new LlamaCppBrowserError({ code: 'runtime-error' });
    }
  }
  if (tokens.length + suffix.length >= contextTokens) {
    throw new LlamaCppBrowserError({ code: 'context-full' });
  }
  const tokenizedParts: TokenizedPromptPart[] = [];
  for (const part of parts) {
    const result = await tokenizePrompt({
      core,
      vocab,
      prompt: prompt + BigInt(part.byteOffset),
      promptBytes: part.byteLength,
      contextTokens: contextTokens - tokens.length - suffix.length,
      addSpecial: false,
      parseSpecial: !part.isInput,
      onTokenize,
    });
    try {
      tokenizedParts.push({ ...part, tokenOffset: tokens.length, tokenCount: result.tokens.length, addSpecial: false });
      // Do not spread an unbounded token array into function arguments.
      for (const token of result.tokens) {
        tokens.push(token);
      }
    } finally {
      core.free({ pointer: result.pointer });
    }
  }
  tokens.push(...suffix);
  if (!tokens.length) {
    throw new LlamaCppBrowserError({ code: 'context-full' });
  }
  const pointer = core.alloc({ bytes: tokens.length * 4 });
  let transferred = false;
  try {
    const bytes = core.bytes({ pointer, length: tokens.length * 4 });
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    tokens.forEach((token, index) => view.setInt32(index * 4, token, true));
    transferred = true;
    return { pointer, tokens, parts: tokenizedParts };
  } finally {
    if (!transferred) {
      core.free({ pointer });
    }
  }
}

export const TEST_ONLY = {
};
