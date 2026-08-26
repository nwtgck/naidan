import { describe, expect, it } from "vitest";
import { observeProductionToolParser } from "./observe-production-tool-parser";

describe("observeProductionToolParser", () => {
  it("uses the standard production parser", () => {
    const result = observeProductionToolParser({
      strategy: "standard",
      inputChunks: ["before ", "<tool_call>{\"name\":\"lookup_weather\",\"arguments\":{\"city\":\"Tokyo\"}}</tool_call>"],
    });
    expect(result).toEqual(expect.objectContaining({
      status: "observed",
      parserKind: "standard-tool-call-stream-parser",
      visibleText: "before ",
      recognized: true,
      toolCalls: [{ name: "lookup_weather", arguments: "{\"city\":\"Tokyo\"}" }],
    }));
  });

  it("uses the Qwen 3.5 production parser", () => {
    const result = observeProductionToolParser({
      strategy: "qwen3_5",
      inputChunks: ["<tool_call>{\"name\":\"lookup_weather\",\"arguments\":{\"city\":\"Tokyo\"}}</tool_call>"],
    });
    expect(result).toEqual(expect.objectContaining({
      status: "observed",
      parserKind: "qwen3_5-tool-call-parser",
      recognized: true,
      toolCalls: [{ name: "lookup_weather", arguments: "{\"city\":\"Tokyo\"}" }],
    }));
  });

  it("uses the GPT-OSS production Harmony interpreter", () => {
    const result = observeProductionToolParser({
      strategy: "gpt-oss",
      inputChunks: [
        "<|start|>", "assistant to=functions.lookup_weather", "<|channel|>", "commentary",
        "<|constrain|>", "json", "<|message|>", "{\"city\":\"Tokyo\"}", "<|call|>",
      ],
    });
    expect(result).toEqual(expect.objectContaining({
      status: "observed",
      parserKind: "gpt-oss-harmony-output-interpreter",
      callBoundaryCount: 1,
      recognized: true,
      toolCalls: [{ name: "lookup_weather", arguments: "{\"city\":\"Tokyo\"}" }],
    }));
  });

  it("records malformed output as observed but unrecognized", () => {
    const result = observeProductionToolParser({
      strategy: "standard",
      inputChunks: ["<tool_call>not-json</tool_call>"],
    });
    expect(result).toEqual(expect.objectContaining({
      status: "observed",
      recognized: false,
      toolCalls: [],
      visibleText: "<tool_call>not-json</tool_call>",
    }));
  });

  it("marks Gemma 4 parser observation unavailable", () => {
    expect(observeProductionToolParser({ strategy: "gemma4", inputChunks: [] })).toEqual({
      status: "unavailable",
      strategy: "gemma4",
      reason: "The Gemma 4 production strategy does not expose a tool-call parser",
    });
  });
});
