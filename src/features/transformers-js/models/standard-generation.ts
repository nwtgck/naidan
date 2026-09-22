/* eslint-disable no-restricted-imports -- Worker-only framing uses the active Transformers.js generation config and tokenizer. */
import type { PreTrainedModel, PreTrainedTokenizer } from '@huggingface/transformers';
import { z } from 'zod';
import { generateId } from '@/01-models/id';
import type { ToolCallId } from '@/01-models/ids';
import type { ToolCall } from '@/01-models/types';
import type { InferenceGenerationEvent } from '@/features/transformers-js/generation-events';
import type { WorkerToolDefinition } from '@/features/transformers-js/types';
import {
  DELIMITED_PYTHONIC_TOOL_CALL_OPEN,
  DELIMITED_PYTHONIC_TOOL_CALL_CLOSE,
  parseDelimitedPythonicToolCallPayload,
} from '@/features/transformers-js/delimited-pythonic-tool-call-parser';
import { validateStandardToolCallsForHandling, type StandardToolHandling } from '@/features/transformers-js/standard-tool-call-protocol';

const tokenId = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const maxToolDraftLength = 64 * 1024;

/** Use the same generation-config precedence as the actual native generate call.
 * A tokenizer EOS label or EOF by itself is not a confirmed model terminator.
 */
export function resolveStandardGenerationFraming({ model, tokenizer, inputs, handling, tools }: {
  model: PreTrainedModel,
  tokenizer: PreTrainedTokenizer,
  inputs: Record<string, unknown>,
  handling: StandardToolHandling,
  tools: readonly WorkerToolDefinition[] | undefined,
}): { endTokens: string[], protocolTokens: string[] } {
  const config = model._prepare_generation_config(null, inputs);
  const raw = config.eos_token_id;
  const ids = raw === null || raw === undefined ? [] : z.array(tokenId).parse(Array.isArray(raw) ? raw : [raw]);
  const endTokens = [...new Set(ids)].map(id => {
    const token = tokenizer.decode([id], { skip_special_tokens: false });
    const encoded = tokenizer.encode(token, { add_special_tokens: false });
    if (token.length === 0 || encoded.length !== 1 || encoded[0] !== id) throw new Error('The standard generation terminator is not an unambiguous atomic token.');
    return token;
  });
  const protocolTokens = [...endTokens];
  if (tools?.length) {
    // A guessed JSON-tagged fallback is not proof that the model supports a
    // native tool boundary. Keep that legacy route separate until reviewed.
    switch (handling.outputProtocol) {
    case 'delimited-pythonic': break;
    case 'json-tagged': throw new Error('This standard tool protocol has no structured generation adapter.');
    default: { const exhaustive: never = handling.outputProtocol; throw new Error(`Unhandled standard tool framing: ${String(exhaustive)}`); }
    }
    for (const token of [DELIMITED_PYTHONIC_TOOL_CALL_OPEN, DELIMITED_PYTHONIC_TOOL_CALL_CLOSE]) {
      if (endTokens.includes(token)) throw new Error('A tool boundary cannot also be a model terminator.');
      const encoded = tokenizer.encode(token, { add_special_tokens: false });
      if (encoded.length !== 1 || encoded[0] === tokenizer.unk_token_id || tokenizer.decode(encoded, { skip_special_tokens: false }) !== token) {
        throw new Error('Structured standard tools require atomic native delimiters.');
      }
      protocolTokens.push(token);
    }
  }
  return { endTokens, protocolTokens };
}

/** Plain native text and the verified delimited-Pythonic tool protocol.
 * Unrecognized control channels fail rather than being normalized into text.
 */
