import { describe, expect, it, vi } from "vitest";

vi.mock("@huggingface/transformers", () => ({
  TextStreamer: class {
    constructor() {}
  },
  StoppingCriteriaList: class {
    push(): void {}
  },
}));

import {
  selectGenerationStrategy,
  type GenerationStrategyObservationSink,
} from "./generation-strategies";

describe("generation strategy observation isolation", () => {
  it("does not let diagnostic observation failures change standard Production generation", async () => {
    const generate = vi.fn().mockResolvedValue({ past_key_values: null, sequences: [] });
    const applyChatTemplate = vi.fn().mockReturnValue({
      input_ids: { data: BigInt64Array.from([10n, 11n]) },
    });
    const observationSink: GenerationStrategyObservationSink = {
      onFullConversationInputPrepared: vi.fn(() => {
        throw new Error("full input observer failed");
      }),
      onGenerateStart: vi.fn(() => {
        throw new Error("generate start observer failed");
      }),
      onGenerateComplete: vi.fn(() => {
        throw new Error("generate complete observer failed");
      }),
    };

    const strategy = selectGenerationStrategy({
      modelType: "fixture",
      activeModelId: "org/model",
      hasTools: false,
    });

    await expect(strategy.generate({
      model: { generate } as never,
      tokenizer: { apply_chat_template: applyChatTemplate } as never,
      messages: [{ role: "user", content: "hello" }],
      onChunk: vi.fn(),
      onRawChunk: vi.fn(),
      onToolCalls: vi.fn(),
      params: {
        temperature: undefined,
        topP: undefined,
        maxCompletionTokens: 1,
        presencePenalty: undefined,
        frequencyPenalty: undefined,
        stop: undefined,
        reasoning: { effort: undefined },
      },
      tools: undefined,
      runtimeState: {
        activeModelId: "org/model",
        gemma4Processor: null,
        qwen3_5Processor: null,
        gptOssPastKeyValues: null,
        qwen3_5PastKeyValues: null,
        qwen3_5ConversationState: undefined,
      },
      stoppingCriteria: { reset: vi.fn(), interrupt: vi.fn() },
      debugLog: vi.fn(),
      observationSink,
    })).resolves.toBeUndefined();

    expect(applyChatTemplate).toHaveBeenCalledTimes(2);
    expect(generate).toHaveBeenCalledOnce();
    expect(observationSink.onFullConversationInputPrepared).toHaveBeenCalledOnce();
    expect(observationSink.onGenerateStart).toHaveBeenCalledOnce();
    expect(observationSink.onGenerateComplete).toHaveBeenCalledOnce();
  });
});
