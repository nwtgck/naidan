import { describe, expect, it, vi } from "vitest";
import {
  createReasoningStreamNormalizer,
  detectReasoningStreamProtocol,
} from "./reasoning-stream-protocol";

describe("reasoning stream protocol", () => {
  it("detects a generation prompt that already opened thinking", () => {
    // This is the stable evidence shape produced when a chat template ends the
    // assistant generation prompt inside <think>. Model Support Investigation
    // records this value as the user-generation template case renderedText.
    const renderedGenerationPrompt = [
      "<|startoftext|><|im_start|>user",
      "Template probe user message.<|im_end|>",
      "<|im_start|>assistant",
      "<think>\n",
    ].join("\n");

    expect(detectReasoningStreamProtocol({ renderedGenerationPrompt, renderedConversationPrompt: undefined }))
      .toBe("prompt-open-think");
  });

  it("does not infer prompt-open thinking when the same suffix was already user content", () => {
    const renderedConversationPrompt = `\
<|im_start|>user
literal <think>`;
    const renderedGenerationPrompt = renderedConversationPrompt;

    expect(detectReasoningStreamProtocol({
      renderedGenerationPrompt,
      renderedConversationPrompt,
    })).toBe("generated-output");
  });

  it("does not infer prompt-open thinking from an earlier think tag", () => {
    const renderedGenerationPrompt = [
      "<|im_start|>user",
      "Literal <think> text in user content.<|im_end|>",
      "<|im_start|>assistant",
    ].join("\n");

    expect(detectReasoningStreamProtocol({ renderedGenerationPrompt, renderedConversationPrompt: undefined }))
      .toBe("generated-output");
  });

  it("leaves ordinary generated output byte-for-byte unchanged", () => {
    const onOutput = vi.fn();
    const normalizer = createReasoningStreamNormalizer({
      protocol: "generated-output",
      onOutput,
    });

    normalizer.feed({ output: "<think>reasoning" });
    normalizer.feed({ output: "</think>answer" });

    expect(onOutput.mock.calls.map(([value]) => value.output).join(""))
      .toBe("<think>reasoning</think>answer");
  });

  it("restores only the prompt-owned opening tag across arbitrary generated chunks", () => {
    const onOutput = vi.fn();
    const normalizer = createReasoningStreamNormalizer({
      protocol: "prompt-open-think",
      onOutput,
    });

    normalizer.feed({ output: "reason" });
    normalizer.feed({ output: "ing</thi" });
    normalizer.feed({ output: "nk>answer" });

    expect(onOutput.mock.calls.map(([value]) => value.output).join(""))
      .toBe("<think>reasoning</think>answer");
  });

  it("does not duplicate an opening tag that the model generated itself", () => {
    const onOutput = vi.fn();
    const normalizer = createReasoningStreamNormalizer({
      protocol: "prompt-open-think",
      onOutput,
    });

    normalizer.feed({ output: "<thi" });
    normalizer.feed({ output: "nk>reasoning" });
    normalizer.feed({ output: "</think>answer" });
    normalizer.flush();

    expect(onOutput.mock.calls.map(([value]) => value.output).join(""))
      .toBe("<think>reasoning</think>answer");
  });

  it("does not emit a synthetic thinking tag before any generated output exists", () => {
    const onOutput = vi.fn();
    const normalizer = createReasoningStreamNormalizer({
      protocol: "prompt-open-think",
      onOutput,
    });

    normalizer.feed({ output: "" });

    expect(onOutput).not.toHaveBeenCalled();
  });
});
