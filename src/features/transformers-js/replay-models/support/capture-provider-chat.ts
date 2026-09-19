import type { LmProvider } from '@/01-models/lm';

type ChatArguments = Parameters<LmProvider['chat']>[0];
type CallbackName = 'onChunk' | 'onAssistantMessageStart' | 'onToolCall' | 'onToolResult' | 'onToolEvent';
export type CapturedChatRequest = Omit<ChatArguments, CallbackName>;
type CallbackPayload<Name extends Exclude<CallbackName, 'onAssistantMessageStart'>> = Parameters<NonNullable<ChatArguments[Name]>>[0];
export type CapturedProviderCallback =
  | { kind: 'assistant-start'; assistantIndex: number }
  | { kind: 'chunk'; assistantIndex: number | undefined; chunk: string }
  | ({ kind: 'tool-call' } & CallbackPayload<'onToolCall'>)
  | ({ kind: 'tool-result' } & CallbackPayload<'onToolResult'>)
  | ({ kind: 'tool-event' } & CallbackPayload<'onToolEvent'>);
export type CapturedProviderEvent = CapturedProviderCallback | { kind: 'settled'; outcome: 'fulfilled' | 'rejected' };
type ChatSettlement = { status: 'pending' } | { status: 'fulfilled' } | { status: 'rejected'; error: unknown };
export interface CapturedProviderChatSnapshot {
  chunks: string[];
  responses: string[][];
  preStartChunks: string[];
  toolCalls: CallbackPayload<'onToolCall'>[];
  toolResults: CallbackPayload<'onToolResult'>[];
  toolEvents: CallbackPayload<'onToolEvent'>[];
  events: CapturedProviderEvent[];
  lateEvents: CapturedProviderCallback[];
  settlement: ChatSettlement;
}
export interface ProviderChatCapture {
  completion: Promise<void>;
  snapshot(): CapturedProviderChatSnapshot;
}

/** Observe one literal public call; never choose inputs, expectations or tools.
 * Callbacks only record. Rejections retain their original identity. A snapshot
 * after completion observes delivered callbacks, not an arbitrary future window.
 */
export function captureProviderChat({ provider, request }: {
  provider: Pick<LmProvider, 'chat'>; request: CapturedChatRequest;
}): ProviderChatCapture {
  const { model, messages, parameters, tools, toolApprovalContext, signal, ...unhandledRequest } = request;
  unhandledRequest satisfies Record<PropertyKey, never>;
  const chunks: string[] = [];
  const responses: string[][] = [];
  const preStartChunks: string[] = [];
  const toolCalls: CallbackPayload<'onToolCall'>[] = [];
  const toolResults: CallbackPayload<'onToolResult'>[] = [];
  const toolEvents: CallbackPayload<'onToolEvent'>[] = [];
  const events: CapturedProviderEvent[] = [];
  const lateEvents: CapturedProviderCallback[] = [];
  let settlement: ChatSettlement = { status: 'pending' };
  function record({ event }: { event: CapturedProviderCallback }) {
    events.push(event);
    switch (settlement.status) {
    case 'pending': break;
    case 'fulfilled': case 'rejected': lateEvents.push(event); break;
    default: { const exhaustive: never = settlement; throw new Error(String(exhaustive)); }
    }
  }
  let operation: Promise<void>;
  try {
    operation = provider.chat({
      model, messages, parameters, tools, toolApprovalContext, signal,
      onAssistantMessageStart: () => {
        responses.push([]);
        record({ event: { kind: 'assistant-start', assistantIndex: responses.length - 1 } });
      },
      onChunk: ({ chunk }) => {
        chunks.push(chunk);
        const response = responses.at(-1);
        if (response === undefined) preStartChunks.push(chunk);
        else response.push(chunk);
        record({ event: { kind: 'chunk', assistantIndex: response === undefined ? undefined : responses.length - 1, chunk } });
      },
      onToolCall: ({ ...payload }) => {
        const copy = structuredClone(payload); toolCalls.push(copy);
        record({ event: { kind: 'tool-call', ...copy } });
      },
      onToolResult: ({ ...payload }) => {
        const copy = structuredClone(payload); toolResults.push(copy);
        record({ event: { kind: 'tool-result', ...copy } });
      },
      onToolEvent: ({ ...payload }) => {
        const copy = structuredClone(payload); toolEvents.push(copy);
        record({ event: { kind: 'tool-event', ...copy } });
      },
    });
  } catch (error) {
    operation = Promise.reject(error);
  }
  const completion = operation.then(() => {
    settlement = { status: 'fulfilled' }; events.push({ kind: 'settled', outcome: 'fulfilled' });
  }, (error: unknown) => {
    settlement = { status: 'rejected', error }; events.push({ kind: 'settled', outcome: 'rejected' });
    throw error;
  });
  return {
    completion,
    snapshot() {
      return {
        ...structuredClone({ chunks, responses, preStartChunks, toolCalls, toolResults, toolEvents, events, lateEvents }),
        // Keep rejection identity; it is not a serialized callback payload.
        settlement: { ...settlement },
      };
    },
  };
}

export const TEST_ONLY = {
};