export function createStandardGeneration({ emit, endTokens, handling, tools }: {
  emit: ({ event }: { event: InferenceGenerationEvent }) => void,
  endTokens: readonly string[],
  handling: StandardToolHandling,
  tools: readonly WorkerToolDefinition[] | undefined,
}) {
  const endings = new Set(endTokens);
  const allowedTools = new Set(tools?.map(tool => tool.function.name));
  let nextIndex = 0;
  let activeText: number | undefined;
  let draft: { index: number, text: string } | undefined;
  let assistantText = '';
  let firstPostCallTextIndex: number | undefined;
  const completedCalls: ToolCall[] = [];
  let terminal: 'user' | 'tool_results' | 'incomplete' | undefined;
  let settled = false;

  function assertOpen(): void {
    if (terminal !== undefined || settled) throw new Error('Standard content arrived after generation settlement.');
  }
  function openText(): void {
    if (activeText !== undefined) return;
    activeText = nextIndex++;
    emit({ event: { type: 'part_start', index: activeText, kind: 'text' } });
  }
  function closeText({ completeness }: { completeness: 'complete' | 'partial' }): void {
    if (activeText === undefined) return;
    emit({ event: { type: 'part_end', index: activeText, completeness } });
    activeText = undefined;
  }
  return {
    text({ text }: { text: string }): void {
      if (!text.length) return;
      assertOpen();
      if (draft !== undefined) {
        if (draft.text.length + text.length > maxToolDraftLength) throw new Error('Standard tool draft exceeds its size limit.');
        draft.text += text;
        return;
      }
      openText(); assistantText += text;
      if (completedCalls.length > 0 && firstPostCallTextIndex === undefined) firstPostCallTextIndex = activeText;
      emit({ event: { type: 'text_delta', index: activeText!, text } });
    },
    control({ token }: { token: string }): void {
      assertOpen();
      if (endings.has(token)) {
        if (draft !== undefined) {
          terminal = 'incomplete'; return;
        }
        if (nextIndex === 0) openText();
        closeText({ completeness: 'complete' });
        terminal = completedCalls.length ? 'tool_results' : 'user';
        return;
      }
      switch (token) {
      case DELIMITED_PYTHONIC_TOOL_CALL_OPEN:
        if (!tools?.length || handling.outputProtocol !== 'delimited-pythonic') throw new Error('Standard tool call has no admitted declarations and framing.');
        if (draft !== undefined) throw new Error('Standard tool calls must not nest.');
        closeText({ completeness: 'complete' });
        draft = { index: nextIndex++, text: '' };
        emit({ event: { type: 'tool_start', index: draft.index } });
        return;
      case DELIMITED_PYTHONIC_TOOL_CALL_CLOSE: {
        if (draft === undefined) throw new Error('Standard tool close has no open call.');
        const parsed = parseDelimitedPythonicToolCallPayload({ content: draft.text });
        if (!parsed?.length || parsed.some(call => !allowedTools.has(call.name))) throw new Error('Invalid or undeclared native standard tool call.');
        const calls: ToolCall[] = parsed.map(call => ({ id: generateId<ToolCallId>(), type: 'function',
          function: { name: call.name, arguments: JSON.stringify(call.arguments) },
        }));
        // The native payload is not JSON. Its parsed values are mapped to the
        // existing tool contract only after the real closing token arrives.
        validateStandardToolCallsForHandling({ toolCalls: [...completedCalls, ...calls], handling, assistantContent: assistantText });
        for (const [offset, toolCall] of calls.entries()) {
          const index = offset === 0 ? draft.index : nextIndex++;
          if (offset > 0) emit({ event: { type: 'tool_start', index } });
          emit({ event: { type: 'tool_call', index, toolCall } });
          completedCalls.push(toolCall);
        }
        draft = undefined;
        return;
      }
      default: throw new Error('This standard native control requires a model-specific output adapter.');
      }
    },
    finish({ reason }: { reason: 'aborted' | 'limit' | 'unknown' }): void {
      if (settled) throw new Error('Standard generation was settled twice.');
      settled = true;
      closeText({ completeness: 'partial' });
      // Keep the generated order, but do not execute a tool and discover only
      // afterwards that the next request cannot represent this accepted text.
      if (terminal === 'tool_results' && firstPostCallTextIndex !== undefined) {
        throw new Error('The standard input adapter cannot represent text after a tool call.');
      }
      emit({ event: { type: 'result', result: terminal === undefined || terminal === 'incomplete'
        ? { type: 'interrupted', reason }
        : { type: 'finished', next: terminal } } });
    },
  };
}

export const TEST_ONLY = {
};
