import type { ChatMessage, LmParameters, ToolCall } from '@/01-models/types';
import type { BinaryObjectId } from '@/01-models/ids';

export const UNKNOWN_STEPS: unique symbol = Symbol('unknown');

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

/**
 * One call generates a new assistant message; the caller owns its history node.
 * Tool approval, execution, and subsequent generation belong to the caller.
 * This is a local API, not a structured-clone contract for a worker connection.
 */
export interface LmProvider {
  chat({ messages, model, parameters, tools, readBinaryObject, debug, signal }: {
    messages: readonly ChatMessage[],
    model: string,
    parameters: LmParameters | undefined,
    tools: readonly {
      name: string,
      description: string,
      parameters: { [keyword: string]: JsonValue },
    }[] | undefined,
    readBinaryObject: (({ binaryObjectId, signal }: {
      binaryObjectId: BinaryObjectId,
      signal: AbortSignal | undefined,
    }) => Promise<Blob>) | undefined,
    /** Per-request diagnostics preference; providers may ignore it. */
    debug: 'off' | 'on' | undefined,
    signal: AbortSignal | undefined,
  }): AsyncIterable<ChatGenerationItem>,

  /**
   * Optional runtime ownership for a whole generation/tool operation. Providers
   * without shared mutable inference state use chat directly. The scoped chat
   * still generates one new assistant per call and never executes tools itself.
   */
  runChatOperation?({ signal, operation }: {
    signal: AbortSignal | undefined,
    operation: ({ chat, signal }: { chat: LmProvider['chat'], signal: AbortSignal }) => Promise<void>,
  }): Promise<void>,

  listModels({ signal }: { signal: AbortSignal | undefined }): Promise<string[]>,
}

export type ChatGenerationItem =
  | {
      type: 'text' | 'reasoning',
      partId: string,
      // Logical order within the new message, not delivery or completion order.
      index: number,
      chunks: AsyncIterable<string>,
      // Apply this state only after all chunks have been added to the history.
      completeness: Promise<'complete' | 'partial'>,
    }
  | {
      type: 'tool_call_draft',
      partId: string,
      index: number,
      /** Latest name when available; undefined leaves the previous name unchanged. */
      name: string | undefined,
      /** Replace the suffix at this UTF-16 offset; parsers may revise partial JSON. */
      arguments: { offset: number, text: string } | undefined,
    }
  | {
      type: 'tool_call',
      partId: string,
      index: number,
      // Only a completed call is published. Arguments retain the generated text.
      toolCall: ToolCall,
    }
  | { type: 'result', result: ChatGenerationResult };

/** Display-only state for one generation. Never include this in message history. */
export type ToolCallDraft = {
  partId: string,
  index: number,
  name: string,
  arguments: string,
  // Derived after each insertion, not an identity for asynchronous updates.
  beforePartIndex: number,
};

/** Runtime control information; do not persist an Error or copy it into text. */
export type ChatGenerationResult =
  | { type: 'finished', next: 'user' | 'tool_results' }
  | {
      type: 'interrupted',
      reason: 'aborted' | 'limit' | 'stop_sequence' | 'unknown',
    }
  | { type: 'error', error: Error };

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
