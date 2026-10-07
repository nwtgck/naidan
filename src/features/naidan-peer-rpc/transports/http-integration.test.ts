// @vitest-environment node
import { readFile } from 'node:fs/promises';
import { expect, it, vi } from 'vitest';
import { createHttpRelay } from './test-support/http-relay';
import { openPipingRpc } from './piping';
import { createNaidanPipingIdentity } from '@/features/naidan-piping-duplex';
import type { NaidanPipingIdentity, NaidanPipingPeerVerifier } from '@/features/naidan-piping-duplex';
import { NaidanPeerManager } from '@/features/naidan-peer-rpc/runtime/manager';
import { createInferenceBudget } from '@/features/naidan-peer-rpc/handlers/inference/budget';
import type { ReadOnlyInferenceResources } from '@/features/naidan-peer-rpc/handlers/inference/resources';
import type { NaidanRpcConnection } from '@/01-models/naidan-rpc';
import { toNaidanRpcRegistryId } from '@/01-models/ids';
import type { NaidanRpcRegistryAccess } from '@/00-storage/service/naidan-rpc';
import { prepareTranscript, receiveEvents } from '@/features/naidan-peer-rpc/codecs/chat-wire';
import { startPeerImage } from '@/features/naidan-peer-rpc/adapters/image-provider';
import { promiseAllKeyed } from '@/utils/promise';

function endpoint({ identity, png }: { identity: NaidanPipingIdentity, png: Uint8Array<ArrayBuffer> }) {
  const answer = 'Private streamed answer. '.repeat(4096);
  const resources: ReadOnlyInferenceResources = {
    listChatModels: vi.fn(async () => [{ ref: 'models/test.gguf', label: 'Private test model' }]),
    generateChat: vi.fn<ReadOnlyInferenceResources['generateChat']>(async ({ onEvent }) => {
      for (let at = 0; at < answer.length; at += 1024) await onEvent({ event: { type: 'text', text: answer.slice(at, at + 1024) } });
      return { content: answer, reasoningContent: '', toolCalls: [], finishReason: 'stop' };
    }),
    listImageModels: vi.fn(async () => []),
    generateImage: vi.fn(async () => ({ png: new Blob([png], { type: 'image/png' }), width: 128, height: 128, modelVersion: 'fixture', uniformOutput: false })),
  };
  const saved = new Map<NaidanRpcConnection['id'], NaidanRpcConnection>();
  const access: NaidanRpcRegistryAccess = { providerGeneration: 1, registryId: toNaidanRpcRegistryId({ raw: 'http-registry-example' }), persistence: 'durable' };
  const store = {
    readIdentity: vi.fn(async () => undefined),
    list: vi.fn(async () => ({ access, connections: [...saved.values()] })),
    remember: vi.fn(async ({ connection }: { connection: NaidanRpcConnection }) => {
      saved.set(connection.id, connection); return access;
    }),
    update: vi.fn(async ({ connection }: { connection: NaidanRpcConnection }) => {
      saved.set(connection.id, connection); return connection.revision;
    }),
    remove: vi.fn(async ({ id }: { id: NaidanRpcConnection['id'] }) => {
      saved.delete(id);
    }),
  };
  const release = vi.fn();
  const inputBudget = createInferenceBudget({ capacity: 256 * 1024 * 1024 }), deliveryBudget = createInferenceBudget({ capacity: 128 * 1024 * 1024 });
  const observed = { connected: false };
  const manager: NaidanPeerManager = new NaidanPeerManager({
    dependencies: {
    storage: store,
    identity: async () => identity,
    acquireOwner: async () => ({ release }),
    open: openPipingRpc,
    inference: { resources, inputBudget, deliveryBudget },
    changed: () => {
      observed.connected ||= manager.list().some(entry => entry.phase === 'connected');
    },
    retireResources: async () => {
      await Promise.all([inputBudget.whenIdle(), deliveryBudget.whenIdle()]);
    },
  },
  });
  return { manager, resources, store, release, answer, inputBudget, deliveryBudget, observed };
}

