import { describe, expect, it, vi } from "vitest";
import { GptOssOutputInterpreter } from "./gpt-oss-output-interpreter";

describe("GptOssOutputInterpreter", () => {
  it("preserves the production Harmony tool-call interpretation", () => {
    const onChunk = vi.fn();
    const onCall = vi.fn();
    const interpreter = new GptOssOutputInterpreter({ onChunk, onCall });
    for (const output of [
      "<|start|>",
      "assistant to=functions.lookup_weather",
      "<|channel|>",
      "commentary",
      "<|constrain|>",
      "json",
      "<|message|>",
      "{\"city\":\"Tokyo\"}",
      "<|call|>",
    ]) interpreter.feed({ output });

    expect(onCall).toHaveBeenCalledTimes(1);
    expect(onChunk).not.toHaveBeenCalled();
    expect(interpreter.drainToolCalls()).toEqual([
      expect.objectContaining({
        type: "function",
        function: {
          name: "lookup_weather",
          arguments: "{\"city\":\"Tokyo\"}",
        },
      }),
    ]);
  });

  it("preserves analysis and final visible channel behavior", () => {
    const chunks: string[] = [];
    const interpreter = new GptOssOutputInterpreter({
      onChunk: ({ chunk }) => chunks.push(chunk),
      onCall: vi.fn(),
    });
    for (const output of [
      "<|start|>", "assistant", "<|channel|>", "analysis", "<|message|>", "Think",
      "<|end|>", "<|start|>", "assistant", "<|channel|>", "final", "<|message|>", "Done", "<|return|>",
    ]) interpreter.feed({ output });

    expect(chunks.join("")).toBe("<think>Think</think>Done");
  });
});
