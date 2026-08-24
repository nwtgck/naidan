/* eslint-disable no-restricted-imports -- Worker-only investigation helper test intentionally types the Transformers.js tokenizer mock. */
import { describe, expect, it, vi } from "vitest";
import type { PreTrainedTokenizer } from "@huggingface/transformers";
import { observeToolResultTemplateRoundTrip } from "./observe-tool-result-template-roundtrip";

function tokenizer() {
  return {
    get_chat_template: vi.fn(() => "selected-template"),
    apply_chat_template: vi.fn((_messages, options) => options?.tokenize === false ? "rendered" : [1, 2, 3]),
  } as unknown as PreTrainedTokenizer;
}

describe("observeToolResultTemplateRoundTrip", () => {
  it("renders a recognized deterministic tool call and fixed result with the same tokenizer", () => {
    const value = tokenizer();
    const result = observeToolResultTemplateRoundTrip({
      tokenizer: value,
      parserObservation: {
        status: "observed",
        strategy: "standard",
        parserKind: "standard-tool-call-stream-parser",
        inputMode: "production-text-streamer-reconstruction",
        inputChunks: ["tool"],
        visibleText: "",
        callBoundaryCount: undefined,
        toolCalls: [{ name: "lookup_weather", arguments: '{"city":"Tokyo"}' }],
        recognized: true,
      },
    });
    expect(result).toEqual(expect.objectContaining({
      status: "observed",
      parserStrategy: "standard",
      inputTokenIds: [1, 2, 3],
      toolResultContent: '{"temperatureC":20,"condition":"clear"}',
    }));
    expect(value.apply_chat_template).toHaveBeenCalledTimes(2);
  });

  it("does not infer a roundtrip when the parser did not recognize one deterministic call", () => {
    expect(observeToolResultTemplateRoundTrip({
      tokenizer: tokenizer(),
      parserObservation: {
        status: "observed",
        strategy: "standard",
        parserKind: "standard-tool-call-stream-parser",
        inputMode: "production-text-streamer-reconstruction",
        inputChunks: [],
        visibleText: "",
        callBoundaryCount: undefined,
        toolCalls: [],
        recognized: false,
      },
    })).toEqual({ status: "unavailable", reason: "Production parser did not recognize exactly one tool call" });
  });
});
