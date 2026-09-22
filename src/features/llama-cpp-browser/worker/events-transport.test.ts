// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { exposeWorkerRemote, releaseWorkerRemote, workerProxy, wrapWorkerRemote } from '@/utils/worker-transport';
import type { LlamaCppWorkerApi, WorkerGenerateCall } from './types';
import type { generate } from './generation';
import type { GenerationEvent } from '@/features/llama-cpp-browser/types';
import { createWorkerApi } from './api';
const native = vi.hoisted(() => ({ generate: vi.fn<typeof generate>() }));
vi.mock('./generation', () => ({ generate: native.generate }));
vi.mock('./session', () => ({ invalidateStoredModel: async () => {} }));
vi.mock('../runtime/model-store', () => ({ withModelStoreLock: async ({ operation }: { operation: () => Promise<unknown> }) => operation(), importStoredModel: vi.fn(), listStoredModels: vi.fn(), removeStoredModel: vi.fn() }));
vi.mock('../runtime/model-directory', () => ({ importModelDirectory: vi.fn() }));
const links: MessageChannel[] = [];
beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => {
  for (const link of links.splice(0)) {
    link.port1.close();link.port2.close();
  }
});
function connect() {
  const link = new MessageChannel();links.push(link);
  exposeWorkerRemote<LlamaCppWorkerApi>({ api: createWorkerApi(), endpoint: link.port1 });
  return wrapWorkerRemote<LlamaCppWorkerApi>({ endpoint: link.port2 });
}
function request(): WorkerGenerateCall {
  return { generationId: 1, model: 'fixture.gguf', options: { profile: 'cpu-wasm32' }, assetBaseURL: 'https://example.invalid/profiles/', messages: [{ role: 'user', content: 'hi' }], temperature: 0, topP: 1, presencePenalty: 0, frequencyPenalty: 0, stop: [] };
}
describe('structured generation over the actual Comlink MessageChannel transport', () => {
  it('acknowledges draft patches before delivering a completed call', async () => {
    const gate = Promise.withResolvers<void>();
    const events: GenerationEvent[] = [];
    const call = { id: 'call', type: 'function' as const, function: { name: 'lookup', arguments: '{"city":"Tokyo"}' } };
    let acknowledged = false;
    native.generate.mockImplementation(async ({ onEvent }) => {
      await onEvent({ event: { type: 'tool_call_start', index: 0 } });
      await onEvent({ event: { type: 'tool_call_draft', index: 0, name: 'lookup', arguments: { offset: 0, text: '{"city":"Tok' } } });
      acknowledged = true;
      await onEvent({ event: { type: 'tool_call', index: 0, toolCall: call } });
      return { content: '', reasoningContent: '', toolCalls: [call], finishReason: 'stop' };
    });
    const remote = connect();
    try {
      const pending = remote.generate(request(), workerProxy({ value: async ({ event }: { event: GenerationEvent }) => {
        events.push(event);
        if (event.type === 'tool_call_draft') await gate.promise;
      } }), workerProxy({ value: () => {} }));
      await vi.waitFor(() => expect(events).toHaveLength(2));
      expect(acknowledged).toBe(false);
      expect(events[1]).toEqual({ type: 'tool_call_draft', index: 0, name: 'lookup', arguments: { offset: 0, text: '{"city":"Tok' } });
      gate.resolve();
      expect(await pending).toMatchObject({ toolCalls: [call] });
      expect(acknowledged).toBe(true);
      expect(events.at(-1)).toEqual({ type: 'tool_call', index: 0, toolCall: call });
    } finally {
      gate.resolve();
      releaseWorkerRemote({ remote });
    }
  });

  it('acknowledges cloned reasoning and text before the native producer advances', async () => {
    const gate = Promise.withResolvers<void>();let stage = 0;const events: GenerationEvent[] = [];
    native.generate.mockImplementation(async ({ onEvent }) => {
      stage = 1;await onEvent({ event: { type: 'reasoning', text: ' R\n' } });stage = 2;
      await onEvent({ event: { type: 'text', text: '<think>literal</think>  ' } });stage = 3;
      return { content: '<think>literal</think>  ', reasoningContent: ' R\n', toolCalls: [], finishReason: 'stop' };
    });
    const remote = connect();
    try {
      const pending = remote.generate(request(), workerProxy({ value: async ({ event }: { event: GenerationEvent }) => {
        events.push(event);if (event.type === 'reasoning') await gate.promise;
      } }), workerProxy({ value: () => {} }));
      await vi.waitFor(() => expect(events).toHaveLength(1));expect(stage).toBe(1);gate.resolve();
      expect(await pending).toMatchObject({ content: '<think>literal</think>  ', reasoningContent: ' R\n' });expect(stage).toBe(3);expect(events.map(e => e.type)).toEqual(['reasoning', 'text']);
    } finally {
      gate.resolve();releaseWorkerRemote({ remote });
    }
  });
  it('delivers accepted content and confirmed calls during cancellation before closing the RPC', async () => {
    const gate = Promise.withResolvers<void>();let signal: AbortSignal | undefined;const events: GenerationEvent[] = [];
    const call = { id: 'c', type: 'function' as const, function: { name: 'f', arguments: ' {"a":1} ' } };
    native.generate.mockImplementation(async args => {
      signal = args.signal;await args.onEvent({ event: { type: 'text', text: 'accepted' } });await gate.promise;
      await args.onEvent({ event: { type: 'tool_call_start', index: 0 } });await args.onEvent({ event: { type: 'tool_call', index: 0, toolCall: call } });
      return { content: 'accepted', reasoningContent: '', toolCalls: [call], finishReason: 'stop' };
    });
    const remote = connect();
    try {
      const pending = remote.generate(request(), workerProxy({ value: async ({ event }: { event: GenerationEvent }) => {
        events.push(event);
      } }), workerProxy({ value: () => {} }));
      await vi.waitFor(() => expect(events).toHaveLength(1));await remote.cancelGeneration({ generationId: 1 });expect(signal?.aborted).toBe(true);
      gate.resolve();await pending;expect(events).toEqual([{ type: 'text', text: 'accepted' }, { type: 'tool_call_start', index: 0 }, { type: 'tool_call', index: 0, toolCall: call }]);
    } finally {
      gate.resolve();releaseWorkerRemote({ remote });
    }
  });
  it('propagates a failed content acknowledgement without sending later output or retaining the active operation', async () => {
    let after = false;
    native.generate.mockImplementationOnce(async ({ onEvent }) => {
      await onEvent({ event: { type: 'text', text: 'A' } });after = true;
      return { content: 'A', reasoningContent: '', toolCalls: [], finishReason: 'stop' };
    });
    const remote = connect();
    try {
      await expect(remote.generate(request(), workerProxy({ value: async () => {
        throw new Error('private consumer details');
      } }), workerProxy({ value: () => {} }))).rejects.toThrow('worker-failed');
      expect(after).toBe(false);
      native.generate.mockResolvedValueOnce({ content: '', reasoningContent: '', toolCalls: [], finishReason: 'stop' });
      expect(await remote.generate({ ...request(), generationId: 2 }, workerProxy({ value: async () => {} }), workerProxy({ value: () => {} }))).toHaveProperty('finishReason', 'stop');
    } finally {
      releaseWorkerRemote({ remote });
    }
  });
});
