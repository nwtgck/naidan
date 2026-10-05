import { afterEach, expect, it, vi } from 'vitest';
import { effectScope } from 'vue';
import { toBinaryObjectId, toNaidanRpcConnectionId, toNaidanRpcPeerId } from '@/01-models/ids';
import { createImageForm } from '@/features/image-generation/form';
import { useImageExecutionTarget } from './use-image-execution-target';
import type { RpcConnectionView } from '@/features/naidan-peer-rpc/runtime/manager';
import type { NaidanPeerClient, PeerImageModelSelection } from '@/features/naidan-peer-rpc/contract';

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
  const target = scope.run(() => useImageExecutionTarget({ form, blocked: () => blocked, identifyInput: () => toBinaryObjectId({ raw: 'input-image' }) }))!;
  const connection = { id: toNaidanRpcConnectionId({ raw: 'connection-one' }), peerId: toNaidanRpcPeerId({ raw: 'B'.repeat(43) }), label: 'Peer one' };
  const second = { id: toNaidanRpcConnectionId({ raw: 'connection-two' }), peerId: toNaidanRpcPeerId({ raw: 'C'.repeat(43) }), label: 'Peer two' };
  const listImageModels = vi.fn<NaidanPeerClient['listImageModels']>();
  const unexpected = vi.fn((): never => {
    throw new Error('No automatic generation or connection');
  });
  const client: NaidanPeerClient = { listImageModels, generateImage: unexpected, listChatModels: unexpected, generateChat: unexpected };
  const stop = new AbortController();
  const bindClient = vi.fn(() => ({ client, signal: stop.signal, connection }));
  const reload = vi.fn(async () => {}), list = vi.fn(() => [connection, second].map(connection => ({ connection, phase: 'connected' } as RpcConnectionView)));
  mocks.get.mockResolvedValue({ bindClient, reload, list });
  const selection: PeerImageModelSelection = { primary: { slot: 'model', file: { location: { kind: 'opfs', path: 'models/remote/model.gguf' } } }, components: [], loras: [] };
  return { target, form, connection, second, selection, unexpected, bindClient, reload, listImageModels, scope,
    block() {
      blocked = true;
    } };
}
it('selection and snapshot restoration do not fetch models, upload or compute', async () => {
  const h = setup(); expect(mocks.get).not.toHaveBeenCalled();
  await h.target.refresh({ fromStorage: true }); h.target.chooseConnection({ id: h.connection.id }); h.target.selectModel({ value: h.selection });
  const captured = h.target.snapshot({ seed: '42', createdAt: 1 });
  expect(captured.request.runtime.profile).toBe('naidan-rpc'); expect(captured.request.models).toEqual([]);
  expect(captured.request.parameters).not.toHaveProperty('modelArguments');
  expect(h.listImageModels).not.toHaveBeenCalled(); expect(h.unexpected).not.toHaveBeenCalled(); expect(h.bindClient).not.toHaveBeenCalled();
});
it('prepares against a fixed peer without requiring catalog access, freezing edits before await', async () => {
  const h = setup(); await h.target.refresh({ fromStorage: false }); h.target.chooseConnection({ id: h.connection.id }); h.target.selectModel({ value: h.selection });
  const preparing = h.target.prepare({ seed: '42', createdAt: 1, signal: new AbortController().signal });
  h.form.parameters.value.prompt = 'next'; h.selection.primary.file.location.path = 'other';
  const plan = await preparing;
  expect(plan.snapshot.request.parameters.prompt).toBe('original');
  expect(plan.snapshot.request.runtime).toMatchObject({ peerId: h.connection.peerId, modelSelection: { primary: { file: { location: { path: 'models/remote/model.gguf' } } } } });
  expect(h.listImageModels).not.toHaveBeenCalled(); expect(h.unexpected).not.toHaveBeenCalled();
});
it('does not silently apply a remote saved model to a changed identity', async () => {
  const h = setup(); await h.target.refresh({ fromStorage: false }); h.target.chooseConnection({ id: h.connection.id }); h.target.selectModel({ value: h.selection });
  h.connection.peerId = h.second.peerId;
  await expect(h.target.prepare({ seed: '42', createdAt: 1, signal: new AbortController().signal })).rejects.toThrow('different remote identity');
  expect(h.unexpected).not.toHaveBeenCalled();
});
it('drops late catalog output after switching connections and cancels the old call', async () => {
  const h = setup(); await h.target.refresh({ fromStorage: false }); h.target.chooseConnection({ id: h.connection.id });
  const gate = Promise.withResolvers<ReadableStream<never>>(), cancel = vi.fn();
  h.listImageModels.mockReturnValue({ result: gate.promise, closed: Promise.resolve(), cancel });
  const reading = h.target.loadModels(); await vi.waitFor(() => expect(h.listImageModels).toHaveBeenCalledOnce());
  const signal = h.listImageModels.mock.calls[0]![0].signal!;
  h.target.chooseConnection({ id: h.second.id }); expect(signal.aborted).toBe(true);
  gate.resolve(new ReadableStream({ start(controller) {
    controller.close();
  } })); await reading;
  expect(h.target.catalog.value).toEqual([]); expect(h.target.connectionId.value).toBe(h.second.id); expect(h.target.loading.value).toBe(false);
});
it('prevents model and connection edits while a run owns the form', async () => {
  const h = setup(); await h.target.refresh({ fromStorage: false }); h.target.chooseConnection({ id: h.connection.id }); h.target.selectModel({ value: h.selection }); h.block();
  h.target.chooseConnection({ id: h.second.id }); h.target.selectModel({ value: {} }); await h.target.loadModels();
  expect(h.target.connectionId.value).toBe(h.connection.id); expect(h.target.selection.value).toEqual(h.selection); expect(h.listImageModels).not.toHaveBeenCalled();
});
export const TEST_ONLY = {
};
