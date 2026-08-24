/* eslint-disable no-restricted-imports -- Worker-only investigation helper intentionally uses the loaded Transformers.js tokenizer contract. */
import type { PreTrainedTokenizer } from "@huggingface/transformers";
import type {
  ModelSupportInvestigationToolParserObservation,
  ModelSupportInvestigationToolResultTemplateRoundTrip,
} from "@/features/transformers-js/model-support-investigation/types";
import {
  createModelSupportToolResultContinuationMessages,
  MODEL_SUPPORT_TOOL_DEFINITIONS,
  MODEL_SUPPORT_TOOL_RESULT_CONTENT,
} from "@/features/transformers-js/model-support-investigation/logic/tool-protocol-fixture";

function normalizeInputIds({ value }: { value: unknown }): number[] {
  if (!Array.isArray(value)) throw new Error("Tool-result chat template did not return an input ID array");
  return value.map((item) => {
    if (typeof item !== "number" && typeof item !== "bigint") {
      throw new Error("Tool-result chat template returned a non-numeric input ID");
    }
    return Number(item);
  });
}

export function observeToolResultTemplateRoundTrip({
  tokenizer,
  parserObservation,
}: {
  tokenizer: PreTrainedTokenizer,
  parserObservation: ModelSupportInvestigationToolParserObservation,
}): Exclude<ModelSupportInvestigationToolResultTemplateRoundTrip, { status: "failed" }> {
  switch (parserObservation.status) {
  case "failed":
    return { status: "unavailable", reason: "Production parser observation failed" };
  case "unavailable":
    return { status: "unavailable", reason: parserObservation.reason };
  case "observed": {
    if (!parserObservation.recognized || parserObservation.toolCalls.length !== 1) {
      return { status: "unavailable", reason: "Production parser did not recognize exactly one tool call" };
    }
    const toolCall = parserObservation.toolCalls[0];
    if (toolCall === undefined || toolCall.name !== "lookup_weather") {
      return { status: "unavailable", reason: "Recognized tool call did not match the deterministic template fixture" };
    }
    let parsedArguments: unknown;
    try {
      parsedArguments = JSON.parse(toolCall.arguments);
    } catch {
      return { status: "unavailable", reason: "Recognized tool call arguments were not valid JSON" };
    }
    if (typeof parsedArguments !== "object" || parsedArguments === null || Array.isArray(parsedArguments)) {
      return { status: "unavailable", reason: "Recognized tool call arguments were not a JSON object" };
    }

    const messages = createModelSupportToolResultContinuationMessages({
      toolCall,
      toolResultContent: MODEL_SUPPORT_TOOL_RESULT_CONTENT,
    });
    const selectedTemplate = tokenizer.get_chat_template({ tools: MODEL_SUPPORT_TOOL_DEFINITIONS });
    const renderedText = tokenizer.apply_chat_template(messages, {
      tools: MODEL_SUPPORT_TOOL_DEFINITIONS,
      add_generation_prompt: true,
      tokenize: false,
    });
    const inputTokenIds = normalizeInputIds({
      value: tokenizer.apply_chat_template(messages, {
        tools: MODEL_SUPPORT_TOOL_DEFINITIONS,
        add_generation_prompt: true,
        tokenize: true,
        return_tensor: false,
        return_dict: false,
      }),
    });
    return {
      status: "observed",
      source: "recognized-production-parser-and-chat-template",
      parserStrategy: parserObservation.strategy,
      toolCall,
      toolResultContent: MODEL_SUPPORT_TOOL_RESULT_CONTENT,
      selectedTemplate,
      renderedText,
      inputTokenIds,
    };
  }
  default: {
    const exhaustive: never = parserObservation;
    return exhaustive;
  }
  }
}

export const TEST_ONLY = {
};
