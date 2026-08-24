import type { ToolCall } from "@/01-models/types";
import type {
  ModelSupportInvestigationNormalizedToolCall,
  ModelSupportInvestigationToolParserObservation,
} from "@/features/transformers-js/model-support-investigation/types";
import { ToolCallStreamParser } from "@/features/transformers-js/tool-call-parser";
import { Qwen3_5ToolCallParser } from "@/features/transformers-js/models/qwen3_5-tool-call-parser";
import { sanitizeQwen3_5VisibleText } from "@/features/transformers-js/models/qwen3_5";
import { GptOssOutputInterpreter } from "@/features/transformers-js/models/gpt-oss-output-interpreter";
import type { TransformersJsProductionInvestigationStrategy } from "@/features/transformers-js/types";

function normalizeToolCalls({ toolCalls }: { toolCalls: ToolCall[] }): ModelSupportInvestigationNormalizedToolCall[] {
  return toolCalls.map(toolCall => ({
    name: toolCall.function.name,
    arguments: toolCall.function.arguments,
  }));
}

export function observeProductionToolParser({ strategy, inputChunks }: {
  strategy: TransformersJsProductionInvestigationStrategy,
  inputChunks: string[],
}): Exclude<ModelSupportInvestigationToolParserObservation, { status: "failed" }> {
  switch (strategy) {
  case "standard": {
    const visibleChunks: string[] = [];
    const parser = new ToolCallStreamParser({
      onText: ({ text }) => visibleChunks.push(text),
    });
    for (const output of inputChunks) parser.feed({ output });
    parser.flush();
    const toolCalls = normalizeToolCalls({ toolCalls: parser.drainToolCalls() });
    return {
      status: "observed",
      strategy,
      parserKind: "standard-tool-call-stream-parser",
      inputMode: "production-text-streamer-reconstruction",
      inputChunks: [...inputChunks],
      visibleText: visibleChunks.join(""),
      callBoundaryCount: undefined,
      toolCalls,
      recognized: toolCalls.length > 0,
    };
  }
  case "qwen3_5": {
    const visibleChunks: string[] = [];
    const parser = new Qwen3_5ToolCallParser({
      onText: ({ text }) => {
        const sanitized = sanitizeQwen3_5VisibleText({ text });
        if (sanitized.length > 0) visibleChunks.push(sanitized);
      },
    });
    for (const output of inputChunks) parser.feed({ output });
    parser.flush();
    const toolCalls = normalizeToolCalls({ toolCalls: parser.drainToolCalls() });
    return {
      status: "observed",
      strategy,
      parserKind: "qwen3_5-tool-call-parser",
      inputMode: "production-text-streamer-reconstruction",
      inputChunks: [...inputChunks],
      visibleText: visibleChunks.join(""),
      callBoundaryCount: undefined,
      toolCalls,
      recognized: toolCalls.length > 0,
    };
  }
  case "gpt-oss": {
    const visibleChunks: string[] = [];
    let callBoundaryCount = 0;
    const interpreter = new GptOssOutputInterpreter({
      onChunk: ({ chunk }) => visibleChunks.push(chunk),
      onCall: () => {
        callBoundaryCount += 1;
      },
    });
    for (const output of inputChunks) interpreter.feed({ output });
    const toolCalls = normalizeToolCalls({ toolCalls: interpreter.drainToolCalls() });
    return {
      status: "observed",
      strategy,
      parserKind: "gpt-oss-harmony-output-interpreter",
      inputMode: "production-text-streamer-reconstruction",
      inputChunks: [...inputChunks],
      visibleText: visibleChunks.join(""),
      callBoundaryCount,
      toolCalls,
      recognized: toolCalls.length > 0,
    };
  }
  case "gemma4":
    return {
      status: "unavailable",
      strategy,
      reason: "The Gemma 4 production strategy does not expose a tool-call parser",
    };
  default: {
    const exhaustive: never = strategy;
    return exhaustive;
  }
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