it('pairs, denies, streams, retries an HTTP acknowledgement and reconnects explicitly over real loopback fetch', async () => {
  const relay = await createHttpRelay();
  const lifetime = new AbortController();
  const watchdog = setTimeout(() => lifetime.abort(new Error('Loopback integration watchdog')), 25000);
  const png = new Uint8Array(await readFile(new URL('../codecs/fixtures/loopback.png', import.meta.url)));
  const { first, second } = await promiseAllKeyed({ first: createNaidanPipingIdentity(), second: createNaidanPipingIdentity() });
  const a = endpoint({ identity: first, png }), b = endpoint({ identity: second, png });
  const settings = { type: 'naidan_piping_duplex' as const, serverUrl: relay.origin, headers: [{ name: 'X-Relay-Test', value: 'authorized' }] };
  const compared: Uint8Array[] = [];
  const verifier: NaidanPipingPeerVerifier = async ({ comparison }) => {
    compared.push(comparison.slice()); return true;
  };
  try {
    await Promise.all([a.manager.setEnabled({ enabled: true }), b.manager.setEnabled({ enabled: true })]);
    expect(relay.stats().requests).toBe(0);
    const paired = await promiseAllKeyed({
      aId: a.manager.pair({ settings, code: '3907', verifyPeer: verifier, signal: lifetime.signal }),
      bId: b.manager.pair({ settings, code: '3907', verifyPeer: verifier, signal: lifetime.signal }),
    });
    expect(compared).toHaveLength(2); expect(compared[0]).toHaveLength(32); expect(compared[0]).toEqual(compared[1]);
    expect(a.store.remember).not.toHaveBeenCalled(); expect(b.store.remember).not.toHaveBeenCalled();
    const client = a.manager.client({ id: paired.aId });
    const denied = client.listChatModels({ input: {}, on: {}, signal: lifetime.signal, timeoutMs: undefined });
    await expect(denied.result).rejects.toMatchObject({ code: 'METHOD_NOT_ALLOWED' });
    await expect(denied.closed).rejects.toMatchObject({ code: 'METHOD_NOT_ALLOWED' });
    expect(b.resources.listChatModels).not.toHaveBeenCalled();
    await b.manager.updateAllowedMethods({ id: paired.bId, allowedMethods: ['listChatModels', 'generateChat', 'generateImage'] });
    relay.dropNextAcknowledgement();
    const input = {
      model: 'models/test.gguf',
      messages: [{ role: 'user' as const, content: 'Private question.' }],
      temperature: 0.7,
      topP: 0.9,
      maxTokens: 2048,
      presencePenalty: 0,
      frequencyPenalty: 0,
      stop: [],
    };
    const chat = client.generateChat({ input: { model: input.model, ...prepareTranscript({ input }) }, on: { progress: undefined }, signal: lifetime.signal, timeoutMs: undefined });
    const output = await chat.result;
    const answer = await receiveEvents({ readable: output.events, onEvent: () => {}, signal: lifetime.signal });
    await chat.closed;
    expect(answer.content).toBe(b.answer); expect(b.resources.generateChat).toHaveBeenCalledOnce(); expect(relay.stats().dropped).toBe(1);
    const job = startPeerImage({
      client,
      input: {
      modelSelection: { primary: { slot: 'model', file: { location: { kind: 'opfs', path: 'models/test.safetensors' } } }, components: [], loras: [] },
      parameters: { prompt: 'Private image prompt.', negativePrompt: '', width: 128, height: 128, seed: '7', steps: 1, guidance: 1, sampler: 'auto', scheduler: 'auto', distilledGuidance: 1 },
      preview: { enabled: false, interval: 1, startStep: 1, mode: 'projection', maxEdge: 0 },
      imageInputs: { initial: undefined, references: [], strength: 0.5 },
    },
      signal: lifetime.signal,
      onPreview: () => {},
      onProgress: () => {},
    });
    const image = await job.result;
    expect(image.status).toBe('completed');
    if (image.status !== 'completed') throw new Error('Expected a confirmed image');
    expect(new Uint8Array(await image.output.png.arrayBuffer())).toEqual(png); expect(b.resources.generateImage).toHaveBeenCalledOnce();
    expect(relay.stats().rejected).toBe(0);
    for (const frame of relay.stats().frames) {
      expect(frame.includes(Buffer.from('Private question.'))).toBe(false);
      expect(frame.includes(Buffer.from('Private streamed answer.'))).toBe(false);
      expect(frame.includes(Buffer.from('Private image prompt.'))).toBe(false);
    }
    await Promise.all([a.manager.remember({ id: paired.aId, label: 'B' }), b.manager.remember({ id: paired.bId, label: 'A' })]);
    await Promise.all([a.manager.disconnect({ id: paired.aId }), b.manager.disconnect({ id: paired.bId })]);
    expect(a.manager.list()[0]?.phase).toBe('disconnected'); expect(b.manager.list()[0]?.phase).toBe('disconnected');
    await Promise.all([a.manager.connect({ id: paired.aId }), b.manager.connect({ id: paired.bId })]);
    expect(compared).toHaveLength(2);
    const catalog = a.manager.client({ id: paired.aId }).listChatModels({ input: {}, on: {}, signal: lifetime.signal, timeoutMs: undefined });
    const reader = (await catalog.result).getReader();
    expect((await reader.read()).value?.ref).toBe('models/test.gguf'); expect((await reader.read()).done).toBe(true); reader.releaseLock();
    await catalog.closed;
    expect(b.resources.generateChat).toHaveBeenCalledOnce(); expect(b.resources.generateImage).toHaveBeenCalledOnce();
  } finally {
    lifetime.abort();
    await Promise.allSettled([a.manager.setEnabled({ enabled: false }), b.manager.setEnabled({ enabled: false })]);
    await relay.close(); clearTimeout(watchdog);
  }
  expect(a.release).toHaveBeenCalledOnce(); expect(b.release).toHaveBeenCalledOnce();
  expect(a.inputBudget.reserved + b.inputBudget.reserved + a.deliveryBudget.reserved + b.deliveryBudget.reserved).toBe(0);
}, 30000);

