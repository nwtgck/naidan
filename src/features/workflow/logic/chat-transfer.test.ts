import { expect, it, vi } from 'vitest';
import type { ChatMessage } from '@/01-models/types';
import { toBinaryObjectId } from '@/01-models/ids';
import { workflowFromChat } from './chat-transfer';
import { readWorkflowArchivedConversation } from './result-view';
import { copyImportedChatHistory } from '@/logic/imported-chat-history';
import { parseWorkflowDefinition, formatWorkflowDefinition } from '@/00-storage/service/workflow-json';
import { parseWorkflowModelConfiguration } from '@/00-storage/service/workflow-json';

const signal = (): AbortSignal => new AbortController().signal;

async function history(): Promise<ChatMessage[]> {
  return readWorkflowArchivedConversation({
    text: JSON.stringify([
      { role: 'user', parts: [{ type: 'text', text: 'question' }] },
      { role: 'assistant', parts: [{ type: 'reasoning', text: 'reason' }, { type: 'tool_call', id: 'old', name: 'shell_execute', arguments: '{"shell_script":"old command"}' }] },
      { role: 'tool', parts: [{ type: 'tool_result', id: 'old', status: 'success', content: 'old response' }] },
      { role: 'assistant', parts: [{ type: 'text', text: 'answer' }] },
    ]),
    signal: signal(),
  });
}

const options = () => ({
  title: 'copied chat',
  inputLabel: 'Continue',
  endpoint: { type: 'ollama' as const, url: 'http://local' },
  modelId: 'model',
  lmParameters: parseWorkflowModelConfiguration({ value: { endpoint: { type: 'ollama', url: 'http://local' }, modelId: 'model', lmParameters: {} } }).lmParameters!,
  systemPrompts: ['effective global', 'effective group'],
  signal: signal(),
  readBinaryObject: vi.fn(async () => null as Blob | null),
});

it('copies effective system messages, reasoning and tool pairs with no runnable tool capability', async () => {
  const messages = await history(), before = structuredClone(messages), settings = options();
  const definition = await workflowFromChat({ messages, ...settings });
  const normalized = parseWorkflowDefinition({ text: formatWorkflowDefinition({ definition }) });
  expect(normalized.steps.map(step => step.type)).toEqual(['request_input', 'text_generation']);
  const generation = normalized.steps[1];
  if (generation?.type !== 'text_generation' || generation.conversation.type !== 'conversation') {
    throw new Error('fixture');
  }
  expect(generation.conversation.messages.slice(0, 2)).toEqual([
    { role: 'system', parts: [{ type: 'text', text: 'effective global' }] },
    { role: 'system', parts: [{ type: 'text', text: 'effective group' }] },
  ]);
  expect(generation.conversation.messages[3]?.parts).toMatchObject([{ type: 'reasoning', text: 'reason' }, { type: 'tool_call', arguments: '{"shell_script":"old command"}' }]);
  expect(generation.toolConfigs).toEqual([]);
  expect(generation.toolExecution).toBeUndefined();
  expect(generation.systemPrompt).toBeUndefined();
  expect(generation.appendMessages).toMatchObject([{ role: 'user', parts: [{ type: 'value', value: { type: 'step_output', stepId: normalized.steps[0]!.id } }] }]);
  expect(settings.readBinaryObject).not.toHaveBeenCalled();
  expect(messages).toEqual(before);
});

