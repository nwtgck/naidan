import type { InferenceGenerationEvent } from '@/features/transformers-js/generation-events';
import type { WorkerToolDefinition } from '@/features/transformers-js/types';
import { createStandardGeneration } from './standard-generation';
import type { StandardToolHandling } from '@/features/transformers-js/standard-tool-call-protocol';
import { formatStandardMessagesForToolHandling } from '@/features/transformers-js/standard-tool-call-protocol';
import type { InferenceMessage } from '@/features/transformers-js/types';
import { exactObject } from '@/utils/exact-object';
import type { ReasoningStreamProtocol } from '@/features/transformers-js/reasoning-stream-protocol';

export const lfm2ReasoningProtocolTokens = ['<think>', '</think>'] as const;

export function formatMessagesForLfm2ReasoningProtocol({
  messages, handling, modelType, reasoningProtocol,
}: {
  messages: InferenceMessage[],
  handling: StandardToolHandling,
  modelType: string | null | undefined,
  reasoningProtocol: ReasoningStreamProtocol,
}): Array<{ role: string; content: string; tool_calls?: unknown; tool_call_id?: InferenceMessage['tool_call_id']; reasoning?: string }> {
  if (modelType === 'lfm2' && reasoningProtocol === 'prompt-open-think') {
    return formatLfm2MessagesForToolHandling({ messages, handling });
  }
  return formatStandardMessagesForToolHandling({ messages, handling });
}

/** Maps an already structured reasoning part to the model template's native
 * field. Tags stay owned by the template and are never parsed from content. */
export function formatLfm2MessagesForToolHandling({ messages, handling }: {
  messages: InferenceMessage[],
  handling: StandardToolHandling,
}): Array<{ role: string; content: string; tool_calls?: unknown; tool_call_id?: InferenceMessage['tool_call_id']; reasoning?: string }> {
  const reasoningHistory = messages.flatMap((message, index) => message.reasoning === undefined ? [] : [{ index, role: message.role, reasoning: message.reasoning }]);
  if (reasoningHistory.length === 0) return formatStandardMessagesForToolHandling({ messages, handling });
  switch (handling.historyEncoding) {
  case 'native-template': break;
  case 'verified-content': throw new Error('LFM2 reasoning history requires the native template adapter.');
  default: { const exhaustive: never = handling.historyEncoding; throw new Error(String(exhaustive)); }
  }
  for (const item of reasoningHistory) {
    if (item.role !== 'assistant') throw new Error('LFM2 reasoning history must belong to an assistant message.');
    const { text: _text, completeness, ...unhandled } = item.reasoning;
    unhandled satisfies Record<PropertyKey, never>;
    switch (completeness) {
    case 'complete': break;
    case 'partial': throw new Error('LFM2 cannot continue partial reasoning without inventing a native closing delimiter.');
    default: { const exhaustive: never = completeness; throw new Error(String(exhaustive)); }
    }
  }
  const withoutReasoning = messages.map(message => {
    const { role, content, tool_calls, tool_call_id, reasoning: _reasoning, ...unhandled } = message;
    unhandled satisfies Record<PropertyKey, never>;
    return exactObject<InferenceMessage>()({ role, content, reasoning: undefined,
      ...(tool_calls === undefined ? {} : { tool_calls }),
      ...(tool_call_id === undefined ? {} : { tool_call_id }),
    });
  });
  const formatted = formatStandardMessagesForToolHandling({ messages: withoutReasoning, handling });
  if (formatted.length !== messages.length) throw new Error('LFM2 native template formatting changed message correspondence.');
  return formatted.map((message, index) => {
    const reasoning = messages[index]?.reasoning;
    if (reasoning === undefined) return message;
    const { text, completeness, ...unhandled } = reasoning;
    unhandled satisfies Record<PropertyKey, never>;
    switch (completeness) {
    case 'complete': break;
    case 'partial': throw new Error('LFM2 partial reasoning passed validation.');
    default: { const exhaustive: never = completeness; throw new Error(String(exhaustive)); }
    }
    return { ...message, reasoning: text };
  });
}

/** LFM2 owns the opening reasoning delimiter in its rendered prompt. The
 * generated closing delimiter transfers the remaining native stream to the
 * standard text/Pythonic-tool codec without turning tag-like text into state. */
export function createLfm2Generation({ emit, endTokens, handling, tools }: {
  emit: ({ event }: { event: InferenceGenerationEvent }) => void,
  endTokens: readonly string[],
  handling: StandardToolHandling,
  tools: readonly WorkerToolDefinition[] | undefined,
}) {
  const endings = new Set(endTokens);
  const standard = createStandardGeneration({
    emit: ({ event }) => {
      switch (event.type) {
      case 'part_start': case 'text_delta': case 'part_end': case 'tool_start': case 'tool_call':
        emit({ event: { ...event, index: event.index + 1 } });
        break;
      case 'result': emit({ event }); break;
      default: { const exhaustive: never = event; throw new Error(String(exhaustive)); }
      }
    },
    endTokens,
    handling,
    tools,
  });
  let phase: 'reasoning' | 'body' | 'incomplete' = 'reasoning';
  let opened = false;
  let settled = false;

  function openReasoning(): void {
    if (opened) return;
    opened = true;
    emit({ event: { type: 'part_start', index: 0, kind: 'reasoning' } });
  }
  function closeReasoning({ completeness }: { completeness: 'complete' | 'partial' }): void {
    openReasoning();
    emit({ event: { type: 'part_end', index: 0, completeness } });
  }

  return {
    text({ text }: { text: string }): void {
      if (!text.length) return;
      if (settled || phase === 'incomplete') throw new Error('LFM2 content arrived after completion.');
      switch (phase) {
      case 'reasoning':
        openReasoning();
        emit({ event: { type: 'text_delta', index: 0, text } });
        return;
      case 'body': standard.text({ text }); return;
      default: { const exhaustive: never = phase; throw new Error(String(exhaustive)); }
      }
    },
    control({ token }: { token: string }): void {
      if (settled || phase === 'incomplete') throw new Error('LFM2 control arrived after completion.');
      switch (phase) {
      case 'reasoning':
        if (token === '</think>') {
          closeReasoning({ completeness: 'complete' });
          phase = 'body';
          return;
        }
        if (endings.has(token)) {
          closeReasoning({ completeness: 'partial' });
          phase = 'incomplete';
          return;
        }
        throw new Error('Unsupported control inside LFM2 reasoning.');
      case 'body':
        if (lfm2ReasoningProtocolTokens.includes(token as typeof lfm2ReasoningProtocolTokens[number])) {
          throw new Error('Misplaced LFM2 reasoning delimiter.');
        }
        standard.control({ token });
        return;
      default: { const exhaustive: never = phase; throw new Error(String(exhaustive)); }
      }
    },
    finish({ reason }: { reason: 'aborted' | 'limit' | 'unknown' }): void {
      if (settled) throw new Error('LFM2 generation was settled twice.');
      settled = true;
      switch (phase) {
      case 'reasoning':
        closeReasoning({ completeness: 'partial' });
        emit({ event: { type: 'result', result: { type: 'interrupted', reason } } });
        return;
      case 'incomplete':
        emit({ event: { type: 'result', result: { type: 'interrupted', reason } } });
        return;
      case 'body': standard.finish({ reason }); return;
      default: { const exhaustive: never = phase; throw new Error(String(exhaustive)); }
      }
    },
  };
}

export const TEST_ONLY = {
};
