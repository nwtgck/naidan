import type { AssistantMessageNode, MessageNode } from '@/01-models/types';
import { stripNaidanSentinels } from '@/utils/image-generation';
import { getMessagePartDisplayKey } from './message-part-display-key';

export type AssistantDisplayPart =
  | { type: 'text', key: string, text: string }
  | { type: 'reasoning', key: string, text: string, completeness: 'complete' | 'partial' }
  | { type: 'tool_call', key: string, toolCall: Extract<AssistantMessageNode['parts'][number], { type: 'tool_call' }>['toolCall'] };

/** Read-only display interpretation. Stored text and model requests never use this projection. */
export function splitDisplayedThinking({ text }: { text: string }): {
  type: 'text' | 'reasoning', text: string, offset: number, completeness: 'complete' | 'partial',
}[] {
  const result: ReturnType<typeof splitDisplayedThinking> = [];
  let fence: { character: string, length: number } | undefined;
  let inlineTicks = 0;
  let start = 0;
  let reasoningStart: number | undefined;
  const tokens = /^ {0,3}(?:`{3,}|~{3,})[^\n]*(?:\n|$)|`+|<\/?think>/gim;
  for (const match of text.matchAll(tokens)) {
    const token = match[0]; const index = match.index;
    if (/^ {0,3}(?:`{3,}|~{3,})/.test(token)) {
      const marker = token.trimStart().match(/^(`+|~+)/)?.[0];
      if (!marker) continue;
      if (!fence) fence = { character: marker[0]!, length: marker.length };
      else if (marker[0] === fence.character && marker.length >= fence.length && token.trim() === marker) fence = undefined;
      continue;
    }
    if (fence) continue;
    if (token.startsWith('`')) {
      if (inlineTicks === 0) inlineTicks = token.length;
      else if (inlineTicks === token.length) inlineTicks = 0;
      continue;
    }
    if (inlineTicks) continue;
    let escapes = 0;
    for (let before = index - 1; before >= 0 && text[before] === '\\'; before--) escapes++;
    if (escapes % 2) continue;
    switch (token.toLowerCase()) {
    case '<think>':
      if (reasoningStart !== undefined) continue;
      if (index > start) result.push({ type: 'text', text: text.slice(start, index), offset: start, completeness: 'complete' });
      reasoningStart = index; start = index + token.length;
      break;
    case '</think>':
      if (reasoningStart === undefined) continue;
      result.push({ type: 'reasoning', text: text.slice(start, index), offset: reasoningStart, completeness: 'complete' });
      reasoningStart = undefined; start = index + token.length;
      break;
    default: throw new Error('Unexpected thinking delimiter.');
    }
  }
  if (reasoningStart !== undefined) result.push({ type: 'reasoning', text: text.slice(start), offset: reasoningStart, completeness: 'partial' });
  else if (start < text.length || result.length === 0) result.push({ type: 'text', text: text.slice(start), offset: start, completeness: 'complete' });
  return result;
}

export function getAssistantDisplayParts({ message }: { message: AssistantMessageNode }): AssistantDisplayPart[] {
  return message.parts.flatMap((part): AssistantDisplayPart[] => {
    const partKey = getMessagePartDisplayKey({ part });
    switch (part.type) {
    case 'text': return splitDisplayedThinking({ text: part.text }).map(piece => {
      const key = JSON.stringify([partKey, piece.offset]);
      switch (piece.type) {
      case 'text': return { type: 'text', key, text: stripNaidanSentinels({ content: piece.text }) };
      case 'reasoning': return { type: 'reasoning', key, text: piece.text, completeness: piece.completeness };
      default: { const _ex: never = piece.type; throw new Error(`Unhandled display segment: ${_ex}`); }
      }
    });
    case 'reasoning': return [{ type: 'reasoning', key: partKey, text: part.text, completeness: part.completeness }];
    case 'tool_call': return [{ type: 'tool_call', key: partKey, toolCall: part.toolCall }];
    default: { const _ex: never = part; throw new Error(`Unhandled assistant part: ${_ex}`); }
    }
  });
}

/** Aggregate visible body text only for consumers that do not show per-part flow. */
export function getDisplayedMessageText({ message }: { message: MessageNode }): string {
  switch (message.role) {
  case 'assistant': return getAssistantDisplayParts({ message }).flatMap(part => {
    switch (part.type) {
    case 'text': return [part.text];
    case 'reasoning':
    case 'tool_call': return [];
    default: { const _ex: never = part; throw new Error(`Unhandled display part: ${_ex}`); }
    }
  }).join('');
  case 'user': return message.parts.flatMap(part => {
    switch (part.type) {
    case 'text': return [stripNaidanSentinels({ content: part.text })];
    case 'attachment': return [];
    default: { const _ex: never = part; throw new Error(`Unhandled user part: ${_ex}`); }
    }
  }).join('');
  case 'system': return message.parts.map(part => stripNaidanSentinels({ content: part.text })).join('');
  case 'tool': return '';
  default: { const _ex: never = message; throw new Error(`Unhandled message: ${_ex}`); }
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
export const TEST_ONLY = {
};
