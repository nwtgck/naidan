import { z } from "zod";
import { toToolCallId } from "@/01-models/ids";
import type { Tool } from "@/01-models/tool";
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

/**
 * The public Provider must build its own strict tool definition and execute its
 * real argument validation/tool-result loop. The open native template fixture
 * above is a different observation boundary, not a pre-serialized public Tool.
 *
 * This investigation tool never looks up weather. Every successful execution
 * returns the fixed synthetic result, without reading arguments, user settings,
 * location, credentials, storage or the network. An unexpected model argument
 * must not acquire an environment capability or become an echoed secret.
 */
export function createModelSupportWeatherTool(): Tool {
  return {
    name: "lookup_weather",
    description: "Return deterministic weather fixture data.",
    parametersSchema: z.object({ city: z.string() }),
    async execute({ args: _args, signal: _signal, onEvent: _onEvent, approvalContext: _approvalContext }) {
      return { status: "success", content: MODEL_SUPPORT_TOOL_RESULT_CONTENT };
    },
  };
}

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