it('materializes bounded blob-backed tool results and checks cancellation after the read', async () => {
  const messages = await history();
  const part = messages[2]?.parts[0];
  if (part?.type !== 'tool_result' || part.result.status !== 'success') {
    throw new Error('fixture');
  }
  part.result.content = { type: 'binary_object', id: toBinaryObjectId({ raw: 'blob' }) };
  const settings = options();
  settings.readBinaryObject.mockResolvedValue(new Blob(['full stored result']));
  const definition = await workflowFromChat({ messages, ...settings });
  expect(formatWorkflowDefinition({ definition })).toContain('full stored result');
  settings.readBinaryObject.mockResolvedValue(new Blob(['x'.repeat(2 * 1024 * 1024)]));
  await expect(workflowFromChat({ messages, ...settings })).rejects.toThrow('copy limit');
  const controller = new AbortController();
  settings.readBinaryObject.mockImplementation(async () => {
    controller.abort();
    return new Blob(['x']);
  });
  await expect(workflowFromChat({ messages, ...settings, signal: controller.signal })).rejects.toThrow();
});

it('fails rather than losing partial or executing history, or missing blob results', async () => {
  const messages = await history(), settings = options();
  const first = messages[0]?.parts[0];
  if (first?.type !== 'text') {
    throw new Error('fixture');
  }
  first.completeness = 'partial';
  await expect(workflowFromChat({ messages, ...settings })).rejects.toThrow('partial');
  first.completeness = 'complete';
  const tool = messages[2]?.parts[0];
  if (tool?.type !== 'tool_result') {
    throw new Error('fixture');
  }
  const id = tool.result.toolCallId;
  tool.result = { status: 'executing', toolCallId: id };
  await expect(workflowFromChat({ messages, ...settings })).rejects.toThrow('active tool');
  tool.result = { status: 'success', toolCallId: id, content: { type: 'binary_object', id: toBinaryObjectId({ raw: 'missing' }) } };
  await expect(workflowFromChat({ messages, ...settings })).rejects.toThrow('missing');
});

it('bounds effective prompts before opening stored result files', async () => {
  const messages = await history(), settings = options();
  await expect(workflowFromChat({ messages, ...settings, systemPrompts: ['x'.repeat(2 * 1024 * 1024 + 1)] })).rejects.toThrow('copy limit');
  expect(settings.readBinaryObject).not.toHaveBeenCalled();
});

it('snapshots the source while awaiting external data', async () => {
  const messages = await history(), settings = options();
  const part = messages[2]?.parts[0];
  if (part?.type !== 'tool_result' || part.result.status !== 'success') {
    throw new Error('fixture');
  }
  part.result.content = { type: 'binary_object', id: toBinaryObjectId({ raw: 'blob' }) };
  const gate = Promise.withResolvers<Blob>();
  using owner = { gate, [Symbol.dispose]: () => gate.resolve(new Blob(['content'])) };
  settings.readBinaryObject.mockImplementation(async () => owner.gate.promise);
  const pending = workflowFromChat({ messages, ...settings });
  await vi.waitFor(() => expect(settings.readBinaryObject).toHaveBeenCalled());
  messages.splice(0);
  settings.endpoint.url = 'http://changed';
  settings.systemPrompts.splice(0);
  gate.resolve(new Blob(['content']));
  const definition = await pending;
  expect(formatWorkflowDefinition({ definition })).toContain('effective global');
  expect(formatWorkflowDefinition({ definition })).toContain('http://local');
  expect(formatWorkflowDefinition({ definition })).not.toContain('http://changed');
});

it('builds an independent normal-chat tree without carrying old IDs or aliases', async () => {
  const messages = await history();
  const original = structuredClone(messages);
  const copied = copyImportedChatHistory({ messages });
  const nodes = [];
  let next = copied.root.items[0];
  while (next) {
    nodes.push(next);
    next = next.replies.items[0];
  }
  expect(nodes.map(node => node.role)).toEqual(messages.map(message => message.role));
  expect(nodes.map(node => node.id).some(id => messages.some(message => message.id === id))).toBe(false);
  expect(copied.currentLeafId).toBe(nodes.at(-1)?.id);
  expect(nodes[1]?.parts).toEqual(messages[1]?.parts);
  nodes[1]!.parts.splice(0);
  expect(messages).toEqual(original);
});

export const TEST_ONLY = {
};
