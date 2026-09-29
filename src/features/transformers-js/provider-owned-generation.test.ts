// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { ChatGenerationItem, LmProvider } from '@/01-models/lm';
import type { MessageNode, ChatMessage, AssistantMessageNode } from '@/01-models/types';
import { EMPTY_LM_PARAMETERS } from '@/01-models/types';
import type { Tool } from '@/01-models/tool';
import { toMessageId, toToolCallId, toBinaryObjectId, toAttachmentId } from '@/01-models/ids';
import { createChatMessageSnapshot } from '@/01-models/chat-message';
import { collectChatGeneration } from '@/logic/collect-chat-generation';
import { generateChatTurn } from '@/logic/generate-chat-turn';
import { createTransformersJsService } from './index-hosted';
import { createTransformersJsProvider } from './provider-hosted';
import type { InferenceGenerationCallback } from './generation-events';
import type { TransformersJsWorkerClient } from './types';
import { createMemoryFiles } from './replay-models/support/download-memory-files';

const owners: Array<ReturnType<typeof createTransformersJsService>> = [];
const forbiddenFetch = vi.fn<typeof fetch>(async () => {
  throw new Error('Unexpected network request');
});

async function answer({ onEvent, text }: { onEvent: InferenceGenerationCallback, text: string }): Promise<void> {
  await onEvent({ event: { type: 'part_start', kind: 'text', index: 0 } });
  await onEvent({ event: { type: 'text_delta', index: 0, text } });
  await onEvent({ event: { type: 'part_end', index: 0, completeness: 'complete' } });
  await onEvent({ event: { type: 'result', result: { type: 'finished', next: 'user' } } });
}

function createClient() {
  return {
    loadDownloadedModel: vi.fn<TransformersJsWorkerClient['loadDownloadedModel']>().mockResolvedValue({ device: 'webgpu' }),
    unloadModel: vi.fn<TransformersJsWorkerClient['unloadModel']>().mockResolvedValue(undefined),
    generateText: vi.fn<TransformersJsWorkerClient['generateText']>().mockRejectedValue(new Error('The legacy stream must not be used.')),
    generateMessage: vi.fn<TransformersJsWorkerClient['generateMessage']>(async ({ onEvent }) => answer({ onEvent, text: 'answer' })),
    interrupt: vi.fn<TransformersJsWorkerClient['interrupt']>().mockResolvedValue(undefined),
    resetCache: vi.fn<TransformersJsWorkerClient['resetCache']>().mockResolvedValue(undefined),
    dispose: vi.fn<TransformersJsWorkerClient['dispose']>().mockResolvedValue(undefined),
  } satisfies TransformersJsWorkerClient;
}

function fixture() {
  const clients: ReturnType<typeof createClient>[] = [];
  const client = createClient(); clients.push(client);
  const createWorkerClient = vi.fn(() => {
    if (createWorkerClient.mock.calls.length === 1) return client;
    const next = createClient(); clients.push(next); return next;
  });
  const owner = createTransformersJsService({ createWorkerClient }); owners.push(owner);
  return { client, clients, owner, provider: createTransformersJsProvider({ service: owner.service }) };
}

function request({ signal, model, messages }: { signal: AbortSignal | undefined, model: string, messages: readonly ChatMessage[] }): Parameters<LmProvider['chat']>[0] {
  return { signal, model, messages, parameters: undefined, tools: undefined, readBinaryObject: undefined, debug: undefined };
}

function turn({ provider, tools, model }: { provider: LmProvider, tools: Tool[], model: string }) {
  const history: MessageNode[] = [];
  const controller = new AbortController();
  const onToolEvent = vi.fn();
  return { history, controller, onToolEvent, run: () => generateChatTurn({
    onToolCallDraftsChange: undefined,
    provider, model, parameters: undefined, tools, readBinaryObject: undefined, debug: undefined,
    abortController: controller, approvalContext: undefined,
    createAssistantMessage: () => {
      const node: AssistantMessageNode = { id: toMessageId({ raw: `a${history.length}` }), role: 'assistant',
        parts: [], createdAt: 1, interruption: undefined, modelId: undefined, lmParameters: undefined, replies: { items: [] } };
      history.push(node); return node;
    },
    createToolMessage: () => {
      const node: Extract<MessageNode, { role: 'tool' }> = { id: toMessageId({ raw: `t${history.length}` }), role: 'tool', parts: [],
        createdAt: 1, modelId: undefined, lmParameters: undefined, replies: { items: [] } };
      history.push(node); return node;
    },
    buildMessages: ({ excludedMessageId }) => history.filter(node => node.id !== excludedMessageId).map(node => createChatMessageSnapshot({ node })),
    onChange: () => {}, onToolEvent, persistToolContent: async ({ text }) => ({ type: 'text', text }), describeError: ({ error }) => error.message,
  }) };
}