it('rejecting the full comparison over real HTTP never publishes trust or an inference connection', async () => {
  const relay = await createHttpRelay(), lifetime = new AbortController();
  const watchdog = setTimeout(() => lifetime.abort(new Error('Loopback rejection watchdog')), 10000);
  const png = new Uint8Array(await readFile(new URL('../codecs/fixtures/loopback.png', import.meta.url)));
  const { first, second } = await promiseAllKeyed({ first: createNaidanPipingIdentity(), second: createNaidanPipingIdentity() });
  const a = endpoint({ identity: first, png }), b = endpoint({ identity: second, png });
  const settings = { type: 'naidan_piping_duplex' as const, serverUrl: relay.origin, headers: [{ name: 'X-Relay-Test', value: 'authorized' }] };
  const rejectPeer = vi.fn<NaidanPipingPeerVerifier>(async () => false);
  let other: Promise<unknown> | undefined;
  try {
    await Promise.all([a.manager.setEnabled({ enabled: true }), b.manager.setEnabled({ enabled: true })]);
    const denied = a.manager.pair({ settings, code: '0921', verifyPeer: rejectPeer, signal: lifetime.signal });
    // Observe both pending attempts immediately. Cancel the remaining discovery
    // explicitly once refusal has completed; no arbitrary inference deadline.
    other = b.manager.pair({ settings, code: '0921', verifyPeer: async () => true, signal: lifetime.signal });
    void other.catch(() => {});
    await expect(denied).rejects.toBeDefined(); lifetime.abort();
    await expect(other).rejects.toBeDefined();
    expect(rejectPeer).toHaveBeenCalledOnce(); expect(relay.stats().requests).toBeGreaterThan(0);
    expect(a.manager.list()).toEqual([]); expect(b.manager.list()).toEqual([]);
    expect(a.observed.connected).toBe(false); expect(b.observed.connected).toBe(false);
    expect(a.store.remember).not.toHaveBeenCalled(); expect(b.store.remember).not.toHaveBeenCalled();
    expect(a.resources.listChatModels).not.toHaveBeenCalled(); expect(b.resources.listChatModels).not.toHaveBeenCalled();
    expect(a.resources.generateChat).not.toHaveBeenCalled(); expect(b.resources.generateChat).not.toHaveBeenCalled();
  } finally {
    lifetime.abort(); await other?.catch(() => {});
    await Promise.allSettled([a.manager.setEnabled({ enabled: false }), b.manager.setEnabled({ enabled: false })]);
    await relay.close(); clearTimeout(watchdog);
  }
  expect(a.release).toHaveBeenCalledOnce(); expect(b.release).toHaveBeenCalledOnce();
});

export const TEST_ONLY = {
};
