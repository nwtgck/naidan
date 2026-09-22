// @vitest-environment node
import { MessageChannel } from 'node:worker_threads';
import * as Comlink from 'comlink';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { exposeWorkerRemote, releaseWorkerRemote, workerProxy, wrapWorkerRemote, type WorkerRemote } from '@/utils/worker-transport';
import type { GenerationEvent, GenerateInput } from '@/features/llama-cpp-browser/types';
import { createModelBlobFixture, ggufFile } from '@/features/llama-cpp-browser/test-utils/model-blob-view';
import { importModelDirectory } from '@/features/llama-cpp-browser/runtime/model-directory';
import { storedModelDirectory } from '@/features/llama-cpp-browser/runtime/model-store';
import * as blobHost from '@/utils/worker-blob-context';
import { OPFSStorageProvider } from '@/00-storage/service/opfs-storage';
import { toChatId, toMessageId } from '@/01-models/ids';
import type { ToolCallDraft } from '@/01-models/lm';
import type { AssistantMessageNode } from '@/01-models/types';
import { createLlamaCppGeneration } from '@/features/llama-cpp-browser/provider-generation';
import { chatRequest } from '@/features/llama-cpp-browser/test-utils/chat';
import { consumeChatGeneration } from '@/logic/consume-chat-generation';
import { createWorkerApi } from './api';
import { createLlamaCppWorkerSessionClient } from './client-session';
import type { LlamaCppWorkerApi, WorkerGenerateCall } from './types';
import type { generate } from './generation';