async function publishCall({ onEvent }: { onEvent: InferenceGenerationCallback }): Promise<void> {
  await onEvent({ event: { type: 'part_start', index: 0, kind: 'reasoning' } });
  await onEvent({ event: { type: 'text_delta', index: 0, text: '  Use the tool.\n' } });
  await onEvent({ event: { type: 'part_end', index: 0, completeness: 'complete' } });
  await onEvent({ event: { type: 'tool_start', index: 1 } });
  await onEvent({ event: { type: 'tool_call', index: 1, toolCall: { id: toToolCallId({ raw: 'call' }), type: 'function', function: { name: 'f', arguments: ' {} ' } } } });
  await onEvent({ event: { type: 'result', result: { type: 'finished', next: 'tool_results' } } });
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  const fs = createMemoryFiles(); fs.enter({ nextPhase: 'load', mutationPolicy: 'read-only' });
  vi.stubGlobal('navigator', { storage: { getDirectory: async () => fs.root } });
  forbiddenFetch.mockClear(); vi.stubGlobal('fetch', forbiddenFetch);
});
afterEach(async () => {
  try {
    await Promise.all(owners.splice(0).map(owner => owner.dispose())); expect(forbiddenFetch).not.toHaveBeenCalled();
  } finally {
    vi.restoreAllMocks(); vi.unstubAllGlobals();
  }
});

