import { describe, expect, it } from "vitest";
import { observeProductionToolParser } from "./observe-production-tool-parser";

describe("observeProductionToolParser", () => {
  it("uses the standard production parser", () => {
    const result = observeProductionToolParser({
      strategy: "standard",
      tools: undefined,
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
      tools: undefined,
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
      tools: undefined,
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
      tools: undefined,
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
    expect(observeProductionToolParser({ strategy: "gemma4", inputChunks: [], tools: undefined })).toEqual({
      status: "unavailable",
      strategy: "gemma4",
      reason: "Gemma 4 native parser reconstruction is not implemented in this observation path",
    });
  });

  it('uses the actual Qwen tool schema when reconstructing JSON-looking and numeric strings', () => {
    const result = observeProductionToolParser({
      strategy: 'qwen3_5',
      inputChunks: ['<tool_call><function=probe><parameter=text>{"city":"Tokyo"}</parameter><parameter=number_text>123</parameter><parameter=object>{"city":"Tokyo"}</parameter></function></tool_call>'],
      tools: [{ type: 'function', function: { name: 'probe', description: 'Synthetic schema reconstruction control.', parameters: {
        type: 'object', properties: { text: { type: 'string' }, number_text: { type: 'string' }, object: { type: 'object' } },
      } } }],
    });
    expect(result).toEqual(expect.objectContaining({
      status: 'observed', recognized: true,
      toolCalls: [{ name: 'probe', arguments: '{"text":"{\\"city\\":\\"Tokyo\\"}","number_text":"123","object":{"city":"Tokyo"}}' }],
    }));
  });
});
