/* eslint-disable no-restricted-imports -- Hosted investigation worker helper intentionally imports Transformers.js runtime types. */
import {
  LogitsProcessor,
  LogitsProcessorList,
  type Tensor,
} from "@huggingface/transformers";

function forceToken({ row, tokenId }: {
  row: Tensor,
  tokenId: number,
}): void {
  if (!Number.isSafeInteger(tokenId) || tokenId < 0) {
    throw new RangeError(`Forced token ID must be a non-negative safe integer: ${tokenId}`);
  }
  const data = row.data;
  const length = Reflect.get(data, "length");
  const fill = Reflect.get(data, "fill");
  if (typeof length !== "number" || typeof fill !== "function") {
    throw new TypeError("Logits row does not expose mutable numeric data");
  }
  if (tokenId >= length) {
    throw new RangeError(`Forced token ID ${tokenId} is outside the logits vocabulary size ${length}`);
  }
  Reflect.apply(fill, data, [-Infinity]);
  Reflect.set(data, tokenId, 0);
}

export class ForcedTokenSequenceLogitsProcessor extends LogitsProcessor {
  readonly promptLength: number;
  readonly forcedTokenIds: readonly number[];

  constructor({ promptLength, forcedTokenIds }: {
    promptLength: number,
    forcedTokenIds: readonly number[],
  }) {
    super();
    if (!Number.isSafeInteger(promptLength) || promptLength < 0) {
      throw new RangeError(`Prompt length must be a non-negative safe integer: ${promptLength}`);
    }
    if (forcedTokenIds.length === 0) {
      throw new RangeError("Forced token sequence must not be empty");
    }
    this.promptLength = promptLength;
    this.forcedTokenIds = [...forcedTokenIds];
  }

  override _call(inputIds: bigint[][], logits: Tensor): Tensor {
    for (let batchIndex = 0; batchIndex < inputIds.length; batchIndex += 1) {
      const sequence = inputIds[batchIndex];
      if (sequence === undefined) {
        throw new Error(`Missing input ID sequence for logits batch ${batchIndex}`);
      }
      const forcedIndex = sequence.length - this.promptLength;
      if (forcedIndex < 0) {
        throw new Error(
          `Generation input length ${sequence.length} is shorter than prompt length ${this.promptLength}`,
        );
      }
      const tokenId = this.forcedTokenIds[forcedIndex];
      if (tokenId === undefined) continue;
      forceToken({ row: logits._getitem(batchIndex), tokenId });
    }
    return logits;
  }
}

export function createForcedTokenSequenceLogitsProcessorList({ promptLength, forcedTokenIds }: {
  promptLength: number,
  forcedTokenIds: readonly number[],
}): LogitsProcessorList {
  const processors = new LogitsProcessorList();
  processors.push(new ForcedTokenSequenceLogitsProcessor({ promptLength, forcedTokenIds }));
  return processors;
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
