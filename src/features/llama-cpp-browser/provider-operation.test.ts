import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { LmProvider } from '@/01-models/lm';
import type { Tool } from '@/01-models/tool';
import { collectChatGeneration } from '@/logic/collect-chat-generation';
import { ensureAllStringsForTest } from '@/strings/test-utils';
import type { LlamaCppBrowserService } from './service-contract';
import type { LlamaCppWorkerClient } from './worker/types';
import { LlamaCppBrowserError } from './types';
import { createLlamaCppProvider } from './provider-hosted';
import { chatRequest, createChatFixture, deliverNativeResult, finalText } from './test-utils/chat';

const worker = vi.hoisted(() => ({ subscribeDisposed: vi.fn<LlamaCppWorkerClient['subscribeDisposed']>(), probeProfiles: vi.fn<LlamaCppWorkerClient['probeProfiles']>(), generate: vi.fn<LlamaCppWorkerClient['generate']>(), canReuse: vi.fn(() => true), dispose: vi.fn() }));
const factory = vi.hoisted(() => vi.fn(() => worker));
vi.mock('@/features/llama-cpp-browser/worker/client', () => ({ createLlamaCppWorkerClient: factory }));
vi.mock('./runtime/model-store', () => ({ listStoredModels: async () => [], removeStoredModel: vi.fn(), withModelMutationLock: async ({ operation }: { operation: () => Promise<unknown> }) => operation() }));
let service: LlamaCppBrowserService;
let provider: LmProvider;
beforeEach(async () => {
  vi.resetModules();vi.clearAllMocks();await ensureAllStringsForTest({ locale: 'en' });worker.canReuse.mockReturnValue(true);
  worker.subscribeDisposed.mockReturnValue(() => {});
  worker.probeProfiles.mockResolvedValue({ recommended: 'cpu-wasm32', profiles: [{ profile: 'cpu-wasm32', status: 'available' }, { profile: 'cpu-wasm64', status: 'available' }] });
  worker.generate.mockImplementation(async ({ onEvent }) => deliverNativeResult({ result: finalText({ text: 'answer' }), onEvent }));
  service = (await import('./index-hosted')).llamaCppBrowserService;
  provider = createLlamaCppProvider({ service });
});
afterEach(() => {
  service.release();
});
function firstToolCall(): void {
  worker.generate.mockImplementationOnce(async ({ onEvent }) => deliverNativeResult({ result: { content: '', reasoningContent: 'Check the tool.\n', finishReason: 'stop', toolCalls: [{ id: 'c1', type: 'function', function: { name: 'lookup', arguments: '{}' } }] }, onEvent }));
}
function queuedRequest() {
  return { model: 'local.gguf', messages: [{ role: 'user' as const, content: 'queued' }], temperature: 0, topP: 1, presencePenalty: 0, frequencyPenalty: 0, stop: [] };
}
describe('llama.cpp public generation across the real owned service lane', () => {
  it('keeps profile and Worker ownership through a common tool wait before admitting another request', async () => {
    service.setOptions({ options: { profile: 'cpu-wasm32' } });firstToolCall();
    const entered = Promise.withResolvers<void>();const release = Promise.withResolvers<void>();
    const fixture = createChatFixture({ approvalContext: undefined, provider, request: chatRequest(), tools: [{ name: 'lookup', description: '', parametersSchema: z.object({}), execute: async () => {
      entered.resolve();await release.promise;return { status: 'success', content: 'tool result' };
    } }], controller: new AbortController(), onToolEvent: () => {} });
    const running = fixture.run();await entered.promise;
    service.setOptions({ options: { profile: 'cpu-wasm64' } });
    const queued = service.generate({ input: queuedRequest(), onEvent: () => {}, signal: undefined });
    expect(worker.generate).toHaveBeenCalledOnce();expect(factory).toHaveBeenCalledOnce();
    release.resolve();expect(await running).toEqual({ type: 'finished', next: 'user' });await queued;
    expect(worker.generate.mock.calls.map(([{ request }]) => request.options.profile)).toEqual(['cpu-wasm32', 'cpu-wasm32', 'cpu-wasm64']);
    expect(worker.generate.mock.calls[1]?.[0].request.messages.map(m => m.role)).toEqual(['user', 'assistant', 'tool']);
    expect(worker.generate.mock.calls[1]?.[0].request.messages[1]?.reasoning_content).toBe('Check the tool.\n');
    expect(fixture.nodes.map(n => n.role)).toEqual(['assistant', 'tool', 'assistant']);expect(factory).toHaveBeenCalledOnce();
  });
  it.each(['cancel', 'release'] as const)('suppresses late tool output on %s, but retains its observed success and holds the lane until it settles', async action => {
    firstToolCall();const entered = Promise.withResolvers<void>();const release = Promise.withResolvers<void>();let toolSignal: AbortSignal | undefined;
    let notify: Parameters<Tool['execute']>[0]['onEvent'];const onToolEvent = vi.fn();
    const fixture = createChatFixture({ approvalContext: undefined, provider, request: chatRequest(), tools: [{ name: 'lookup', description: '', parametersSchema: z.object({}), execute: async ({ signal, onEvent }) => {
      toolSignal = signal;notify = onEvent;entered.resolve();await release.promise;await onEvent?.({ event: { type: 'output', stream: 'stdout', text: 'late tool progress' } });return { status: 'success', content: 'observed side effect' };
    } }], controller: new AbortController(), onToolEvent });
    const result = fixture.run().then(value => ({ value }), error => ({ error }));await entered.promise;
    switch (action) {
    case 'cancel': service.cancel();break;case 'release': service.release();break;default: { const exhaustive: never = action;throw new Error(`Unknown action: ${exhaustive}`); }
    }
    expect(toolSignal?.aborted).toBe(true);
    const queued = service.generate({ input: queuedRequest(), onEvent: () => {}, signal: undefined });
    expect(worker.generate).toHaveBeenCalledOnce();release.resolve();expect(await result).toHaveProperty('error');await queued;
    expect(onToolEvent).not.toHaveBeenCalled();expect(fixture.nodes).toHaveLength(2);
    expect(fixture.nodes[1]?.parts[0]).toMatchObject({ type: 'tool_result', result: { status: 'success', content: { text: 'observed side effect' } } });
    await notify?.({ event: { type: 'output', stream: 'stdout', text: 'after operation exit' } });expect(onToolEvent).not.toHaveBeenCalled();
    expect(worker.generate).toHaveBeenCalledTimes(2);expect(factory).toHaveBeenCalledTimes(action === 'release' ? 2 : 1);
  });
  it('reports an observed model failure once and retires the failed runtime even when the consumer records it as a result', async () => {
    worker.generate.mockImplementationOnce(async ({ onEvent }) => {
      await onEvent({ event: { type: 'text', text: 'received' } });throw new LlamaCppBrowserError({ code: 'worker-failed' });
    });
    const fixture = createChatFixture({ approvalContext: undefined, provider, request: chatRequest(), tools: [], controller: new AbortController(), onToolEvent: () => {} });
    expect((await fixture.run()).type).toBe('error');expect(fixture.nodes).toHaveLength(1);expect(fixture.nodes[0]?.parts[0]).toMatchObject({ text: 'received', completeness: 'partial' });
    expect(worker.dispose).toHaveBeenCalledOnce();expect(service.getState()).toEqual({ status: 'error', code: 'worker-failed' });
    await collectChatGeneration({ items: provider.chat(chatRequest()), abortController: new AbortController() });expect(factory).toHaveBeenCalledTimes(2);
  });
  it('aborts and awaits a blocked native generation when an operation returns with an unread child', async () => {
    let ended = false;
    worker.generate.mockImplementationOnce(async ({ onEvent, signal }) => {
      try {
        for (let i = 0; i < 50; i++) await onEvent({ event: { type: 'text', text: 'A' } });return finalText({ text: 'A'.repeat(50) });
      } catch (error) {
        if (signal?.aborted) throw new LlamaCppBrowserError({ code: 'aborted' });
        throw error;
      } finally {
        ended = true;
      }
    });
    await provider.runChatOperation!({ signal: undefined, operation: async ({ chat }) => {
      const reader = chat(chatRequest())[Symbol.asyncIterator]();const first = await reader.next();expect(first.done).toBe(false);expect(ended).toBe(false);
    } });
    expect(ended).toBe(true);expect(service.getState()).toEqual({ status: 'idle' });
    await service.generate({ input: queuedRequest(), onEvent: () => {}, signal: undefined });expect(factory).toHaveBeenCalledOnce();
  });
  it('rejects a stored scoped generator after its operation releases the lane', async () => {
    let escaped: LlamaCppBrowserService['generate'] | undefined;
    await service.runGenerationOperation({ signal: undefined, operation: async ({ scope }) => {
      escaped = scope.generate;
    } });
    expect(() => escaped!({ input: queuedRequest(), onEvent: () => {}, signal: undefined })).toThrow('closed');expect(worker.generate).not.toHaveBeenCalled();
  });
  it('handles an already-aborted scoped request without leaving a stale pending request at close', async () => {
    await service.runGenerationOperation({ signal: undefined, operation: async ({ scope }) => {
      await expect(scope.generate({ input: queuedRequest(), onEvent: () => {}, signal: AbortSignal.abort() })).rejects.toThrow('aborted');
    } });
    expect(worker.generate).not.toHaveBeenCalled();expect(service.getState()).toEqual({ status: 'idle' });
    await service.generate({ input: queuedRequest(), onEvent: () => {}, signal: undefined });expect(worker.generate).toHaveBeenCalledOnce();
  });
});

