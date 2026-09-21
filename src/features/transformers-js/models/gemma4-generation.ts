import type { InferenceGenerationEvent } from '@/features/transformers-js/generation-events';
import { parseGemma4ToolCallBody } from './gemma4-tool-call-parser';
import { validateGemma4ToolCallsForTemplate } from './gemma4';

const quote = '<|"|>';
const thoughtHeader = 'thought\n';
const maxCallLength = 64 * 1024;

/** Interprets actual Gemma control tokens, never tag-shaped ordinary text. */
export function createGemma4Generation({ emit, toolCalls }: {
  emit: ({ event }: { event: InferenceGenerationEvent }) => void,
  toolCalls: 'enabled' | 'disabled',
}) {
  let phase: 'body' | 'channel_header' | 'thought' | 'tool_call' = 'body';
  let header = '';
  let nextIndex = 0;
  let active: { index: number, kind: 'text' | 'reasoning' } | undefined;
  let quoted = false;
  let trailingNewline = false;
  let callIndex: number | undefined;
  let callBody = '';
  let callText = '';
  let completedCalls = 0;
  let terminal: 'user' | 'tool_results' | 'incomplete' | undefined;
  let settled = false;

  function assertWritable(): void {
    if (settled || terminal !== undefined) throw new Error('Gemma content arrived after completion.');
  }
  function open({ kind }: { kind: 'text' | 'reasoning' }): void {
    if (active !== undefined) throw new Error('Gemma opened an overlapping body.');
    active = { index: nextIndex++, kind };
    emit({ event: { type: 'part_start', index: active.index, kind } });
  }
  function delta({ text }: { text: string }): void {
    if (!text) return;
    if (active === undefined) open({ kind: 'text' });
    emit({ event: { type: 'text_delta', index: active!.index, text } });
  }
  function flushNewline(): void {
    if (trailingNewline) {
      trailingNewline = false; delta({ text: '\n' });
    }
  }
  function close({ completeness }: { completeness: 'complete' | 'partial' }): void {
    if (active !== undefined) {
      emit({ event: { type: 'part_end', index: active.index, completeness } });
      active = undefined;
    }
  }
  function appendCallText(): void {
    // Ordinary text spelling a native quote must not become a quote boundary
    // when converting the already-framed body to the native argument grammar.
    if (callText.includes(quote)) throw new Error('Gemma cannot preserve a literal native quote delimiter in tool arguments.');
    callBody += callText; callText = '';
  }
  function appendCall({ text }: { text: string }): void {
    if (callBody.length + callText.length + text.length > maxCallLength) throw new Error('Gemma tool draft exceeds its size limit.');
    callText += text;
  }
  function bodyText({ text }: { text: string }): void {
    switch (phase) {
    case 'body': delta({ text }); break;
    case 'thought':
      // The template inserts exactly one newline before <channel|>. Retain at
      // most that character until the boundary confirms it is framing. At an
      // interrupted EOF it is still content and must be published unchanged.
      flushNewline();
      trailingNewline = text.endsWith('\n');
      delta({ text: trailingNewline ? text.slice(0, -1) : text });
      break;
    case 'channel_header':
      header += text;
      if (header.startsWith(thoughtHeader)) {
        const content = header.slice(thoughtHeader.length);
        header = ''; phase = 'thought'; open({ kind: 'reasoning' });
        bodyText({ text: content });
      } else if (!thoughtHeader.startsWith(header)) {
        throw new Error('Unsupported Gemma channel header.');
      }
      break;
    case 'tool_call': appendCall({ text }); break;
    default: { const exhaustive: never = phase; throw new Error(`Unhandled Gemma phase: ${exhaustive}`); }
    }
  }

  return {
    text({ text }: { text: string }): void {
      if (text.length === 0) return;
      assertWritable(); bodyText({ text });
    },
    control({ token }: { token: string }): void {
      assertWritable();
      switch (phase) {
      case 'tool_call':
        appendCallText();
        if (token === quote) {
          if (callBody.length + token.length > maxCallLength) throw new Error('Gemma tool draft exceeds its size limit.');
          callBody += token; quoted = !quoted; return;
        }
        if (quoted) {
          // An actual control token inside a native string is argument data.
          appendCall({ text: token }); return;
        }
        if (token === '<turn|>' || token === '<eos>') {
          terminal = 'incomplete'; return;
        }
        if (token !== '<tool_call|>') throw new Error('Gemma tool draft ended without its closing delimiter.');
        {
          const toolCall = parseGemma4ToolCallBody({ body: callBody });
          validateGemma4ToolCallsForTemplate({ toolCalls: [toolCall] });
          emit({ event: { type: 'tool_call', index: callIndex!, toolCall } });
          completedCalls++;
          phase = 'body'; callIndex = undefined; callBody = ''; return;
        }
      case 'channel_header':
        throw new Error('Gemma channel header was interrupted by another control token.');
      case 'thought':
        if (token === quote) {
          quoted = !quoted; bodyText({ text: token }); return;
        }
        if (quoted) {
          bodyText({ text: token }); return;
        }
        switch (token) {
        case '<channel|>':
          trailingNewline = false;
          close({ completeness: 'complete' }); phase = 'body'; return;
        case '<|tool_call>': case '<tool_call|>': case '<|tool_response>': case '<tool_response|>':
          bodyText({ text: token }); return;
        case '<turn|>': case '<eos>':
          flushNewline(); close({ completeness: 'partial' });
          // A turn terminator cannot complete an unclosed thought channel.
          terminal = 'incomplete'; return;
        default: throw new Error('Unsupported control token inside a Gemma thought.');
        }
      case 'body':
        if (token === quote) {
          quoted = !quoted; bodyText({ text: token }); return;
        }
        if (quoted) {
          bodyText({ text: token }); return;
        }
        switch (token) {
        case '<|channel>':
          close({ completeness: 'complete' }); phase = 'channel_header'; header = ''; return;
        case '<|tool_call>':
          switch (toolCalls) {
          case 'enabled': break;
          case 'disabled': throw new Error('Gemma generated a tool call without tool declarations.');
          default: { const exhaustive: never = toolCalls; throw new Error(`Unhandled tool mode: ${exhaustive}`); }
          }
          close({ completeness: 'complete' });
          phase = 'tool_call'; callIndex = nextIndex++; callBody = ''; callText = '';
          emit({ event: { type: 'tool_start', index: callIndex } }); return;
        case '<|tool_response>':
          if (!completedCalls) throw new Error('Gemma tool handoff has no completed call.');
          close({ completeness: 'complete' }); terminal = 'tool_results'; return;
        case '<turn|>': case '<eos>':
          if (nextIndex === 0) open({ kind: 'text' });
          close({ completeness: 'complete' }); terminal = completedCalls ? 'tool_results' : 'user'; return;
        default: throw new Error('Unsupported or misplaced Gemma control token.');
        }
      default: { const exhaustive: never = phase; throw new Error(`Unhandled Gemma phase: ${exhaustive}`); }
      }
    },
    finish({ reason }: { reason: 'aborted' | 'limit' | 'unknown' }): void {
      if (settled) throw new Error('Gemma generation was settled twice.');
      settled = true;
      flushNewline(); close({ completeness: 'partial' });
      emit({ event: { type: 'result', result: terminal === undefined || terminal === 'incomplete'
        ? { type: 'interrupted', reason }
        : { type: 'finished', next: terminal } } });
    },
  };
}

export const TEST_ONLY = {
};