describe('hosted structured generation with the real service lane', () => {
  it('loads only when read, projects parts and uses the structured worker method', async () => {
    const f = fixture(); const c = new AbortController();
    const user: ChatMessage = { id: toMessageId({ raw: 'u' }), role: 'user', parts: [{ type: 'text', text: '<think>literal</think> ', completeness: 'complete' }] };
    const items = f.provider.chat(request({ signal: c.signal, model: 'fixture/model', messages: [user] }));
    expect(f.client.loadDownloadedModel).not.toHaveBeenCalled();
    const r = await collectChatGeneration({ items, abortController: c });
    expect(r).toMatchObject({ text: 'answer', result: { type: 'finished', next: 'user' } });
    expect(f.client.generateMessage).toHaveBeenCalledOnce(); expect(f.client.generateText).not.toHaveBeenCalled();
    expect(f.client.generateMessage.mock.calls[0]?.[0].messages).toEqual([{ role: 'user', content: '<think>literal</think> ' }]);
  });

  it('snapshots content, reasoning, tools and settings at chat invocation', async () => {
    const f = fixture(); const c = new AbortController();
    const a: Extract<ChatMessage, { role: 'assistant' }> = { id: toMessageId({ raw: 'a' }), role: 'assistant', parts: [{ type: 'reasoning', text: '  R\n', completeness: 'complete' }] };
    const parameters = { ...EMPTY_LM_PARAMETERS, stop: ['STOP'] }; const tools = [{ name: 'f', description: 'before', parameters: { type: 'object' } }];
    const input: Parameters<LmProvider['chat']>[0] = { ...request({ signal: c.signal, model: 'fixture/model', messages: [a] }), parameters, tools };
    const items = f.provider.chat(input);
    const body = a.parts[0]; if (body?.type !== 'reasoning') throw new Error('Fixture part missing'); body.text = 'changed';
    parameters.stop[0] = 'CHANGED'; tools[0]!.description = 'after';
    await collectChatGeneration({ items, abortController: c });
    const native = f.client.generateMessage.mock.calls[0]![0];
    expect(native.messages).toEqual([{ role: 'assistant', content: [], reasoning: { text: '  R\n', completeness: 'complete' } }]);
    expect(native.params?.stop).toEqual(['STOP']); expect(native.tools?.[0]?.function.description).toBe('before');
  });

  it('keeps the same owner over tools and the next assistant while a competing chat waits', async () => {
    const f = fixture(); const held = Promise.withResolvers<void>(); const release = Promise.withResolvers<void>();
    const tool: Tool = { name: 'f', description: 'test', parametersSchema: z.object({}), execute: async () => {
      held.resolve(); await release.promise; return { status: 'success', content: 'tool result' };
    } };
    f.client.generateMessage.mockImplementationOnce(publishCall);
    const conversation = turn({ provider: f.provider, model: 'fixture/first', tools: [tool] });
    const first = conversation.run(); let nextSettled = false;
    await held.promise;
    const competitor = new AbortController();
    const second = collectChatGeneration({ items: f.provider.chat(request({ signal: competitor.signal, model: 'fixture/second', messages: [] })), abortController: competitor }).then(value => {
      nextSettled = true; return value;
    });
    try {
      await Promise.resolve(); expect(nextSettled).toBe(false); expect(f.client.loadDownloadedModel).toHaveBeenCalledOnce();
      release.resolve(); expect(await first).toEqual({ type: 'finished', next: 'user' }); await second;
      expect(f.client.generateMessage).toHaveBeenCalledTimes(3);
      const [initial, afterTool, other] = f.client.generateMessage.mock.calls.map(([args]) => args);
      expect(initial!.continuationOwner).toBe(afterTool!.continuationOwner); expect(other!.continuationOwner).not.toBe(initial!.continuationOwner);
      expect(afterTool!.messages).toEqual([
        { role: 'assistant', content: [], reasoning: { text: '  Use the tool.\n', completeness: 'complete' }, tool_calls: [{ id: 'call', type: 'function', function: { name: 'f', arguments: ' {} ' } }] },
        { role: 'tool', tool_call_id: 'call', content: 'tool result' },
      ]);
      expect(conversation.history.map(node => node.role)).toEqual(['assistant', 'tool', 'assistant']);
    } finally {
      release.resolve(); await Promise.allSettled([first, second]);
    }
  });

  it('waits for RPC settlement even after the final native event arrived', async () => {
    const f = fixture(); const arrived = Promise.withResolvers<void>(); const release = Promise.withResolvers<void>();
    f.client.generateMessage.mockImplementationOnce(async ({ onEvent }) => {
      await answer({ onEvent, text: 'A' }); arrived.resolve(); await release.promise;
    });
    const c = new AbortController(); let ended = false;
    const first = collectChatGeneration({ items: f.provider.chat(request({ signal: c.signal, model: 'fixture/m', messages: [] })), abortController: c }).then(value => {
      ended = true; return value;
    });
    await arrived.promise; expect(ended).toBe(false);
    const queued = f.owner.service.resetCache(); expect(f.client.resetCache).not.toHaveBeenCalled();
    release.resolve(); await first; await queued; expect(f.client.resetCache).toHaveBeenCalledOnce();
  });

  it('returns aborted and drains received text without changing it into tagged reasoning', async () => {
    const f = fixture(); const c = new AbortController();
    f.client.generateMessage.mockImplementationOnce(async ({ onEvent }) => {
      await onEvent({ event: { type: 'part_start', index: 0, kind: 'text' } });
      await onEvent({ event: { type: 'text_delta', index: 0, text: '<think>途中\n' } });
      c.abort();
      await onEvent({ event: { type: 'part_end', index: 0, completeness: 'partial' } });
      await onEvent({ event: { type: 'result', result: { type: 'interrupted', reason: 'aborted' } } });
    });
    const r = await collectChatGeneration({ items: f.provider.chat(request({ signal: c.signal, model: 'fixture/m', messages: [] })), abortController: c });
    expect(r.text).toBe('<think>途中\n'); expect(r.result).toEqual({ type: 'interrupted', reason: 'aborted' }); expect(f.client.interrupt).toHaveBeenCalledOnce();
  });

  it('records cancellation through the real common runner without releasing its owner early', async () => {
    const f = fixture(); const conversation = turn({ provider: f.provider, model: 'fixture/m', tools: [] });
    f.client.generateMessage.mockImplementationOnce(async ({ onEvent }) => {
      await onEvent({ event: { type: 'part_start', index: 0, kind: 'text' } });
      await onEvent({ event: { type: 'text_delta', index: 0, text: '途中' } });
      conversation.controller.abort();
      await onEvent({ event: { type: 'part_end', index: 0, completeness: 'partial' } });
      await onEvent({ event: { type: 'result', result: { type: 'interrupted', reason: 'aborted' } } });
    });
    expect(await conversation.run()).toEqual({ type: 'interrupted', reason: 'aborted' });
    expect(conversation.history[0]).toMatchObject({ interruption: { type: 'cancelled' }, parts: [{ type: 'text', text: '途中', completeness: 'partial' }] });
  });

  it('rejects an escaped scoped chat before any later model operation', async () => {
    const f = fixture(); let escaped: LmProvider['chat'] | undefined;
    await f.provider.runChatOperation!({ signal: undefined, operation: async ({ chat }) => {
      escaped = chat;
    } });
    const c = new AbortController(); if (!escaped) throw new Error('No escaped chat');
    await expect(collectChatGeneration({ items: escaped(request({ signal: c.signal, model: 'fixture/escaped', messages: [] })), abortController: c })).rejects.toThrow('closed');
    expect(f.client.loadDownloadedModel).not.toHaveBeenCalled(); expect(f.client.generateMessage).not.toHaveBeenCalled();
  });

  it('rejects overlapping scoped generations without disturbing the first', async () => {
    const f = fixture(); const entered = Promise.withResolvers<void>(); const release = Promise.withResolvers<void>();
    f.client.generateMessage.mockImplementationOnce(async ({ onEvent }) => {
      entered.resolve(); await release.promise; await answer({ onEvent, text: 'first' });
    });
    await f.provider.runChatOperation!({ signal: undefined, operation: async ({ chat, signal }) => {
      const a = new AbortController(); const b = new AbortController();
      const first = collectChatGeneration({ items: chat(request({ signal, model: 'fixture/m', messages: [] })), abortController: a });
      await entered.promise;
      const second = await collectChatGeneration({ items: chat(request({ signal, model: 'fixture/m', messages: [] })), abortController: b });
      expect(second.result).toMatchObject({ type: 'error', error: expect.objectContaining({ message: expect.stringContaining('active generation') }) });
      expect(f.client.generateMessage).toHaveBeenCalledOnce(); release.resolve(); expect((await first).text).toBe('first');
    } });
    expect(f.client.interrupt).not.toHaveBeenCalled();
  });

  it('abandons unconsumed children when the operation callback returns', async () => {
    const f = fixture(); const controller = new AbortController();
    f.client.generateMessage.mockImplementationOnce(async ({ onEvent }) => {
      await onEvent({ event: { type: 'part_start', kind: 'text', index: 0 } });
      for (let i = 0; i < 40; i++) await onEvent({ event: { type: 'text_delta', index: 0, text: 'data' } });
      await onEvent({ event: { type: 'part_end', index: 0, completeness: 'complete' } });
      await onEvent({ event: { type: 'result', result: { type: 'finished', next: 'user' } } });
    });
    await expect(f.provider.runChatOperation!({ signal: controller.signal, operation: async ({ chat, signal }) => {
      const iterator = chat(request({ signal, model: 'fixture/m', messages: [] }))[Symbol.asyncIterator]();
      expect((await iterator.next()).done).toBe(false);
      // The owner must cancel the unread child and drain its failed producer.
    } })).rejects.toThrow();
    await f.owner.service.resetCache(); expect(f.client.resetCache).toHaveBeenCalledOnce(); expect(f.client.interrupt).toHaveBeenCalledOnce();
  });

  it('reclaims an unread child after concurrent reads reject without stranding its runtime owner', async () => {
    const f = fixture();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const escaped = Promise.withResolvers<AsyncIterator<ChatGenerationItem>>();
    const firstItem = Promise.withResolvers<IteratorResult<ChatGenerationItem>>();
    const queueFilled = Promise.withResolvers<void>();
    let producerSettled = false;
    f.client.generateMessage.mockImplementationOnce(async ({ onEvent }) => {
      entered.resolve();
      await release.promise;
      try {
        await onEvent({ event: { type: 'part_start', kind: 'text', index: 0 } });
        // Leave a child unread so merely aborting without cancelling its bounded
        // queue cannot settle the producer or admit the next runtime operation.
        for (let i = 0; i < 40; i++) {
          await onEvent({ event: { type: 'text_delta', index: 0, text: 'data' } });
          if (i === 14) queueFilled.resolve();
        }
        await onEvent({ event: { type: 'part_end', index: 0, completeness: 'complete' } });
        await onEvent({ event: { type: 'result', result: { type: 'finished', next: 'user' } } });
      } finally {
        producerSettled = true;
      }
    });
    let settled = false;
    const operation = f.provider.runChatOperation!({ signal: undefined, operation: async ({ chat, signal }) => {
      const iterator = chat(request({ signal, model: 'fixture/m', messages: [] }))[Symbol.asyncIterator]();
      escaped.resolve(iterator);
      const first = iterator.next();
      await entered.promise;
      await expect(iterator.next()).rejects.toThrow('Concurrent reads');
      release.resolve();
      firstItem.resolve(await first);
      await queueFilled.promise;
    } }).then(
      () => ({ type: 'resolved' as const }),
      (error: unknown) => ({ type: 'rejected' as const, error }),
    ).finally(() => {
      settled = true;
    });
    await entered.promise;
    const queued = f.owner.service.resetCache();
    try {
      await vi.waitFor(() => expect(settled).toBe(true), { timeout: 500 });
      expect(await operation).toMatchObject({ type: 'rejected', error: expect.any(Error) });
      expect(producerSettled).toBe(true);
      const first = await firstItem.promise;
      if (first.done || first.value.type !== 'text') throw new Error('Missing owned text child');
      expect(await first.value.completeness).toBe('partial');
      expect(await first.value.chunks[Symbol.asyncIterator]().next()).toEqual({ done: true, value: undefined });
      await queued;
      expect(f.client.resetCache).toHaveBeenCalledOnce();
      expect(f.client.interrupt).toHaveBeenCalledOnce();
    } finally {
      release.resolve();
      // Also release the reproducer's resources when the regression is present.
      await (await escaped.promise).return?.();
      await operation;
      await queued;
    }
  });

  it('keeps independent service instances out of each other\'s lane', async () => {
    const a = fixture(); const b = fixture(); const entered = Promise.withResolvers<void>(); const release = Promise.withResolvers<void>();
    const held = a.provider.runChatOperation!({ signal: undefined, operation: async () => {
      entered.resolve(); await release.promise;
    } });
    await entered.promise;
    try {
      const c = new AbortController(); const other = await collectChatGeneration({ items: b.provider.chat(request({ signal: c.signal, model: 'fixture/b', messages: [] })), abortController: c });
      expect(other.text).toBe('answer'); expect(a.client.generateMessage).not.toHaveBeenCalled();
    } finally {
      release.resolve(); await held;
    }
  });

  it('rejects a nonimage attachment before loading a model or reading its bytes', async () => {
    const f = fixture(); const c = new AbortController(); const read = vi.fn(async () => new Blob(['text']));
    const user: ChatMessage = { id: toMessageId({ raw: 'u' }), role: 'user', parts: [{ type: 'attachment', attachment: {
      id: toAttachmentId({ raw: 'a' }), binaryObjectId: toBinaryObjectId({ raw: 'b' }), originalName: 'text', mimeType: 'text/plain', size: 4, uploadedAt: 1, status: 'persisted',
    } }] };
    const r = await collectChatGeneration({ items: f.provider.chat({ ...request({ signal: c.signal, model: 'fixture/m', messages: [user] }), readBinaryObject: read }), abortController: c });
    expect(r.result.type).toBe('error'); expect(read).not.toHaveBeenCalled(); expect(f.client.loadDownloadedModel).not.toHaveBeenCalled();
  });

  it('propagates operation callback errors without executing an internal tool loop', async () => {
    const f = fixture(); const failure = new Error('history write failed');
    await expect(f.provider.runChatOperation!({ signal: undefined, operation: async () => {
      throw failure;
    } })).rejects.toBe(failure);
    expect(f.client.generateMessage).not.toHaveBeenCalled();
  });

  it('retains a real late tool outcome only in its original history after runtime replacement', async () => {
    const f = fixture(); const held = Promise.withResolvers<AbortSignal | undefined>(); const release = Promise.withResolvers<void>();
    const observed = Promise.withResolvers<void>();
    const tool: Tool = { name: 'f', description: 'late side effect', parametersSchema: z.object({}), execute: async ({ signal, onEvent }) => {
      held.resolve(signal); await release.promise;
      await onEvent?.({ event: { type: 'output', stream: 'stdout', text: 'late diagnostic' } });
      observed.resolve(); return { status: 'success', content: 'actually completed' };
    } };
    f.client.generateMessage.mockImplementationOnce(publishCall);
    const old = turn({ provider: f.provider, model: 'fixture/old', tools: [tool] });
    const outcome = old.run().then(value => ({ value }), error => ({ error }));
    const toolSignal = await held.promise;
    try {
      await f.owner.service.restart(); expect(toolSignal?.aborted).toBe(true);
      expect(await outcome).toMatchObject({ error: { reason: 'restarted' } });
      expect(old.controller.signal.aborted).toBe(false);
      const fresh = turn({ provider: f.provider, model: 'fixture/fresh', tools: [] });
      expect(await fresh.run()).toEqual({ type: 'finished', next: 'user' });
      const before = structuredClone(fresh.history);
      release.resolve(); await observed.promise;
      await vi.waitFor(() => expect(old.history[1]).toMatchObject({ role: 'tool', parts: [{ result: { status: 'success', content: { type: 'text', text: 'actually completed' } } }] }));
      expect(old.onToolEvent).not.toHaveBeenCalled(); expect(fresh.history).toEqual(before);
      expect(f.clients).toHaveLength(2); expect(f.clients[1]!.generateMessage).toHaveBeenCalledOnce();
      expect(f.owner.service.getState()).toMatchObject({ status: 'ready', activeModelId: 'fixture/fresh' });
    } finally {
      release.resolve(); await outcome;
    }
  });

  it('keeps accepted text but ignores structured events arriving after runtime replacement', async () => {
    const f = fixture();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const remoteSettled = Promise.withResolvers<void>();
    f.client.generateMessage.mockImplementationOnce(async ({ onEvent }) => {
      await onEvent({ event: { type: 'part_start', index: 0, kind: 'text' } });
      await onEvent({ event: { type: 'text_delta', index: 0, text: 'accepted' } });
      entered.resolve();
      await release.promise;
      try {
        await onEvent({ event: { type: 'text_delta', index: 0, text: 'stale' } });
        await onEvent({ event: { type: 'part_end', index: 0, completeness: 'complete' } });
        await onEvent({ event: { type: 'result', result: { type: 'finished', next: 'user' } } });
      } finally {
        remoteSettled.resolve();
      }
    });
    const old = turn({ provider: f.provider, model: 'fixture/old', tools: [] });
    const outcome = old.run().then(value => ({ value }), error => ({ error }));
    await entered.promise;
    try {
      await f.owner.service.restart();
      expect(await outcome).toMatchObject({ error: { reason: 'restarted' } });
      const fresh = turn({ provider: f.provider, model: 'fixture/fresh', tools: [] });
      expect(await fresh.run()).toEqual({ type: 'finished', next: 'user' });
      const before = structuredClone(fresh.history);
      release.resolve();
      await remoteSettled.promise;
      await vi.waitFor(() => expect(old.history[0]).toMatchObject({
        // Runtime retirement propagates as a lifecycle error to its caller;
        // it does not record a user cancellation on the original history.
        interruption: undefined,
        parts: [{ type: 'text', text: 'accepted', completeness: 'partial' }],
      }));
      expect(fresh.history).toEqual(before);
      expect(f.client.generateMessage).toHaveBeenCalledOnce();
      expect(f.clients[1]!.generateMessage).toHaveBeenCalledOnce();
      expect(f.owner.service.getState()).toMatchObject({ status: 'ready', activeModelId: 'fixture/fresh' });
    } finally {
      release.resolve();
      await outcome;
      await remoteSettled.promise;
    }
  });

  it('keeps ordinary stop in the lane until a noncooperative tool actually settles', async () => {
    const f = fixture(); const held = Promise.withResolvers<void>(); const release = Promise.withResolvers<void>();
    const tool: Tool = { name: 'f', description: 'late completion', parametersSchema: z.object({}), execute: async ({ onEvent }) => {
      held.resolve(); await release.promise;
      await onEvent?.({ event: { type: 'output', stream: 'stdout', text: 'after stop' } });
      return { status: 'success', content: 'completed after stop' };
    } };
    f.client.generateMessage.mockImplementationOnce(publishCall);
    const first = turn({ provider: f.provider, model: 'fixture/first', tools: [tool] });
    const outcome = first.run().then(value => ({ value }), error => ({ error }));
    await held.promise; first.controller.abort();
    const second = turn({ provider: f.provider, model: 'fixture/second', tools: [] });
    const pending = second.run();
    try {
      await Promise.resolve(); expect(f.client.generateMessage).toHaveBeenCalledOnce();
      release.resolve(); expect(await outcome).toMatchObject({ error: { name: 'AbortError' } });
      expect(await pending).toEqual({ type: 'finished', next: 'user' });
      expect(first.history[1]).toMatchObject({ parts: [{ result: { status: 'success', content: { text: 'completed after stop' } } }] });
      expect(first.history.map(node => node.role)).toEqual(['assistant', 'tool']);
      expect(first.onToolEvent).not.toHaveBeenCalled(); expect(f.client.generateMessage).toHaveBeenCalledTimes(2);
    } finally {
      release.resolve(); await Promise.allSettled([outcome, pending]);
    }
  });

  it('does not load a queued request canceled before its operation is admitted', async () => {
    const f = fixture(); const entered = Promise.withResolvers<void>(); const release = Promise.withResolvers<void>();
    const held = f.provider.runChatOperation!({ signal: undefined, operation: async () => {
      entered.resolve(); await release.promise;
    } });
    await entered.promise;
    const controller = new AbortController();
    const queued = collectChatGeneration({ items: f.provider.chat(request({ signal: controller.signal, model: 'fixture/queued', messages: [] })), abortController: controller });
    controller.abort();
    try {
      expect((await queued).result).toEqual({ type: 'interrupted', reason: 'aborted' });
      expect(f.client.loadDownloadedModel).not.toHaveBeenCalled(); expect(f.client.generateMessage).not.toHaveBeenCalled();
    } finally {
      release.resolve(); await held;
    }
  });

  it('rejects an escaped generation created during its scope but not read until later', async () => {
    const f = fixture(); let escaped: ReturnType<LmProvider['chat']> | undefined;
    await f.provider.runChatOperation!({ signal: undefined, operation: async ({ chat, signal }) => {
      escaped = chat(request({ signal, model: 'fixture/stale', messages: [] }));
    } });
    if (!escaped) throw new Error('Missing escaped generation');
    await expect(collectChatGeneration({ items: escaped, abortController: new AbortController() })).rejects.toThrow('closed');
    expect(f.client.loadDownloadedModel).not.toHaveBeenCalled();
  });

  it('owns binary preparation failures without trying to load or download a model', async () => {
    const f = fixture(); const c = new AbortController(); const failure = new Error('Missing local image');
    const read = vi.fn(async () => {
      throw failure;
    });
    const user: ChatMessage = { id: toMessageId({ raw: 'u' }), role: 'user', parts: [{ type: 'attachment', attachment: {
      id: toAttachmentId({ raw: 'a' }), binaryObjectId: toBinaryObjectId({ raw: 'b' }), originalName: 'image', mimeType: 'image/png', size: 4, uploadedAt: 1, status: 'persisted',
    } }] };
    const result = await collectChatGeneration({ items: f.provider.chat({ ...request({ signal: c.signal, model: 'fixture/m', messages: [user] }), readBinaryObject: read }), abortController: c });
    expect(result.result).toEqual({ type: 'error', error: failure }); expect(read).toHaveBeenCalledOnce();
    expect(f.client.loadDownloadedModel).not.toHaveBeenCalled();
  });

});
