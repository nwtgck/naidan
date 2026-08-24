import type { ToolCall } from "@/01-models/types";
import type { ToolCallId } from "@/01-models/ids";
import { generateId } from "@/01-models/id";
import { HarmonyStreamParser } from "@/features/transformers-js/models/gpt-oss-harmony";

export class GptOssOutputInterpreter {
  private readonly onChunk: ({ chunk }: { chunk: string }) => void;
  private readonly onCall: () => void;
  private readonly parser = new HarmonyStreamParser();
  private readonly pendingToolCalls: ToolCall[] = [];
  private currentChannel = "";
  private pendingAnalysisClose = false;

  constructor({ onChunk, onCall }: {
    onChunk: ({ chunk }: { chunk: string }) => void,
    onCall: () => void,
  }) {
    this.onChunk = onChunk;
    this.onCall = onCall;
  }

  feed({ output }: { output: string }): void {
    const delta = this.parser.push({ token: output });
    if (!delta) return;

    switch (delta.type) {
    case "content": {
      const message = this.parser.messages[delta.messageIndex];
      const channel = message?.channel || "";
      const isFunctionCallMessage = message?.recipient?.startsWith("functions.") === true;
      const visibleChannel = isFunctionCallMessage ? "" : channel;

      if (this.pendingAnalysisClose) {
        if (visibleChannel !== "analysis") {
          this.onChunk({ chunk: "</think>" });
          this.currentChannel = "";
        }
        this.pendingAnalysisClose = false;
      }

      if (visibleChannel !== this.currentChannel) {
        if (this.currentChannel === "analysis") this.onChunk({ chunk: "</think>" });
        if (visibleChannel === "analysis") this.onChunk({ chunk: "<think>" });
        this.currentChannel = visibleChannel;
      }

      if (!isFunctionCallMessage && visibleChannel !== "commentary") {
        this.onChunk({ chunk: delta.textDelta });
      }
      break;
    }
    case "done": {
      const message = this.parser.messages[delta.messageIndex];
      const isFunctionCallMessage = message?.recipient?.startsWith("functions.") === true;
      if (!isFunctionCallMessage && this.currentChannel === "analysis") {
        this.pendingAnalysisClose = true;
      }
      switch (delta.endReason) {
      case "call":
      case "return":
        if (this.pendingAnalysisClose || this.currentChannel === "analysis") {
          this.onChunk({ chunk: "</think>" });
          this.pendingAnalysisClose = false;
        }
        this.currentChannel = "";
        break;
      case "end":
        if (isFunctionCallMessage && this.currentChannel === "analysis") {
          this.onChunk({ chunk: "</think>" });
          this.pendingAnalysisClose = false;
          this.currentChannel = "";
        }
        break;
      default: {
        const exhaustive: never = delta.endReason;
        throw new Error(`Unhandled endReason: ${exhaustive}`);
      }
      }
      switch (delta.endReason) {
      case "call":
        this.onCall();
        if (message?.recipient?.startsWith("functions.")) {
          const functionName = message.recipient.slice("functions.".length);
          const parsedArgs = tryParseGptOssToolArguments({ content: message.content });
          if (parsedArgs) {
            this.pendingToolCalls.push({
              id: generateId<ToolCallId>(),
              type: "function",
              function: {
                name: functionName,
                arguments: JSON.stringify(parsedArgs),
              },
            });
          }
        }
        break;
      case "end":
      case "return":
        break;
      default: {
        const exhaustive: never = delta.endReason;
        throw new Error(`Unhandled endReason: ${exhaustive}`);
      }
      }
      break;
    }
    case "new_message":
      break;
    default: {
      const exhaustive: never = delta;
      throw new Error(`Unhandled Harmony delta: ${exhaustive}`);
    }
    }
  }

  drainToolCalls(): ToolCall[] {
    return this.pendingToolCalls.splice(0);
  }
}

export function tryParseGptOssToolArguments({ content }: {
  content: string,
}): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(content) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
