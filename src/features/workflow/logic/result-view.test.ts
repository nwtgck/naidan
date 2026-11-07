import { expect, it, vi } from 'vitest';
import { createWorkflowTestFileSystem } from '@/00-storage/service/workflow-files.test-support';
import { toToolCallId } from '@/01-models/ids';
import { copyImportedChatHistory } from '@/logic/imported-chat-history';
import { createOutputStoreFixture } from './output-store.test-support';
import { workflowResultSources, archivedWorkflowResultSources, readWorkflowArchivedConversation, TEST_ONLY } from './result-view';
import { exportWorkflowResults } from './files';
import { spoolText, releaseValue, type RuntimeValue } from './values';
import { stepId } from './workflow.test-support';
import type { WorkflowRunResult } from './runtime';
import { imageResult } from './image-generation.test-support';

vi.mock('@/00-storage/service', () => ({ storageService: {} }));

const signal = (): AbortSignal => new AbortController().signal;

const result = ({ outputs }: { outputs: Record<string, RuntimeValue> }): WorkflowRunResult => ({ status: 'completed', error: undefined, outputs: new Map([[stepId({ raw: 'source' }), outputs]]), release: async () => undefined });

it('exports a conversation and opens its exact archive through the bounded reader without executing historical calls', async () => {
  using fs = createWorkflowTestFileSystem();
  const id = toToolCallId({ raw: 'past-call' });
  const value: RuntimeValue = {
    type: 'conversation',
    messages: [
      { role: 'assistant', parts: [{ type: 'reasoning', content: { type: 'json', value: 'thought' } }, { type: 'tool_call', id, name: 'shell_execute', arguments: '{"script":"never rerun"}' }] },
      { role: 'tool', parts: [{ type: 'tool_result', id, status: 'success', code: undefined, content: { type: 'json', value: 'historical result' } }] },
    ],
  };
  await exportWorkflowResults({ result: result({ outputs: { conversation: value, text: { type: 'json', value: '<script>not executable</script>' } } }), directory: fs.root, signal: signal(), writtenFiles: [] });
  const sources = await archivedWorkflowResultSources({ directory: fs.root, signal: signal() });
  expect(sources).toHaveLength(2);
  const view = await sources[0]!.load({ signal: signal() });
  expect(view.type).toBe('conversation');
  if (view.type !== 'conversation') {
    throw new Error('fixture');
  }
  expect(view.messages[0]?.parts).toMatchObject([{ type: 'reasoning', text: 'thought' }, { type: 'tool_call', toolCall: { function: { name: 'shell_execute', arguments: '{"script":"never rerun"}' } } }]);
  expect(view.messages[1]?.parts).toMatchObject([{ type: 'tool_result', result: { status: 'success', content: { type: 'text', text: 'historical result' } } }]);
  expect(await sources[1]!.load({ signal: signal() })).toEqual({ type: 'text', text: '"<script>not executable</script>"' });
});

it.each(['../secret.txt', '/result-0000.txt', 'result-0000xpng', 'result-0000\\.png', 'a/result-0000.png', 'result-0000.svg', 'result-0000.html'])('rejects an archive path %s before loading it', async path => {
  using fs = createWorkflowTestFileSystem();
  fs.setText({ path: 'index.json', text: JSON.stringify({ outputs: [{ stepId: 'x', output: 'y', path }] }) });
  await expect(archivedWorkflowResultSources({ directory: fs.root, signal: signal() })).rejects.toThrow();
  expect(fs.calls.some(call => call.includes('secret'))).toBe(false);
});

it('keeps old JSON archives as ordinary text and skips unknown binary/streaming outputs', async () => {
  using fs = createWorkflowTestFileSystem();
  fs.setText({ path: 'index.json', text: JSON.stringify({ outputs: ['json', 'bin', 'jsonl'].map(extension => ({ stepId: 'x', output: extension, path: `result-0000.${extension}` })) }) });
  fs.setText({ path: 'result-0000.json', text: '[{"role":"assistant","parts":[]}]' });
  const sources = await archivedWorkflowResultSources({ directory: fs.root, signal: signal() });
  expect(sources).toHaveLength(1);
  expect((await sources[0]!.load({ signal: signal() })).type).toBe('text');
});

