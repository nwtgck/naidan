import type { InferenceGenerationEvent } from '@/features/transformers-js/generation-events';
import type { WorkerToolDefinition } from '@/features/transformers-js/types';
import { parseQwen3_5NativeToolCall } from './qwen3_5-tool-call-parser';

export const qwen3_5ProtocolTokens = ['<think>', '</think>', '<tool_call>', '</tool_call>', '<tool_response>', '</tool_response>'] as const;
const maxDraftLength = 64 * 1024;

/** Classifies native token IDs in a known Qwen protocol, not tags in arbitrary text. */
export function createQwen3_5Generation({ emit, prompt, tools }: {
  emit: ({ event }: { event: InferenceGenerationEvent }) => void,
  prompt: string,
  tools: readonly WorkerToolDefinition[] | undefined,
}) {
  let phase: 'body' | 'reasoning' | 'tool_call';
  // This prefix belongs to the already-rendered input. Never infer it from an
  // effort setting or from a trimmed suffix which could hide native whitespace.
  if (prompt.endsWith(`\
<|im_start|>assistant
<think>
`)) phase = 'reasoning';
  else if (prompt.endsWith(`\
<|im_start|>assistant
<think>

</think>

`) || prompt.endsWith('<|im_start|>assistant\n')) phase = 'body';
  else throw new Error('Unsupported Qwen generation prefix.');
  let active: { index: number, kind: 'text' | 'reasoning' } | undefined;
  let nextIndex = 0;
  let thoughtHeaderPending = false;
  let thoughtNewline = false;
  let separator: { expected: string, received: string } | undefined;
  let callSeparator: string | undefined;
  let callBody = '';
  let callIndex: number | undefined;
  let completedCalls = 0;
  let terminal: 'user' | 'tool_results' | 'incomplete' | undefined;
  let settled = false;

  function assertWritable(): void {
    if (settled || terminal !== undefined) throw new Error('Qwen content arrived after completion.');
  }
  function open({ kind }: { kind: 'text' | 'reasoning' }): void {
    if (active !== undefined) throw new Error('Qwen opened overlapping content.');
    active = { index: nextIndex++, kind };
    emit({ event: { type: 'part_start', index: active.index, kind } });
  }
  function delta({ text }: { text: string }): void {
    if (!text) return;
    if (active === undefined) {
      switch (phase) {
      case 'reasoning': open({ kind: 'reasoning' }); break;
      case 'body': open({ kind: 'text' }); break;
      case 'tool_call': throw new Error('Tool argument text cannot become visible content.');
      default: { const exhaustive: never = phase; throw new Error(`Unhandled Qwen phase: ${exhaustive}`); }
      }
    }
    emit({ event: { type: 'text_delta', index: active!.index, text } });
  }
  function close({ completeness }: { completeness: 'complete' | 'partial' }): void {
    if (active !== undefined) {
      emit({ event: { type: 'part_end', index: active.index, completeness } });
      active = undefined;
    }
  }
  function flushSeparator(): void {
    const pending = separator; separator = undefined;
    if (pending !== undefined) delta({ text: pending.received });
  }
  function flushCallSeparator(): void {
    const pending = callSeparator; callSeparator = undefined;
    if (pending !== undefined) delta({ text: pending });
  }
  function flushThoughtNewline(): void {
    if (thoughtNewline) {
      thoughtNewline = false; delta({ text: '\n' });
    }
  }
  function appendCall({ text }: { text: string }): void {
    if (callBody.length + text.length > maxDraftLength) throw new Error('Qwen tool draft exceeds its size limit.');
    callBody += text;
  }

  return {
    text({ text }: { text: string }): void {
      if (!text) return;
      assertWritable();
      switch (phase) {
      case 'tool_call': appendCall({ text }); return;
      case 'reasoning':
        if (thoughtHeaderPending) {
          thoughtHeaderPending = false;
          if (text.startsWith('\n')) text = text.slice(1);
        }
        if (!text) return;
        flushThoughtNewline();
        thoughtNewline = text.endsWith('\n');
        delta({ text: thoughtNewline ? text.slice(0, -1) : text }); return;
      case 'body':
        if (callSeparator !== undefined) {
          const pending = callSeparator + text;
          if (pending === '\n') {
            callSeparator = pending; return;
          }
          callSeparator = undefined; text = pending;
        }
        if (separator !== undefined) {
          const needed = separator.expected.length - separator.received.length;
          const consumed = text.slice(0, needed);
          separator.received += consumed;
          text = text.slice(consumed.length);
          if (!separator.expected.startsWith(separator.received)) flushSeparator();
          else if (separator.received === separator.expected) separator = undefined;
          else return;
        }
        delta({ text }); return;
      default: { const exhaustive: never = phase; throw new Error(`Unhandled Qwen phase: ${exhaustive}`); }
      }
    },
    control({ token }: { token: string }): void {
      assertWritable();
      switch (phase) {
      case 'tool_call': {
        if (token === '<|im_end|>' || token === '<|endoftext|>') {
          terminal = 'incomplete'; return;
        }
        if (token !== '</tool_call>') {
          appendCall({ text: token }); return;
        }
        // A delimiter within a native parameter is data, not a second call.
        if (callBody.lastIndexOf('<parameter=') > callBody.lastIndexOf('</parameter>')) {
          appendCall({ text: token }); return;
        }
        const toolCall = parseQwen3_5NativeToolCall({ content: callBody, tools });
        emit({ event: { type: 'tool_call', index: callIndex!, toolCall } });
        completedCalls++; callIndex = undefined; callBody = ''; phase = 'body'; callSeparator = '';
        return;
      }
      case 'reasoning': {
        switch (token) {
        case '</think>':
          thoughtNewline = false; thoughtHeaderPending = false;
          if (active === undefined) open({ kind: 'reasoning' });
          close({ completeness: 'complete' }); phase = 'body';
          separator = { expected: '\n\n', received: '' }; return;
        case '<tool_call>': case '</tool_call>': case '<tool_response>': case '</tool_response>':
          thoughtHeaderPending = false; flushThoughtNewline(); delta({ text: token }); return;
        case '<|im_end|>': case '<|endoftext|>':
          flushThoughtNewline(); close({ completeness: 'partial' }); terminal = 'incomplete'; return;
        default: throw new Error('Unsupported control inside Qwen reasoning.');
        }
      }
      case 'body': break;
      default: { const exhaustive: never = phase; throw new Error(`Unhandled Qwen phase: ${exhaustive}`); }
      }
      flushSeparator();
      if (token === '<tool_call>' && callSeparator === '\n') callSeparator = undefined;
      else flushCallSeparator();
      switch (token) {
      case '<think>':
        close({ completeness: 'complete' }); phase = 'reasoning'; thoughtHeaderPending = true;
        open({ kind: 'reasoning' }); return;
      case '<tool_call>':
        if (!tools?.length) throw new Error('Qwen generated a call without tool declarations.');
        close({ completeness: 'complete' }); phase = 'tool_call'; callBody = ''; callIndex = nextIndex++;
        emit({ event: { type: 'tool_start', index: callIndex } }); return;
      case '<|im_end|>':
        if (nextIndex === 0) open({ kind: 'text' });
        close({ completeness: 'complete' }); terminal = completedCalls ? 'tool_results' : 'user'; return;
      case '<|endoftext|>':
        close({ completeness: 'partial' }); terminal = 'incomplete'; return;
      default: throw new Error('Unsupported or misplaced Qwen control token.');
      }
    },
    finish({ reason }: { reason: 'aborted' | 'limit' | 'unknown' }): void {
      if (settled) throw new Error('Qwen generation was settled twice.');
      settled = true;
      flushSeparator(); flushCallSeparator(); flushThoughtNewline(); close({ completeness: 'partial' });
      emit({ event: { type: 'result', result: terminal === undefined || terminal === 'incomplete'
        ? { type: 'interrupted', reason }
        : { type: 'finished', next: terminal } } });
    },
  };
}

export const TEST_ONLY = {
};
