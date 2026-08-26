/* eslint-disable no-restricted-imports -- Worker-only unit test mocks the Transformers.js runtime contract. */
import { describe, expect, it, vi } from "vitest";

vi.mock("@huggingface/transformers", () => {
  class LogitsProcessor {
    _call(): never {
      throw new Error("Not implemented");
    }
  }
  class LogitsProcessorList {
    processors: unknown[] = [];

    push(item: unknown): void {
      this.processors.push(item);
    }

    *[Symbol.iterator](): IterableIterator<unknown> {
      yield* this.processors;
    }
  }
  class Tensor {
    readonly data: Float32Array;
    readonly dims: number[];

    constructor(_type: string, data: Float32Array, dims: number[]) {
      this.data = data;
      this.dims = dims;
    }

    _getitem(index: number): Tensor {
      const rowSize = this.dims.at(-1);
      if (rowSize === undefined) throw new Error("Missing row size");
      return new Tensor("float32", this.data.subarray(index * rowSize, (index + 1) * rowSize), [rowSize]);
    }
  }
  return { LogitsProcessor, LogitsProcessorList, Tensor };
});

import { Tensor } from "@huggingface/transformers";
import {
  ForcedTokenSequenceLogitsProcessor,
  createForcedTokenSequenceLogitsProcessorList,
} from "@/features/transformers-js/model-support-investigation/worker/forced-token-sequence-logits-processor";

function logits(): Tensor {
  return new Tensor("float32", Float32Array.from([
    1, 2, 3, 4,
    5, 6, 7, 8,
  ]), [2, 4]);
}

describe("ForcedTokenSequenceLogitsProcessor", () => {
  it("forces the next provenance token independently for each batch row", () => {
    const processor = new ForcedTokenSequenceLogitsProcessor({
      promptLength: 2,
      forcedTokenIds: [3, 1],
    });
    const value = logits();

    processor._call([[10n, 11n], [20n, 21n, 22n]], value);

    expect(Array.from(value._getitem(0).data)).toEqual([-Infinity, -Infinity, -Infinity, 0]);
    expect(Array.from(value._getitem(1).data)).toEqual([-Infinity, 0, -Infinity, -Infinity]);
  });

  it("leaves logits unchanged after the complete sequence has been forced", () => {
    const processor = new ForcedTokenSequenceLogitsProcessor({
      promptLength: 1,
      forcedTokenIds: [2],
    });
    const value = new Tensor("float32", Float32Array.from([1, 2, 3]), [1, 3]);

    processor._call([[10n, 2n]], value);

    expect(Array.from(value.data)).toEqual([1, 2, 3]);
  });

  it("rejects a token outside the observed vocabulary", () => {
    const processor = new ForcedTokenSequenceLogitsProcessor({
      promptLength: 1,
      forcedTokenIds: [3],
    });
    const value = new Tensor("float32", Float32Array.from([1, 2, 3]), [1, 3]);

    expect(() => processor._call([[10n]], value)).toThrow("outside the logits vocabulary size 3");
  });

  it("rejects a generation sequence shorter than the recorded prompt", () => {
    const processor = new ForcedTokenSequenceLogitsProcessor({
      promptLength: 2,
      forcedTokenIds: [1],
    });

    expect(() => processor._call([[10n]], new Tensor("float32", Float32Array.from([1, 2]), [1, 2])))
      .toThrow("shorter than prompt length 2");
  });

  it("creates a Transformers.js processor list with the forced processor", () => {
    const processors = createForcedTokenSequenceLogitsProcessorList({
      promptLength: 2,
      forcedTokenIds: [1],
    });

    expect([...processors]).toHaveLength(1);
    expect([...processors][0]).toBeInstanceOf(ForcedTokenSequenceLogitsProcessor);
  });
});