it('rejects a corrupt image rather than letting an archive header allocate an unlimited surface', async () => {
  using fs = createWorkflowTestFileSystem();
  fs.setText({ path: 'index.json', text: '{"outputs":[{"stepId":"i","output":"image","path":"result-0000.png"}]}' });
  const valid = imageResult({ width: 32, height: 24, compression: 'small' }).png;
  fs.files.set('result-0000.png', new Uint8Array(await valid.arrayBuffer()));
  const sources = await archivedWorkflowResultSources({ directory: fs.root, signal: signal() });
  const view = await sources[0]!.load({ signal: signal() });
  expect(view.type).toBe('image');
  const changed = new Uint8Array(await valid.arrayBuffer());
  new DataView(changed.buffer).setUint32(16, 100000);
  fs.files.set('result-0000.png', changed);
  await expect(sources[0]!.load({ signal: signal() })).rejects.toThrow();
});

it('bounds index and textual result sizes before decoding', async () => {
  using fs = createWorkflowTestFileSystem();
  fs.setText({ path: 'index.json', text: ' '.repeat(TEST_ONLY.textLimit + 1) });
  await expect(archivedWorkflowResultSources({ directory: fs.root, signal: signal() })).rejects.toThrow('index');
  fs.setText({ path: 'index.json', text: '{"outputs":[{"stepId":"i","output":"text","path":"result-0000.txt"}]}' });
  fs.setText({ path: 'result-0000.txt', text: 'a'.repeat(TEST_ONLY.textLimit + 1) });
  const sources = await archivedWorkflowResultSources({ directory: fs.root, signal: signal() });
  await expect(sources[0]!.load({ signal: signal() })).rejects.toThrow('display limit');
});

it('copies an archived conversation into an independent chat tree without retaining message IDs or aliases', async () => {
  const messages = await readWorkflowArchivedConversation({
    text: JSON.stringify([
      { role: 'user', parts: [{ type: 'text', text: 'question' }] },
      { role: 'assistant', parts: [{ type: 'reasoning', text: 'reason' }, { type: 'tool_call', id: 'old', name: 'shell_execute', arguments: '{"shell_script":"old command"}' }] },
      { role: 'tool', parts: [{ type: 'tool_result', id: 'old', status: 'success', content: 'old response' }] },
      { role: 'assistant', parts: [{ type: 'text', text: 'answer' }] },
    ]),
    signal: signal(),
  });
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

it('does not reveal model settings through the generic result viewer', () => {
  const model: RuntimeValue = { type: 'model', endpoint: { type: 'openai', url: 'https://private', httpHeaders: [['Authorization', 'secret']] }, modelId: 'private' };
  expect(workflowResultSources({ result: result({ outputs: { model, wrapped: { type: 'object', properties: { model } }, text: { type: 'json', value: 'visible' } } }) }).map(source => source.label)).toEqual(['source / text']);
});

it('retains live file leases only during display loading, including errors and cancellation', async () => {
  await using fixture = createOutputStoreFixture({ limits: {} });
  const value = await spoolText({
    store: fixture.store,
    signal: signal(),
    chunks: (async function* () {
      yield 'hello';
    })(),
  });
  const source = workflowResultSources({ result: result({ outputs: { text: value } }) })[0]!;
  expect(await source.load({ signal: signal() })).toEqual({ type: 'text', text: 'hello' });
  fixture.failNext({ operation: 'read', error: new Error('unavailable') });
  await expect(source.load({ signal: signal() })).rejects.toThrow('unavailable');
  const controller = new AbortController();
  controller.abort();
  await expect(source.load({ signal: controller.signal })).rejects.toThrow();
  await releaseValue({ value });
  expect(fixture.store.getUsage().entries).toBe(0);
});

it('rejects malformed, unanswered, oversized or aborted conversation archives', async () => {
  await expect(readWorkflowArchivedConversation({ text: '[{"role":"assistant","parts":[{"type":"tool_call","id":"c","name":"x","arguments":"{}"}]}]', signal: signal() })).rejects.toThrow();
  await expect(readWorkflowArchivedConversation({ text: ' '.repeat(TEST_ONLY.textLimit + 1), signal: signal() })).rejects.toThrow('display limit');
  const controller = new AbortController();
  controller.abort();
  await expect(readWorkflowArchivedConversation({ text: '[]', signal: controller.signal })).rejects.toThrow();
});