it('preserves common generated parts and the next native request through real memory storage', async () => {
  const { MemoryStorageProvider } = await import('@/00-storage/service/memory-storage');
  const { toChatId, toMessageId } = await import('@/01-models/ids');
  const { buildChatGenerationMessages } = await import('@/logic/build-chat-generation-messages');
  const { prepareLlamaCppRequest } = await import('./message-projection');
  firstToolCall();
  const request = chatRequest();
  const fixture = createChatFixture({ provider, request, tools: [{ name: 'lookup', description: '', parametersSchema: z.object({}), execute: async () => ({ status: 'success', content: '  result\r\n' }) }], controller: new AbortController(), onToolEvent: () => {}, approvalContext: undefined });
  expect((await fixture.run()).type).toBe('finished');
  const user: import('@/01-models/types').UserMessageNode = { id: toMessageId({ raw: 'u' }), role: 'user', parts: [{ id: 'p', type: 'text', text: 'hello', completeness: 'complete' }], createdAt: 1, lmParameters: undefined, modelId: undefined, replies: { items: [] } };
  let branch = user.replies;
  for (const node of fixture.nodes) {
    branch.items.push(node);branch = node.replies;
  }
  const chat: import('@/01-models/types').ChatContent = { root: { items: [user] }, currentLeafId: fixture.nodes.at(-1)!.id };
  const before = buildChatGenerationMessages({ chat, excludedMessageId: undefined, systemPromptMessages: [] });
  const storage = new MemoryStorageProvider();const id = toChatId({ raw: 'llama-parts' });
  await storage.saveChatContent({ id, content: chat });const loaded = await storage.loadChatContent({ id });if (!loaded) throw new Error('Saved chat missing');
  const after = buildChatGenerationMessages({ chat: loaded, excludedMessageId: undefined, systemPromptMessages: [] });
  expect(after).toEqual(before);
  const a = await prepareLlamaCppRequest({ ...request, messages: before });const b = await prepareLlamaCppRequest({ ...request, messages: after });expect(b).toEqual(a);
  expect(a.messages).toEqual([{ role: 'user', content: 'hello' }, { role: 'assistant', content: '', reasoning_content: 'Check the tool.\n', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'lookup', arguments: '{}' } }] }, { role: 'tool', tool_call_id: 'c1', name: 'lookup', content: '  result\r\n' }, { role: 'assistant', content: 'answer' }]);
});