const native = vi.hoisted(() => ({ generate: vi.fn<typeof generate>() }));
vi.mock('./generation', () => ({ generate: native.generate }));
vi.mock('./session', () => ({ releaseSession: async () => {}, invalidateStoredModel: async () => {} }));
const toolCall = { id: 'call-1', type: 'function' as const, function: { name: 'lookup', arguments: ' {"q":"日本語🙂"} ' } };
const events: GenerationEvent[] = [
  { type: 'reasoning', text: `\
  reasoning\\r
🙂` },
  { type: 'text', text: '<think>literal</think> ' },
  { type: 'tool_call_start', index: 0 },
  { type: 'tool_call', index: 0, toolCall },
  { type: 'text', text: ' tail\n' },
];
function completed() {
  return { content: '<think>literal</think>  tail\n', reasoningContent: `\
  reasoning\\r
🙂`, toolCalls: [toolCall], finishReason: 'stop' as const };
}
function request(): WorkerGenerateCall {
  return { generationId: 1, model: 'user/model-GGUF', messages: [{ role: 'user', content: 'hi' }], options: { profile: 'cpu-wasm32' }, temperature: 0, topP: 1, maxTokens: 8, presencePenalty: 0, frequencyPenalty: 0, stop: [] };
}
let storage: ReturnType<typeof createModelBlobFixture>;
const clients: ReturnType<typeof createLlamaCppWorkerSessionClient>[] = [];
beforeEach(async () => {
  storage = createModelBlobFixture({ releaseProxy: Comlink.releaseProxy });
  const file = ggufFile({ name: 'model.gguf', size: 40 });
  await importModelDirectory({ directory: { name: 'model-GGUF', files: [{ path: file.name, file }] }, onProgress: () => {}, signal: undefined });
  native.generate.mockReset();
});
afterEach(() => {
  for (const client of clients.splice(0)) client.dispose();
  storage.dispose(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});

function clientFixture() {
  const remote = { generate: vi.fn(), cancelGeneration: vi.fn(async () => {}) } as unknown as WorkerRemote<LlamaCppWorkerApi>;
  const disposeTransport = vi.fn();
  const client = createLlamaCppWorkerSessionClient({ worker: new EventTarget() as Worker, remote, disposeTransport, getAssetBaseURL: () => undefined });
  clients.push(client);
  const { generationId: _generationId, ...input } = request();
  return { remote, client, disposeTransport, input: input satisfies GenerateInput };
}

describe('message-parts acknowledgements retain their Blob host owner', () => {
  beforeEach(() => storage.blockWorkerReads());
  it.each(events.map((event, index) => ({ type: event.type, index })))('waits for event $index ($type) before advancing or releasing resources', async ({ index }) => {
    const api = createWorkerApi(); const host = storage.host();
    const gate = Promise.withResolvers<void>(); const release = vi.fn();
    const delivered: GenerationEvent[] = []; let advanced = 0;
    native.generate.mockImplementation(async ({ blobs, request: input, signal, onEvent }) => {
      await storedModelDirectory({ name: input.model, blobs, signal });
      for (const event of events) {
        await onEvent({ event }); advanced++;
      }
      return completed();
    });
    const receiver = Object.assign(async ({ event }: { event: GenerationEvent }) => {
      delivered.push(event);
      if (delivered.length === index + 1) await gate.promise;
    }, { [Comlink.releaseProxy]: release });
    const pending = api.generate(request(), receiver, () => {}, undefined, host.host);
    try {
      await vi.waitFor(() => expect(delivered).toHaveLength(index + 1));
      expect(advanced).toBe(index); expect(host.read).toHaveBeenCalled();
      expect(release).not.toHaveBeenCalled(); expect(host.released).not.toHaveBeenCalled();
      await expect(api.release()).rejects.toThrow('busy');
      gate.resolve(); expect(await pending).toEqual(completed());
      expect(delivered).toEqual(events); expect(advanced).toBe(events.length);
      expect(release).toHaveBeenCalledOnce(); expect(host.released).toHaveBeenCalledOnce();
    } finally {
      gate.resolve(); await pending.catch(() => undefined);
    }
  });

  it.each(['reasoning', 'tool_call_start', 'tool_call'] as const)('propagates a refused %s acknowledgement instead of treating content as delivered', async type => {
    const api = createWorkerApi(); const host = storage.host(); const release = vi.fn();
    const after: string[] = [];
    native.generate.mockImplementation(async ({ blobs, request: input, signal, onEvent }) => {
      await storedModelDirectory({ name: input.model, blobs, signal });
      for (const event of events) {
        await onEvent({ event }); after.push(event.type);
      }
      return completed();
    });
    const callback = Object.assign(async ({ event }: { event: GenerationEvent }) => {
      if (event.type === type) throw new Error('private persistence failure');
    }, { [Comlink.releaseProxy]: release });
    await expect(api.generate(request(), callback, () => {}, undefined, host.host)).rejects.toThrow('worker-failed');
    expect(after).toEqual(events.slice(0, events.findIndex(event => event.type === type)).map(event => event.type));
    expect(release).toHaveBeenCalledOnce(); expect(host.released).toHaveBeenCalledOnce();
    native.generate.mockResolvedValue(completed());
    expect(await api.generate({ ...request(), generationId: 2 }, async () => {}, () => {}, undefined, storage.host().host)).toEqual(completed());
  });

  it('drains accepted reasoning and confirmed tool calls after Stop, including their real Comlink ACKs', async () => {
    const api = createWorkerApi(); const link = new MessageChannel();
    exposeWorkerRemote<LlamaCppWorkerApi>({ api, endpoint: link.port1 as unknown as MessagePort });
    const remote = wrapWorkerRemote<LlamaCppWorkerApi>({ endpoint: link.port2 as unknown as MessagePort });
    const host = storage.host(); const hostDone = vi.fn(); const eventDone = vi.fn();
    Object.assign(host.host, { [Comlink.finalizer]: hostDone });
    const gate = Promise.withResolvers<void>(); const delivered: GenerationEvent[] = [];
    let signal: AbortSignal | undefined; let acknowledged = 0;
    native.generate.mockImplementation(async args => {
      signal = args.signal;
      await storedModelDirectory({ name: args.request.model, blobs: args.blobs, signal });
      for (const event of events) {
        await args.onEvent({ event }); acknowledged++;
      }
      return completed();
    });
    const callback = Object.assign(async ({ event }: { event: GenerationEvent }) => {
      delivered.push(event);
      if (delivered.length === 1) await gate.promise;
    }, { [Comlink.finalizer]: eventDone });
    const pending = remote.generate(request(), workerProxy({ value: callback }), workerProxy({ value: () => {} }), undefined, workerProxy({ value: host.host }));
    try {
      await vi.waitFor(() => expect(delivered).toHaveLength(1));
      await remote.cancelGeneration({ generationId: 1 }); expect(signal?.aborted).toBe(true);
      expect(acknowledged).toBe(0); expect(hostDone).not.toHaveBeenCalled(); expect(eventDone).not.toHaveBeenCalled();
      gate.resolve(); expect(await pending).toEqual(completed()); expect(delivered).toEqual(events);
      expect(acknowledged).toBe(events.length);
      await vi.waitFor(() => {
        expect(hostDone).toHaveBeenCalledOnce(); expect(eventDone).toHaveBeenCalledOnce();
      });
    } finally {
      gate.resolve(); await pending.catch(() => undefined); releaseWorkerRemote({ remote }); link.port1.close(); link.port2.close();
    }
  });
});

describe('client event ownership is independent from cooperative Stop', () => {
  it('acknowledges every event variant after Stop while the RPC and hosts are still alive', async () => {
    const { client, remote, input, disposeTransport } = clientFixture(); const controller = new AbortController();
    const finish = Promise.withResolvers<ReturnType<typeof completed>>();
    vi.mocked(remote.generate).mockReturnValue(finish.promise);
    const delivered: GenerationEvent[] = [];
    const pending = client.generate({ request: input, onEvent: ({ event }) => {
      delivered.push(event);
    }, onProgress: () => {}, signal: controller.signal });
    const rejected = expect(pending).rejects.toThrow('aborted');
    const wire = vi.mocked(remote.generate).mock.calls[0]!;
    controller.abort();
    for (const event of events) await wire[1]({ event });
    expect(delivered).toEqual(events); expect(disposeTransport).not.toHaveBeenCalled();
    expect(await wire[4]!.read({ blob: new Blob(['x']), offset: 0, length: 1 })).toEqual(new Uint8Array([120]));
    finish.resolve(completed()); await rejected;
    await expect(wire[4]!.read({ blob: new Blob(['x']), offset: 0, length: 1 })).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('rejects invalid event payloads before calling the consumer and leaves valid raw arguments untouched', async () => {
    const { client, remote, input } = clientFixture(); const finish = Promise.withResolvers<ReturnType<typeof completed>>();
    vi.mocked(remote.generate).mockReturnValue(finish.promise); const receive = vi.fn();
    const pending = client.generate({ request: input, onEvent: receive, onProgress: () => {}, signal: undefined });
    const callback = vi.mocked(remote.generate).mock.calls[0]![1];
    await expect(callback({ event: { type: 'tool_call_start', index: -1 } })).rejects.toThrow();
    expect(receive).not.toHaveBeenCalled(); await callback({ event: events[3]! });
    expect(receive).toHaveBeenCalledWith({ event: events[3] });
    finish.resolve(completed()); await pending;
  });
});

describe('parts persisted after crossing the actual model transport', () => {
  it.each(['finished', 'stopped', 'nonreplayable'] as const)('preserves all delivered parts for a %s turn', async ending => {
    // The filesystem and native token generator are test substitutes. The client,
    // Comlink transport, provider projection, common consumer and storage are real.
    storage.blockWorkerReads();
    const host = storage.host(); const finalized = vi.fn();
    Object.assign(host.host, { [Comlink.finalizer]: finalized });
    vi.spyOn(blobHost, 'createWorkerBlobReadHost').mockImplementation(({ signal }) => ({
      async read(value) {
        signal.throwIfAborted();
        const bytes = await host.read(value);
        signal.throwIfAborted();
        return bytes;
      },
      [Comlink.finalizer]: finalized,
    }));
    const api = createWorkerApi(); const link = new MessageChannel();
    exposeWorkerRemote<LlamaCppWorkerApi>({ api, endpoint: link.port1 as unknown as MessagePort });
    const remote = wrapWorkerRemote<LlamaCppWorkerApi>({ endpoint: link.port2 as unknown as MessagePort });
    const client = createLlamaCppWorkerSessionClient({
      worker: new EventTarget() as Worker, remote, getAssetBaseURL: () => undefined,
      disposeTransport: () => {
        releaseWorkerRemote({ remote }); link.port1.close(); link.port2.close();
      },
    });
    clients.push(client);
    const controller = new AbortController(); const atDrain = Promise.withResolvers<void>(); const resume = Promise.withResolvers<void>();
    const delivered: GenerationEvent[] = []; let nativeSignal: AbortSignal | undefined;
    const drafts: GenerationEvent[] = [
      { type: 'tool_call_draft', index: 0, name: 'lookup', arguments: { offset: 0, text: ' {"q":"日' } },
      { type: 'tool_call_draft', index: 0, arguments: { offset: 0, text: toolCall.function.arguments } },
    ];
    const generated = [...events.slice(0, 3), ...drafts, events[3]!];
    const draftSnapshots: ToolCallDraft[][] = [];
    native.generate.mockImplementation(async ({ request: input, blobs, signal, onEvent }) => {
      nativeSignal = signal;
      await storedModelDirectory({ name: input.model, blobs, signal });
      for (const event of events.slice(0, 2)) {
        await onEvent({ event }); delivered.push(event);
      }
      atDrain.resolve(); await resume.promise;
      // Native output already accepted before Stop still has to be drained.
      for (const event of generated.slice(2)) {
        await onEvent({ event }); delivered.push(event);
      }
      switch (ending) {
      case 'finished': case 'stopped': return { ...completed(), content: '<think>literal</think> ' };
      case 'nonreplayable': await onEvent({ event: events[4]! }); delivered.push(events[4]!); return completed();
      default: { const exhaustive: never = ending; throw new Error(`Unknown fixture ending: ${exhaustive}`); }
      }
    });
    const provider = new OPFSStorageProvider({ blobs: storage.context().blobs });
    await provider.init();
    const id = toChatId({ raw: 'transport-parts' });
    const node: AssistantMessageNode = {
      id: toMessageId({ raw: 'assistant' }), role: 'assistant', createdAt: 0,
      modelId: undefined, lmParameters: undefined, interruption: undefined, parts: [], replies: { items: [] },
    };
    const content = { root: { items: [node] }, currentLeafId: node.id };
    const save = () => provider.saveChatContent({ id, content });
    const items = createLlamaCppGeneration({
      request: { ...chatRequest(), model: request().model, signal: controller.signal },
      generate: ({ input, onEvent, signal }) => client.generate({ request: { ...input, options: request().options }, onEvent, onProgress: () => {}, signal }),
    });
    const result = consumeChatGeneration({ node, items, abortController: controller, onChange: save,
      onToolCallDraftsChange: ({ drafts }) => {
        draftSnapshots.push(structuredClone([...drafts]));
      },
    });
    try {
      await atDrain.promise;
      expect(host.read).toHaveBeenCalled(); expect(finalized).not.toHaveBeenCalled();
      switch (ending) {
      case 'stopped': controller.abort(); await vi.waitFor(() => expect(nativeSignal?.aborted).toBe(true)); break;
      case 'finished': case 'nonreplayable': break;
      default: { const exhaustive: never = ending; throw new Error(`Unknown fixture ending: ${exhaustive}`); }
      }
      resume.resolve(); const outcome = await result;
      switch (ending) {
      case 'finished': expect(outcome).toEqual({ type: 'finished', next: 'tool_results' }); break;
      case 'stopped': expect(outcome).toEqual({ type: 'interrupted', reason: 'aborted' }); break;
      case 'nonreplayable': expect(outcome.type).toBe('error'); break;
      default: { const exhaustive: never = ending; throw new Error(`Unknown fixture ending: ${exhaustive}`); }
      }
      await save();
      const loaded = await provider.loadChatContent({ id });
      expect(loaded).toEqual(content);
      expect(node.parts.slice(0, 3)).toEqual([
        { type: 'reasoning', text: `\
  reasoning\\r
🙂`, completeness: 'complete' },
        { type: 'text', text: '<think>literal</think> ', completeness: 'complete' },
        { type: 'tool_call', toolCall },
      ]);
      if (ending === 'nonreplayable') expect(node.parts[3]).toMatchObject({ type: 'text', text: ' tail\n', completeness: 'partial' });
      expect(delivered).toEqual(ending === 'nonreplayable' ? [...generated, events[4]!] : generated);
      expect(node.parts.map(part => part.type)).not.toContain('tool_call_draft');
      switch (ending) {
      case 'finished': case 'nonreplayable':
        expect(draftSnapshots.some(drafts => drafts.some(draft => draft.name === 'lookup' && draft.arguments === toolCall.function.arguments))).toBe(true);
        expect(draftSnapshots.at(-1)).toEqual([]);
        break;
      case 'stopped': expect(draftSnapshots.every(drafts => drafts.length === 0)).toBe(true); break;
      default: { const exhaustive: never = ending; throw new Error(`Unknown fixture ending: ${exhaustive}`); }
      }
      await vi.waitFor(() => expect(finalized).toHaveBeenCalledOnce());
    } finally {
      resume.resolve(); await result.catch(() => undefined); client.dispose();
    }
  });
});
