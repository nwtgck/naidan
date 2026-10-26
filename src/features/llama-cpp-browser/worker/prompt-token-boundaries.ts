import type { Core } from '@/features/llama-cpp-browser/runtime/core';
import { LlamaCppBrowserError } from '@/features/llama-cpp-browser/types';
import type { EncodedPromptPart, TokenizedPromptPart } from './tokenize-chat-prompt';
import { tryTokenizePrompt } from './tokenize-prompt';

const maximumPieceBytes = 1024 * 1024;
const maximumCachedBytes = 256 * 1024;
const maximumCacheEntries = 1024;

export type PromptBoundaryCore = Pick<Core, 'tryAlloc' | 'bytes' | 'free' | 'constant'> & {
  api: Pick<Core['api'], 'llama_tokenize' | 'llama_vocab_type' | 'llama_vocab_get_attr' | 'llama_token_to_piece'>,
};

type Run = { byteOffset: number, byteLength: number } & (
  { kind: 'ordinary' } | { kind: 'special', token: number }
);
type Piece = { bytes: Uint8Array, special: boolean };

function isWhitespace({ byte }: { byte: number | undefined }): boolean {
  return byte === 9 || byte === 10 || byte === 11 || byte === 12 || byte === 13 || byte === 32;
}

function matchesBytes({ piece, source, offset, end }: { piece: Uint8Array, source: Uint8Array, offset: number, end: number }): boolean {
  return piece.length > 0 && piece.length <= end - offset && piece.every((byte, index) => byte === source[offset + index]);
}

/** Candidates may reduce the final token count; byte fidelity and special-token
 * checks still decide whether coalescing is safe after native tokenization. */
export async function findPromptTokenBoundaryCandidates({ core, vocab, prompt, parts }: {
  core: PromptBoundaryCore, vocab: bigint, prompt: bigint,
  parts: readonly EncodedPromptPart[],
}): Promise<ReadonlySet<number>> {
  const joinedBoundaries = new Set<number>();
  for (let index = 1; index < parts.length; index++) {
    const left = parts[index - 1]!;
    const right = parts[index]!;
    if (left.isInput === right.isInput || !left.byteLength || !right.byteLength) {
      continue;
    }
    const boundary = right.byteOffset;
    const adjacent = core.bytes({ pointer: prompt + BigInt(boundary - 1), length: 2 });
    if (isWhitespace({ byte: adjacent[0] }) && isWhitespace({ byte: adjacent[1] })) {
      joinedBoundaries.add(boundary);
    }
  }
  if (joinedBoundaries.size && await core.api.llama_vocab_type(vocab) === core.constant({ name: 'LLAMA_VOCAB_TYPE_BPE' })) {
    return joinedBoundaries;
  }
  return new Set<number>();
}

/** Native tokenization remains the authority for special-token recognition.
 * Join only byte-exact ordinary runs; retain the original result whenever the
 * vocabulary strips/normalizes bytes or joining would recognize another special. */
