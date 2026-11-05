import type { ChatMessage, ToolCall } from '@/01-models/types';
import type { MessageId } from '@/01-models/ids';
import { idToRaw } from '@/01-models/ids';
import { generateId } from '@/01-models/id';
import { readText, WORKFLOW_INPUT_LIMIT, type RuntimeMessage, type RuntimeMessagePart, type RuntimeToolResult } from './values';

/** Materialize exactly one bounded provider context. A historical tool call is
 * checked for pairing but is never dispatched by this conversion. */
export async function materializeWorkflowConversation({ messages, signal }: {
  messages: RuntimeMessage[], signal: AbortSignal,
}): Promise<{ messages: ChatMessage[], byteLength: number }> {
  if (messages.length > 256) {
    throw new Error('Conversation exceeds 256 messages.');
  }
  let byteLength = 0;
  const account = ({ text }: { text: string }): string => {
    byteLength += new TextEncoder().encode(text).byteLength;
    if (byteLength > WORKFLOW_INPUT_LIMIT) {
      throw new Error('Conversation exceeds the materialization limit.');
    }
    return text;
  };
  const read = async ({ part }: { part: RuntimeMessagePart }): Promise<string> => {
    switch (part.type) {
    case 'reasoning': case 'tool_call': case 'tool_result': throw new Error('Tool parts require a matching conversation role.');
    default: return account({ text: await readText({ value: part, maxBytes: WORKFLOW_INPUT_LIMIT, signal }) });
    }
  };
  const seen = new Set<string>();
  const pending = new Set<string>();
  const result: ChatMessage[] = [];
  for (const message of messages) {
    signal.throwIfAborted();
    if (message.parts.length > 64) {
      throw new Error('Conversation message exceeds 64 parts.');
    }
    if (pending.size && message.role !== 'tool') {
      throw new Error('A tool call must be answered before continuing the conversation.');
    }
    switch (message.role) {
    case 'system': case 'user': {
      const parts: { type: 'text', text: string, completeness: 'complete' }[] = [];
      for (const part of message.parts) {
        parts.push({ type: 'text', text: await read({ part }), completeness: 'complete' });
      }
      result.push({ id: generateId<MessageId>(), role: message.role, parts });
      break;
    }
    case 'assistant': {
      const parts: Extract<ChatMessage, { role: 'assistant' }>['parts'][number][] = [];
      for (const part of message.parts) {
        switch (part.type) {
        case 'reasoning': parts.push({ type: 'reasoning', text: account({ text: await readText({ value: part.content, maxBytes: WORKFLOW_INPUT_LIMIT, signal }) }), completeness: 'complete' });
          break;
        case 'tool_result': throw new Error('An assistant cannot supply its own tool results.');
        case 'tool_call': {
          const toolCall = workflowToolCall({ part });
          const id = idToRaw({ id: part.id });
          if (seen.has(id)) {
            throw new Error('Duplicate tool call identity in conversation.');
          }
          account({ text: id + part.name + part.arguments });
          seen.add(id);
          pending.add(id);
          parts.push({ type: 'tool_call', toolCall });
          break;
        }
        default: parts.push({ type: 'text', text: await read({ part }), completeness: 'complete' });
        }
      }
      result.push({ id: generateId<MessageId>(), role: 'assistant', parts });
      break;
    }
    case 'tool': {
      if (!message.parts.length) {
        throw new Error('A tool message must contain a result.');
      }
      const parts: Extract<ChatMessage, { role: 'tool' }>['parts'][number][] = [];
      for (const part of message.parts) {
        if (part.type !== 'tool_result' || !pending.delete(idToRaw({ id: part.id }))) {
          throw new Error('Tool results must answer a pending call exactly once.');
        }
        const content = account({ text: await readText({ value: part.content, maxBytes: WORKFLOW_INPUT_LIMIT, signal }) });
        parts.push({ type: 'tool_result', result: workflowChatToolResult({ part, content }) });
      }
      result.push({ id: generateId<MessageId>(), role: 'tool', parts });
      break;
    }
    default: {
      const exhaustive: never = message.role;
      throw new Error(String(exhaustive));
    }
    }
  }
  if (pending.size) {
    throw new Error('Conversation contains unanswered tool calls.');
  }
  return { messages: result, byteLength };
}

export function workflowToolCall({ part }: { part: { id: ToolCall['id'], name: string, arguments: string } }): ToolCall {
  if (!idToRaw({ id: part.id }).trim() || idToRaw({ id: part.id }).length > 200 || !part.name.trim() || part.name.length > 200 || new TextEncoder().encode(part.arguments).byteLength > 128 * 1024) {
    throw new Error('Invalid or excessive tool call.');
  }
  return { id: part.id, type: 'function', function: { name: part.name, arguments: part.arguments } };
}

function workflowChatToolResult({ part, content }: { part: RuntimeToolResult, content: string }): Extract<ChatMessage, { role: 'tool' }>['parts'][number]['result'] {
  switch (part.status) {
  case 'success':
    if (part.code !== undefined) {
      throw new Error('Successful tool results cannot contain an error code.');
    }
    return { toolCallId: part.id, status: 'success', content: { type: 'text', text: content } };
  case 'error':
    if (part.code === undefined) {
      throw new Error('Failed tool results require an error code.');
    }
    return { toolCallId: part.id, status: 'error', error: { code: part.code, message: { type: 'text', text: content } } };
  default: {
    const exhaustive: never = part.status;
    throw new Error(String(exhaustive));
  }
  }
}

export const TEST_ONLY = {
};
