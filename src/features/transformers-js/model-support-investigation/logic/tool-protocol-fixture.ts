import { toToolCallId } from "@/01-models/ids";
import type { ChatMessage } from "@/01-models/types";
import type { ModelSupportInvestigationNormalizedToolCall } from "@/features/transformers-js/model-support-investigation/types";
import type { WorkerToolDefinition } from "@/features/transformers-js/types";

export const MODEL_SUPPORT_TOOL_RESULT_CONTENT = `{"temperatureC":20,"condition":"clear"}`;

export const MODEL_SUPPORT_TOOL_DEFINITIONS: WorkerToolDefinition[] = [{
  type: "function",
  function: {
    name: "lookup_weather",
    description: "Return deterministic weather fixture data.",
    parameters: {
      type: "object",
      properties: { city: { type: "string" } },
      required: ["city"],
    },
  },
}];

export function createModelSupportToolResultContinuationMessages({
  toolCall,
  toolResultContent,
}: {
  toolCall: ModelSupportInvestigationNormalizedToolCall,
  toolResultContent: string,
}): ChatMessage[] {
  const toolCallId = toToolCallId({ raw: "call_model_support_probe_1" });
  return [{
    role: "user",
    content: "Use the weather tool for Tokyo.",
  }, {
    role: "assistant",
    content: "",
    tool_calls: [{
      id: toolCallId,
      type: "function",
      function: {
        name: toolCall.name,
        arguments: toolCall.arguments,
      },
    }],
  }, {
    role: "tool",
    tool_call_id: toolCallId,
    content: toolResultContent,
  }];
}

export const TEST_ONLY = {
};