export async function coalescePromptTokenBoundaries({ core, vocab, prompt, tokens, parts, joinedBoundaries, contextTokens, onTokenize }: {
  core: PromptBoundaryCore, vocab: bigint, prompt: bigint, tokens: number[], parts: readonly TokenizedPromptPart[],
  joinedBoundaries: ReadonlySet<number>, contextTokens: number, onTokenize: () => void,
}): Promise<{ tokens: number[], parts: TokenizedPromptPart[] } | undefined> {
  if (!joinedBoundaries.size) {
    return undefined;
  }
  const first = parts[0]!;
  const last = parts.at(-1)!;
  const source = core.bytes({ pointer: prompt, length: last.byteOffset + last.byteLength }).slice();
  const specialMask = core.constant({ name: 'LLAMA_TOKEN_ATTR_UNKNOWN' })
    | core.constant({ name: 'LLAMA_TOKEN_ATTR_CONTROL' }) | core.constant({ name: 'LLAMA_TOKEN_ATTR_USER_DEFINED' });
  const unsupportedMask = core.constant({ name: 'LLAMA_TOKEN_ATTR_NORMALIZED' })
    | core.constant({ name: 'LLAMA_TOKEN_ATTR_LSTRIP' }) | core.constant({ name: 'LLAMA_TOKEN_ATTR_RSTRIP' });
  const cache = new Map<number, Piece>();
  let cachedBytes = 0;
  let scratch: bigint | undefined;
  let capacity = 256;
  const readPiece = async ({ token }: { token: number }): Promise<Piece | undefined> => {
    const previous = cache.get(token);
    if (previous) {
      return previous;
    }
    const attributes = await core.api.llama_vocab_get_attr(vocab, token);
    if (!Number.isInteger(attributes) || attributes < 0) {
      throw new LlamaCppBrowserError({ code: 'runtime-error' });
    }
    if (attributes & unsupportedMask) {
      return undefined;
    }
    if (scratch === undefined) {
      scratch = core.tryAlloc({ bytes: capacity });
      if (scratch === undefined) {
        return undefined;
      }
    }
    let length = await core.api.llama_token_to_piece(vocab, token, scratch, capacity, 0, 1);
    if (!Number.isInteger(length) || Math.abs(length) > maximumPieceBytes) {
      return undefined;
    }
    if (length < 0) {
      const required = -length;
      if (required <= capacity) {
        throw new LlamaCppBrowserError({ code: 'runtime-error' });
      }
      const previousScratch = scratch;
      scratch = undefined;
      core.free({ pointer: previousScratch });
      capacity = required;
      scratch = core.tryAlloc({ bytes: capacity });
      if (scratch === undefined) {
        return undefined;
      }
      length = await core.api.llama_token_to_piece(vocab, token, scratch, capacity, 0, 1);
      if (length !== required) {
        throw new LlamaCppBrowserError({ code: 'runtime-error' });
      }
    }
    if (length <= 0 || length > capacity) {
      return undefined;
    }
    const piece = { bytes: core.bytes({ pointer: scratch, length }).slice(), special: Boolean(attributes & specialMask) };
    if (piece.bytes.length <= maximumCachedBytes) {
      while (cache.size >= maximumCacheEntries || cachedBytes + piece.bytes.length > maximumCachedBytes) {
        const oldest = cache.entries().next().value;
        if (!oldest) {
          break;
        }
        cachedBytes -= oldest[1].bytes.length;
        cache.delete(oldest[0]);
      }
      cache.set(token, piece);
      cachedBytes += piece.bytes.length;
    }
    return piece;
  };
  try {
    const runs: Run[] = [];
    for (const part of parts) {
      let offset = part.byteOffset;
      const end = offset + part.byteLength;
      for (let index = part.tokenOffset; index < part.tokenOffset + part.tokenCount; index++) {
        const token = tokens[index]!;
        const piece = await readPiece({ token });
        if (!piece || !matchesBytes({ piece: piece.bytes, source, offset, end })) {
          return undefined;
        }
        if (piece.special) {
          runs.push({ kind: 'special', byteOffset: offset, byteLength: piece.bytes.length, token });
        } else {
          const current = runs.at(-1);
          if (!current) {
            runs.push({ kind: 'ordinary', byteOffset: offset, byteLength: piece.bytes.length });
          } else {
            switch (current.kind) {
            case 'ordinary':
              if (offset > part.byteOffset || joinedBoundaries.has(part.byteOffset)) {
                current.byteLength += piece.bytes.length;
              } else {
                runs.push({ kind: 'ordinary', byteOffset: offset, byteLength: piece.bytes.length });
              }
              break;
            case 'special': runs.push({ kind: 'ordinary', byteOffset: offset, byteLength: piece.bytes.length });
              break;
            default: {
              const exhaustive: never = current;
              throw new Error(`Unknown prompt run: ${exhaustive}`);
            }
            }
          }
        }
        offset += piece.bytes.length;
      }
      if (offset !== end) {
        return undefined;
      }
    }
    const canonicalTokens = tokens.slice(0, first.tokenOffset);
    const canonicalParts: TokenizedPromptPart[] = [];
    for (const run of runs) {
      const tokenOffset = canonicalTokens.length;
      switch (run.kind) {
      case 'special': canonicalTokens.push(run.token);
        break;
      case 'ordinary': {
        // Byte-level BPE has at most one ordinary token per source byte. Allow
        // the optional pass to finish before checking the actual context budget.
        const result = await tryTokenizePrompt({
          core,
          vocab,
          prompt: prompt + BigInt(run.byteOffset),
          promptBytes: run.byteLength,
          contextTokens: Math.max(contextTokens, run.byteLength + 9),
          addSpecial: false,
          parseSpecial: false,
          onTokenize,
        });
        if (!result) {
          return undefined;
        }
        try {
          let offset = run.byteOffset;
          const end = offset + run.byteLength;
          for (const token of result.tokens) {
            const piece = await readPiece({ token });
            if (!piece || piece.special || !matchesBytes({ piece: piece.bytes, source, offset, end })) {
              return undefined;
            }
            offset += piece.bytes.length;
          }
          if (offset !== end) {
            return undefined;
          }
          for (const token of result.tokens) {
            canonicalTokens.push(token);
          }
        } finally {
          core.free({ pointer: result.pointer });
        }
        break;
      }
      default: {
        const exhaustive: never = run;
        throw new Error(`Unknown prompt run: ${exhaustive}`);
      }
      }
      canonicalParts.push({
        byteOffset: run.byteOffset,
        byteLength: run.byteLength,
        tokenOffset,
        tokenCount: canonicalTokens.length - tokenOffset,
        addSpecial: false,
        parseSpecial: run.kind === 'special',
      });
    }
    canonicalTokens.push(...tokens.slice(last.tokenOffset + last.tokenCount));
    if (!canonicalTokens.length || canonicalTokens.length >= contextTokens) {
      return undefined;
    }
    return { tokens: canonicalTokens, parts: canonicalParts };
  } finally {
    if (scratch !== undefined) {
      core.free({ pointer: scratch });
    }
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
