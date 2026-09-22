import { z } from 'zod';
import { generateId } from '@/01-models/id';
import type { ToolCallId } from '@/01-models/ids';
import type { ToolCall } from '@/01-models/types';
import type { InferenceMessage } from '@/features/transformers-js/types';
import type { InferenceGenerationEvent } from '@/features/transformers-js/generation-events';
import { HarmonyStreamParser } from './gpt-oss-harmony';
import { exactObject } from '@/utils/exact-object';

/** Native Harmony framing, not a parser for tags in ordinary assistant text. */
export function createGptOssGeneration({ emit }: {
  emit: ({ event }: { event: InferenceGenerationEvent }) => void,
}) {
  const parser = new HarmonyStreamParser();
  // Both full-chat and owned tool suffix inputs prepare an assistant header.
  parser.push({ token: '<|start|>' });
  parser.pushText({ text: 'assistant' });
  let index = 0;
  let active: { index: number, kind: 'text' | 'reasoning' | 'tool_call' } | undefined;
  let terminal: 'user' | 'tool_results' | undefined;
  let settled = false;
  const parts: Array<
    { type: 'text' | 'reasoning', text: string, completeness: 'complete' | 'partial' }
    | { type: 'tool_call', toolCall: ToolCall }
  > = [];
  let activePart: Extract<typeof parts[number], { type: 'text' | 'reasoning' }> | undefined;

  function ensureWritable(): void {
    if (settled || terminal !== undefined) throw new Error('Harmony content arrived after completion.');
  }
  function openBody(): void {
    if (active !== undefined) throw new Error('Harmony started a body before closing its previous message.');
    const message = parser.messages.at(-1);
    if (!message || message.role !== 'assistant') throw new Error('Unsupported Harmony message author.');
    let kind: 'text' | 'reasoning' | 'tool_call';
    if (message.recipient !== undefined) {
      if (!message.recipient.startsWith('functions.') || message.recipient.length === 'functions.'.length || !['', 'commentary'].includes(message.channel)) {
        throw new Error('Unsupported Harmony tool recipient or channel.');
      }
      kind = 'tool_call';
    } else {
      switch (message.channel) {
      case 'analysis': kind = 'reasoning'; break;
      case '': case 'final': case 'commentary': kind = 'text'; break;
      default: throw new Error('Unsupported Harmony channel.');
      }
    }
    active = { index: index++, kind };
    switch (kind) {
    case 'tool_call':
      emit({ event: { type: 'tool_start', index: active.index } });
      break;
    case 'text': case 'reasoning':
      activePart = { type: kind, text: '', completeness: 'partial' };
      parts.push(activePart);
      emit({ event: { type: 'part_start', index: active.index, kind } });
      break;
    default: { const exhaustive: never = kind; throw new Error(`Unhandled part kind: ${exhaustive}`); }
    }
  }
  function closeBody({ token }: { token: string }): void {
    if (!active) throw new Error('Harmony ended a message before its body.');
    const message = parser.messages.at(-1)!;
    switch (active.kind) {
    case 'tool_call': {
      if (token !== '<|call|>') throw new Error('Harmony tool draft ended without a call boundary.');
      // Validation does not reserialize arguments or apply tool defaults.
      z.record(z.string(), z.json()).parse(JSON.parse(message.content));
      const toolCall: ToolCall = { id: generateId<ToolCallId>(), type: 'function', function: {
        name: message.recipient!.slice('functions.'.length), arguments: message.content,
      } };
      parts.push({ type: 'tool_call', toolCall });
      emit({ event: { type: 'tool_call', index: active.index, toolCall } });
      terminal = 'tool_results';
      break;
    }
    case 'text': case 'reasoning': {
      if (token === '<|call|>') throw new Error('Harmony handoff has no supported tool recipient.');
      activePart!.completeness = 'complete';
      emit({ event: { type: 'part_end', index: active.index, completeness: 'complete' } });
      if (token === '<|return|>') terminal = 'user';
      break;
    }
    default: { const exhaustive: never = active.kind; throw new Error(`Unhandled part kind: ${exhaustive}`); }
    }
    parser.push({ token });
    active = undefined; activePart = undefined;
  }

  return {
    text({ text }: { text: string }): void {
      if (text.length === 0) return;
      ensureWritable();
      const delta = parser.pushText({ text });
      if (delta === null) return;
      switch (delta.type) {
      case 'content': break;
      case 'new_message': case 'done': throw new Error('Ordinary Harmony text changed framing.');
      default: { const exhaustive: never = delta; throw new Error(`Unhandled Harmony delta: ${exhaustive}`); }
      }
      if (!active) throw new Error('Harmony content arrived without an open body.');
      switch (active.kind) {
      case 'tool_call': return;
      case 'text': case 'reasoning': break;
      default: { const exhaustive: never = active.kind; throw new Error(`Unhandled part kind: ${exhaustive}`); }
      }
      activePart!.text += text;
      emit({ event: { type: 'text_delta', index: active.index, text } });
    },
    control({ token }: { token: string }): void {
      ensureWritable();
      switch (token) {
      case '<|start|>': case '<|channel|>': case '<|constrain|>':
        if (active) throw new Error('Harmony changed framing inside an open body.');
        parser.push({ token });
        break;
      case '<|message|>':
        openBody(); parser.push({ token }); break;
      case '<|end|>': case '<|return|>': case '<|call|>':
        closeBody({ token }); break;
      default: throw new Error('Unsupported Harmony control token.');
      }
    },
    finish({ reason }: { reason: 'aborted' | 'limit' | 'unknown' }): void {
      if (settled) throw new Error('Harmony generation was settled twice.');
      settled = true;
      if (active && active.kind !== 'tool_call') {
        emit({ event: { type: 'part_end', index: active.index, completeness: 'partial' } });
      }
      emit({ event: { type: 'result', result: terminal === undefined
        ? { type: 'interrupted', reason }
        : { type: 'finished', next: terminal } } });
      active = undefined; activePart = undefined;
    },
    assistant(): InferenceMessage | undefined {
      // This existing input codec has only one leading reasoning field. A
      // richer generated history is retained as parts, never flattened for KV.
      if (!settled || terminal === undefined) return undefined;
      let reasoning: InferenceMessage['reasoning'];
      let content = '';
      let hasText = false;
      const calls: ToolCall[] = [];
      let phase: 'reasoning' | 'text' | 'tool_call' = 'reasoning';
      for (const part of parts) {
        switch (part.type) {
        case 'reasoning': {
          const { type: _type, text, completeness, ...unhandled } = part;
          unhandled satisfies Record<PropertyKey, never>;
          if (reasoning !== undefined || phase !== 'reasoning' || completeness !== 'complete') return undefined;
          reasoning = exactObject<NonNullable<InferenceMessage['reasoning']>>()({ text, completeness });
          break;
        }
        case 'text': {
          const { type: _type, text, completeness, ...unhandled } = part;
          unhandled satisfies Record<PropertyKey, never>;
          if (hasText || phase === 'tool_call' || completeness !== 'complete') return undefined;
          hasText = true;
          phase = 'text'; content += text;
          break;
        }
        case 'tool_call': {
          const { type: _type, toolCall, ...unhandled } = part;
          unhandled satisfies Record<PropertyKey, never>;
          phase = 'tool_call'; calls.push(toolCall);
          break;
        }
        default: { const exhaustive: never = part; throw new Error(`Unhandled generated part: ${exhaustive}`); }
        }
      }
      if (reasoning !== undefined && hasText && calls.length > 0) return undefined;
      // Match the delivered-parts projection, including absent vs. empty text.
      // Cache history currently uses JSON identity, so property order also agrees.
      return exactObject<Omit<InferenceMessage, 'tool_call_id'>>()({ role: 'assistant', content: hasText ? content : [],
        ...(calls.length ? { tool_calls: calls } : {}),
        ...(reasoning === undefined ? {} : { reasoning }),
      });
    },
  };
}

export const TEST_ONLY = {
};
