import { it, expect } from 'vitest';
import { toToolCallId } from '@/01-models/ids';
import type { RuntimeMessage } from './values';
import { materializeWorkflowConversation } from './conversation';

const callId = toToolCallId({ raw: 'original' });

function history(): RuntimeMessage[] {
  return [
    { role: 'system', parts: [{ type: 'json', value: 'rules' }] },
    { role: 'user', parts: [{ type: 'json', value: 'question' }] },
    { role: 'assistant', parts: [{ type: 'reasoning', content: { type: 'json', value: 'thought' } }, { type: 'tool_call', id: callId, name: 'past_tool', arguments: '{ malformed but historical' }] },
    { role: 'tool', parts: [{ type: 'tool_result', id: callId, status: 'error', code: 'invalid_arguments', content: { type: 'json', value: 'explanation' } }] },
  ];
}

const materialize = ({ messages }: { messages: RuntimeMessage[] }) => materializeWorkflowConversation({ messages, signal: new AbortController().signal });

it('preserves raw past calls, reasoning and error records without requiring a current tool', async () => {
  const result = await materialize({ messages: history() });
  expect(result.messages[2]).toMatchObject({ role: 'assistant', parts: [{ type: 'reasoning', text: 'thought' }, { type: 'tool_call', toolCall: { id: callId, function: { name: 'past_tool', arguments: '{ malformed but historical' } } }] });
  expect(result.messages[3]).toMatchObject({ role: 'tool', parts: [{ result: { status: 'error', error: { code: 'invalid_arguments', message: { text: 'explanation' } } } }] });
});

it.each(['missing', 'extra', 'wrong-id', 'duplicate', 'wrong-role', 'successful-code', 'missing-code'] as const)('rejects %s historical tool records', async fault => {
  const messages = history();
  const part = messages[3]!.parts[0]!;
  if (part.type !== 'tool_result') {
    throw new Error('fixture');
  }
  switch (fault) {
  case 'missing': messages.pop();
    break;
  case 'extra': messages.push(structuredClone(messages[3]!));
    break;
  case 'wrong-id': part.id = toToolCallId({ raw: 'other' });
    break;
  case 'duplicate': messages.push(structuredClone(messages[2]!), structuredClone(messages[3]!));
    break;
  case 'wrong-role': messages[3]!.role = 'assistant';
    break;
  case 'successful-code': part.status = 'success';
    break;
  case 'missing-code': part.code = undefined;
    break;
  default: {
    const exhaustive: never = fault;
    throw new Error(String(exhaustive));
  }
  }
  await expect(materialize({ messages })).rejects.toThrow();
});

it.each(['messages', 'parts', 'bytes', 'id', 'arguments'] as const)('bounds conversation %s before inference', async kind => {
  const messages = history();
  switch (kind) {
  case 'messages': messages.unshift(...Array.from({ length: 257 }, (): RuntimeMessage => ({ role: 'system', parts: [] })));
    break;
  case 'parts': messages[0]!.parts = Array.from({ length: 65 }, () => ({ type: 'json' as const, value: '' }));
    break;
  case 'bytes': messages[0]!.parts = [{ type: 'json', value: 'x'.repeat(2 * 1024 * 1024) }];
    break;
  case 'id': {
    const part = messages[2]!.parts[1]!;
    if (part.type !== 'tool_call') {
      throw new Error('fixture');
    }
    part.id = toToolCallId({ raw: 'x'.repeat(201) });
    break;
  }
  case 'arguments': {
    const part = messages[2]!.parts[1]!;
    if (part.type !== 'tool_call') {
      throw new Error('fixture');
    }
    part.arguments = 'x'.repeat(128 * 1024 + 1);
    break;
  }
  default: {
    const exhaustive: never = kind;
    throw new Error(String(exhaustive));
  }
  }
  await expect(materialize({ messages })).rejects.toThrow();
});

it('rejects reasoning attached to a user instead of silently converting its role', async () => {
  await expect(materialize({ messages: [{ role: 'user', parts: [{ type: 'reasoning', content: { type: 'json', value: 'thought' } }] }] })).rejects.toThrow('role');
});

export const TEST_ONLY = {
};
