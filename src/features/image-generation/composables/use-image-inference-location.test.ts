import { afterEach, expect, it, vi } from 'vitest';
import { effectScope } from 'vue';
import { toBinaryObjectId, toNaidanRpcConnectionId, toNaidanRpcPeerId } from '@/01-models/ids';
import { createImageForm } from '@/features/image-generation/form';
import { useImageInferenceLocation } from './use-image-inference-location';
import type { RpcConnectionView } from '@/features/naidan-peer-rpc/runtime/manager';
import type { NaidanPeerClient, PeerImageModelSelection } from '@/features/naidan-peer-rpc/contract';
import { remoteImageFileKey } from '@/features/image-generation/remote-image-model-editor';

const mocks = vi.hoisted(() => ({ get: vi.fn(), subscribe: vi.fn(() => vi.fn()) }));
vi.mock('@/features/naidan-peer-rpc/runtime/feature', () => ({ getRpcManager: mocks.get, subscribeRpcState: mocks.subscribe }));
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup(); vi.clearAllMocks();
});
function setup() {
  const scope = effectScope(); cleanups.push(() => scope.stop());
  const form = createImageForm({ profile: 'webgpu-wasm32-asyncify' }); form.parameters.value.prompt = 'original';
  let blocked = false;
  const inferenceLocation = scope.run(() => useImageInferenceLocation({ form, blocked: () => blocked, identifyInput: () => toBinaryObjectId({ raw: 'input-image' }) }))!;
  const connection = { id: toNaidanRpcConnectionId({ raw: 'connection-one' }), peerId: toNaidanRpcPeerId({ raw: 'B'.repeat(43) }), label: 'Peer one' };
  const second = { id: toNaidanRpcConnectionId({ raw: 'connection-two' }), peerId: toNaidanRpcPeerId({ raw: 'C'.repeat(43) }), label: 'Peer two' };
  const listImageModels = vi.fn<NaidanPeerClient['listImageModels']>();
  const unexpected = vi.fn((): never => {
    throw new Error('No automatic generation or connection');
  });
  const client: NaidanPeerClient = { getProvidedMethods: unexpected, listImageModels, generateImage: unexpected, listChatModels: unexpected, generateChat: unexpected };
  const stop = new AbortController();
  const bindClient = vi.fn(() => ({ client, signal: stop.signal, connection }));
  const reload = vi.fn(async () => {}), list = vi.fn(() => [connection, second].map(connection => ({ connection, phase: 'connected' } as RpcConnectionView)));
  mocks.get.mockResolvedValue({ bindClient, reload, list });
  const selection: PeerImageModelSelection = { primary: { slot: 'model', file: { location: { kind: 'opfs', path: 'models/remote/model.gguf' } } }, components: [], loras: [] };
  return {
    inferenceLocation,
    form,
    connection,
    second,
    selection,
    unexpected,
    bindClient,
    reload,
    listImageModels,
    scope,
    block() {
      blocked = true;
    },
  };
}
it('selection and snapshot restoration do not fetch models, upload or compute', async () => {
  const h = setup(); expect(mocks.get).not.toHaveBeenCalled();
  await h.inferenceLocation.refresh({ fromStorage: true }); h.inferenceLocation.chooseConnection({ id: h.connection.id }); h.inferenceLocation.selectModel({ value: h.selection });
  const captured = h.inferenceLocation.snapshot({ seed: '42', createdAt: 1 });
  expect(captured.request.runtime.profile).toBe('naidan-rpc'); expect(captured.request.models).toEqual([]);
  expect(captured.request.parameters).not.toHaveProperty('modelArguments');
  expect(h.listImageModels).not.toHaveBeenCalled(); expect(h.unexpected).not.toHaveBeenCalled(); expect(h.bindClient).not.toHaveBeenCalled();
});
it('prepares against a fixed peer without requiring catalog access, freezing edits before await', async () => {
  const h = setup(); await h.inferenceLocation.refresh({ fromStorage: false }); h.inferenceLocation.chooseConnection({ id: h.connection.id }); h.inferenceLocation.selectModel({ value: h.selection });
  const preparing = h.inferenceLocation.prepare({ seed: '42', createdAt: 1, signal: new AbortController().signal });
  h.form.parameters.value.prompt = 'next'; h.selection.primary.file.location.path = 'other';
  const plan = await preparing;
  expect(plan.snapshot.request.parameters.prompt).toBe('original');
  expect(plan.snapshot.request.runtime).toMatchObject({ peerId: h.connection.peerId, modelSelection: { primary: { file: { location: { path: 'models/remote/model.gguf' } } } } });
  expect(h.listImageModels).not.toHaveBeenCalled(); expect(h.unexpected).not.toHaveBeenCalled();
});
it('does not silently apply a remote saved model to a changed identity', async () => {
  const h = setup(); await h.inferenceLocation.refresh({ fromStorage: false }); h.inferenceLocation.chooseConnection({ id: h.connection.id }); h.inferenceLocation.selectModel({ value: h.selection });
  h.connection.peerId = h.second.peerId;
  await expect(h.inferenceLocation.prepare({ seed: '42', createdAt: 1, signal: new AbortController().signal })).rejects.toThrow('different remote identity');
  expect(h.unexpected).not.toHaveBeenCalled();
});
it('drops late catalog output after switching connections and cancels the old call', async () => {
  const h = setup(); await h.inferenceLocation.refresh({ fromStorage: false }); h.inferenceLocation.chooseConnection({ id: h.connection.id });
  const gate = Promise.withResolvers<ReadableStream<never>>(), cancel = vi.fn();
  h.listImageModels.mockReturnValue({ result: gate.promise, closed: Promise.resolve(), cancel });
  const reading = h.inferenceLocation.loadModels(); await vi.waitFor(() => expect(h.listImageModels).toHaveBeenCalledOnce());
  const signal = h.listImageModels.mock.calls[0]![0].signal!;
  h.inferenceLocation.chooseConnection({ id: h.second.id }); expect(signal.aborted).toBe(true);
  gate.resolve(new ReadableStream({
    start(controller) {
      controller.close();
    },
  })); await reading;
  expect(h.inferenceLocation.catalog.value).toEqual([]); expect(h.inferenceLocation.connectionId.value).toBe(h.second.id); expect(h.inferenceLocation.loading.value).toBe(false);
});
it('prevents model and connection edits while a run owns the form', async () => {
  const h = setup(); await h.inferenceLocation.refresh({ fromStorage: false }); h.inferenceLocation.chooseConnection({ id: h.connection.id }); h.inferenceLocation.selectModel({ value: h.selection }); h.block();
  h.inferenceLocation.chooseConnection({ id: h.second.id }); h.inferenceLocation.selectModel({ value: {} }); await h.inferenceLocation.loadModels();
  expect(h.inferenceLocation.connectionId.value).toBe(h.connection.id); expect(h.inferenceLocation.selection.value).toEqual(h.selection); expect(h.listImageModels).not.toHaveBeenCalled();
});
it('keeps exact model components and disabled adapters separately for each peer', async () => {
  const h = setup(); await h.inferenceLocation.refresh({ fromStorage: false }); h.inferenceLocation.chooseConnection({ id: h.connection.id });
  const primary = { location: { kind: 'opfs' as const, path: 'models/z-image.gguf' } };
  const vae = { location: { kind: 'opfs' as const, path: 'models/vae.gguf' } };
  const lm = { location: { kind: 'opfs' as const, path: 'models/lm.gguf' } };
  const lora = { location: { kind: 'opfs' as const, path: 'models/lora.gguf' } };
  h.inferenceLocation.catalog.value = [
    { label: 'z-image', file: primary, roles: ['diffusion'], facts: { family: 'z-image', classes: [] } },
    { label: 'vae', file: vae, roles: ['vae'], facts: { family: 'unknown', classes: ['vae-flux16'] } },
    { label: 'lm', file: lm, roles: ['lm'], facts: { family: 'unknown', classes: ['lm-qwen3-4b'] } },
    { label: 'lora', file: lora, roles: ['lora'] },
  ];
  h.inferenceLocation.choosePrimary({ id: remoteImageFileKey({ file: primary }) });
  expect(h.inferenceLocation.ready.value).toBe(false);
  h.inferenceLocation.chooseComponent({ slot: 'vae', id: remoteImageFileKey({ file: vae }) });
  h.inferenceLocation.chooseComponent({ slot: 'lm', id: remoteImageFileKey({ file: lm }) });
  h.inferenceLocation.addLora({ id: remoteImageFileKey({ file: lora }) });
  h.inferenceLocation.changeLora({ index: 0, strength: 0.6, enabled: 'disabled' });
  expect(h.inferenceLocation.ready.value).toBe(true); expect(h.inferenceLocation.selection.value?.loras).toEqual([]);
  h.inferenceLocation.chooseConnection({ id: h.second.id }); h.inferenceLocation.selectModel({ value: h.selection });
  h.inferenceLocation.chooseConnection({ id: h.connection.id });
  expect(h.inferenceLocation.editor.value).toMatchObject({ primary: { file: primary }, loras: [{ enabled: 'disabled', strength: 0.6 }] });
  expect(h.inferenceLocation.selection.value?.components).toEqual([{ slot: 'vae', file: vae }, { slot: 'lm', file: lm }]);
  expect(h.unexpected).not.toHaveBeenCalled(); expect(h.listImageModels).not.toHaveBeenCalled();
});
it('restores a missing peer reference and explicit empty editor without replacing it on refresh', async () => {
  const h = setup();
  const savedPeer = toNaidanRpcPeerId({ raw: 'D'.repeat(43) });
  h.inferenceLocation.restorePreferences({
    inferenceLocation: { kind: 'naidan_rpc', connection: { connectionId: h.connection.id, peerId: savedPeer } },
    remoteModelEditors: [{ connectionId: h.connection.id, peerId: savedPeer, editor: { primary: undefined, components: [], loras: [] } }],
  });
  await h.inferenceLocation.refresh({ fromStorage: true });
  expect(h.inferenceLocation.peerId.value).toBe(savedPeer); expect(h.inferenceLocation.connected.value).toBe(false); expect(h.inferenceLocation.editor.value.primary).toBeUndefined();
  expect(h.inferenceLocation.capturePreferences().inferenceLocation).toEqual({ kind: 'naidan_rpc', connection: { connectionId: h.connection.id, peerId: savedPeer } });
  expect(h.unexpected).not.toHaveBeenCalled(); expect(h.listImageModels).not.toHaveBeenCalled();
});
it('does not persist a temporary connection or its models as a durable reference', async () => {
  const h = setup(); await h.inferenceLocation.refresh({ fromStorage: false }); h.inferenceLocation.chooseConnection({ id: h.connection.id }); h.inferenceLocation.setKind({ value: 'naidan_rpc' });
  h.inferenceLocation.entries.value[0]!.persistence = 'temporary'; h.inferenceLocation.entries.value[0]!.registryPersistence = undefined;
  h.inferenceLocation.selectModel({ value: h.selection });
  expect(h.inferenceLocation.capturePreferences()).toEqual({ inferenceLocation: { kind: 'naidan_rpc', connection: undefined }, remoteModelEditors: [] });
  h.inferenceLocation.entries.value[0]!.persistence = 'saved'; h.inferenceLocation.entries.value[0]!.registryPersistence = 'durable';
  expect(h.inferenceLocation.capturePreferences().remoteModelEditors).toHaveLength(1);
});
it('history reuse resets adapters rather than merging another editor into a past request', async () => {
  const h = setup(); await h.inferenceLocation.refresh({ fromStorage: false }); h.inferenceLocation.chooseConnection({ id: h.connection.id });
  const selection = { ...h.selection, loras: [{ file: h.selection.primary.file, strength: 0.4 }] };
  h.inferenceLocation.selectModel({ value: selection }); h.inferenceLocation.changeLora({ index: 0, strength: 0.4, enabled: 'disabled' });
  h.inferenceLocation.restore({ value: { profile: 'naidan-rpc', connectionId: h.connection.id, peerId: h.connection.peerId, label: 'Peer', modelSelection: h.selection }, modelEditor: undefined });
  expect(h.inferenceLocation.editor.value.loras).toEqual([]); expect(h.selection.loras).toEqual([]);
});
export const TEST_ONLY = {
};
