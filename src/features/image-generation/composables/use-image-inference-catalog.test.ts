import { expect, it, vi } from 'vitest';
import { effectScope, nextTick, ref } from 'vue';
import { toBinaryObjectId, toNaidanRpcRegistrationId, toNaidanRpcPeerPublicKey } from '@/01-models/ids';
import type { RemoteImageModelEditor } from '@/01-models/image-generation-preferences';
import type { NaidanPeerClient, PeerImageCatalogItem } from '@/features/naidan-rpc-integration/contract';
import type { RpcRegistrationView } from '@/features/naidan-rpc-integration/runtime/manager';
import { createImageForm } from '@/features/image-generation/form';
import { emptyRemoteImageModelEditor, remoteImageFileKey } from '@/features/image-generation/remote-image-model-editor';
import { imageCatalogFixture } from '@/features/image-generation/model-selection.test-support';
import { useImageInferenceLocation } from './use-image-inference-location';

const mocks = vi.hoisted(() => ({ get: vi.fn(), subscribe: vi.fn(() => vi.fn()) }));
vi.mock('@/features/naidan-rpc-integration/runtime/feature', () => ({ getRpcManager: mocks.get, subscribeRpcState: mocks.subscribe }));

function catalogCall({ items, closed = Promise.resolve() }: { items: PeerImageCatalogItem[], closed?: Promise<void> }): ReturnType<NaidanPeerClient['listImageModels']> {
  return {
    result: Promise.resolve(new ReadableStream({
      start(controller) {
        items.forEach(item => controller.enqueue(item));
        controller.close();
      },
    })),
    closed,
    cancel: vi.fn(),
  };
}

function harness() {
  const stop = new AbortController();
  const row: RpcRegistrationView = {
    registration: {
      id: toNaidanRpcRegistrationId({ raw: 'image-peer' }),
      peerPublicKey: toNaidanRpcPeerPublicKey({ raw: 'B'.repeat(43) }),
      localPublicKey: 'A'.repeat(43),
      label: 'Image peer',
      transport: { type: 'naidan_piping_duplex', serverUrl: 'https://relay.example', headers: [] },
      inboundAllowedMethods: [],
      connectOnStartup: 'disabled',
      revision: 0,
    },
    phase: 'connected',
    desiredConnection: 'connected',
    recoveryStatus: 'ready',
    health: undefined,
    persistence: 'saved',
    registryPersistence: 'durable',
    access: { effective: [], desired: [], saved: [], revision: 0, persistence: 'saved' },
    failure: undefined,
    connectionToken: stop.signal,
  };
  const scope = effectScope(), blocked = ref(false);
  const form = createImageForm({ profile: 'webgpu-wasm32-asyncify' });
  const catalog = imageCatalogFixture({});
  const listImageModels = vi.fn<NaidanPeerClient['listImageModels']>(() => catalogCall({ items: catalog }));
  const bind = vi.fn(() => ({ registration: row.registration, signal: stop.signal, client: { listImageModels } }));
  const manager = { list: () => [{ ...row }], reload: vi.fn(async () => {}), bindClient: bind };
  mocks.get.mockResolvedValue(manager);
  const location = scope.run(() => useImageInferenceLocation({ form, blocked: () => blocked.value, identifyInput: () => toBinaryObjectId({ raw: 'image-input' }) }))!;
  const reference = { kind: 'naidan_rpc' as const, registration: { registrationId: row.registration.id, peerPublicKey: row.registration.peerPublicKey } };
  return {
    location,
    catalog,
    form,
    blocked,
    row,
    stop,
    listImageModels,
    bind,
    manager,
    reference,
    async start({ editor }: { editor?: RemoteImageModelEditor }) {
      location.restorePreferences({ inferenceLocation: reference, remoteModelEditors: editor ? [{ ...reference.registration, editor }] : [] });
      await location.refresh({ fromStorage: false });
    },
    async activate() {
      location.setCatalogActivity({ active: true, enabled: true });
      await vi.waitFor(() => expect(location.catalogFresh.value).toBe(true));
    },
    [Symbol.dispose]() {
      scope.stop();
      stop.abort();
    },
  };
}

it('automatically loads only for an active enabled connected remote editor, once per session', async () => {
  using h = harness();
  await h.start({});
  await nextTick();
  expect(h.listImageModels).not.toHaveBeenCalled();
  h.location.setCatalogActivity({ active: true, enabled: false });
  await nextTick();
  expect(h.listImageModels).not.toHaveBeenCalled();
  await h.activate();
  expect(h.listImageModels).toHaveBeenCalledOnce();
  expect(h.location.editor.value).toMatchObject({ primary: { family: 'z-image' }, automaticSlots: ['vae', 'lm'] });
  expect(h.location.ready.value).toBe(true);
  expect(h.form.parameters.value).toMatchObject({ steps: 8, guidance: 1 });
  h.location.setCatalogActivity({ active: false, enabled: true });
  h.location.setCatalogActivity({ active: true, enabled: true });
  await h.location.refresh({ fromStorage: false });
  await nextTick();
  expect(h.listImageModels).toHaveBeenCalledOnce();
  expect(h.manager.reload).toHaveBeenCalled();
  expect(h.bind).toHaveBeenCalledOnce();
});

it('does not connect a disconnected peer or load while the form is owned by generation', async () => {
  using h = harness();
  h.row.phase = 'disconnected';
  h.row.connectionToken = undefined;
  await h.start({});
  h.location.setCatalogActivity({ active: true, enabled: true });
  await nextTick();
  expect(h.bind).not.toHaveBeenCalled();
  h.blocked.value = true;
  h.row.phase = 'connected';
  h.row.connectionToken = h.stop.signal;
  await h.location.refresh({ fromStorage: false });
  await nextTick();
  expect(h.bind).not.toHaveBeenCalled();
  h.blocked.value = false;
  await vi.waitFor(() => expect(h.location.ready.value).toBe(true));
});

it('never persists an invented empty editor during restoration or an empty catalog scan', async () => {
  using h = harness();
  h.listImageModels.mockImplementation(() => catalogCall({ items: [] }));
  await h.start({});
  expect(h.location.capturePreferences().remoteModelEditors).toEqual([]);
  await h.activate();
  expect(h.location.capturePreferences().remoteModelEditors).toEqual([]);
  h.listImageModels.mockImplementation(() => catalogCall({ items: h.catalog }));
  await h.location.loadModels();
  expect(h.location.ready.value).toBe(true);
});

it('preserves an explicit empty saved editor instead of automatically selecting a model', async () => {
  using h = harness();
  await h.start({ editor: emptyRemoteImageModelEditor() });
  await h.activate();
  expect(h.location.editor.value).toEqual(emptyRemoteImageModelEditor());
  expect(h.location.capturePreferences().remoteModelEditors).toHaveLength(1);
});

it('manual none remains none across refresh and can explicitly return to automatic', async () => {
  using h = harness();
  await h.start({});
  await h.activate();
  h.location.chooseComponent({ slot: 'vae', id: '' });
  await h.location.loadModels();
  expect(h.location.editor.value.automaticSlots).toEqual(['lm']);
  expect(h.location.ready.value).toBe(false);
  expect(h.location.editor.value.components.map(item => item.slot)).toEqual(['lm']);
  h.location.setComponentAutomatic({ slot: 'vae', automatic: true });
  expect(h.location.ready.value).toBe(true);
  h.location.setComponentAutomatic({ slot: 'vae', automatic: false });
  expect(h.location.ready.value).toBe(true);
  expect(h.location.editor.value.automaticSlots).toEqual(['lm']);
});

it('refresh keeps user parameters and same-primary selection keeps reference images', async () => {
  using h = harness();
  await h.start({});
  await h.activate();
  h.form.parameters.value.steps = 37;
  const image = new File(['image'], 'reference.png');
  h.form.imageInputs.value.referenceImages = [image];
  await h.location.loadModels();
  h.location.choosePrimary({ id: h.location.primaryKey.value });
  expect(h.form.parameters.value.steps).toBe(37);
  expect(h.form.imageInputs.value.referenceImages).toEqual([image]);
});

it('stops automatic companions at a replaced pinned primary and lets reselection adopt the new file', async () => {
  using h = harness();
  await h.start({});
  await h.activate();
  h.location.choosePrimary({ id: h.location.primaryKey.value });
  const before = h.location.editor.value;
  const next = structuredClone(h.catalog);
  next[0]!.file.expected!.lastModified++;
  next[1]!.file.expected!.lastModified++;
  h.listImageModels.mockImplementation(() => catalogCall({ items: next }));
  await h.location.loadModels();
  expect(h.location.editor.value).toEqual(before);
  expect(h.location.ready.value).toBe(false);
  expect(h.location.selectedFilesChanged.value).toBe(true);
  h.location.choosePrimary({ id: h.location.primaryKey.value });
  expect(h.location.editor.value.primary!.file.expected!.lastModified).toBe(43);
  expect(h.location.ready.value).toBe(true);
});

it('freezes a history composition and does not overwrite remembered editor or parameters', async () => {
  using h = harness();
  await h.start({});
  await h.activate();
  const saved = h.location.capturePreferences();
  const selection = h.location.selection.value!;
  h.form.parameters.value.steps = 39;
  h.location.restore({ value: { profile: 'naidan-rpc', ...h.reference.registration, label: 'Peer', modelSelection: selection }, modelEditor: h.location.editor.value });
  expect(h.location.editor.value.automaticSlots).toEqual([]);
  await h.location.loadModels();
  expect(h.location.capturePreferences()).toEqual(saved);
  expect(h.location.selection.value).toEqual(selection);
  expect(h.form.parameters.value.steps).toBe(39);
});

it('keeps an old manual configuration usable without catalog permission and never retries a denied auto load', async () => {
  using h = harness();
  const catalog = imageCatalogFixture({ family: 'sd-checkpoint' });
  const editor: RemoteImageModelEditor = { primary: { slot: 'model', file: catalog[0]!.file, family: 'sd-checkpoint' }, components: [], loras: [], automaticSlots: [] };
  h.listImageModels.mockImplementation(() => {
    throw new Error('Permission denied');
  });
  await h.start({ editor });
  h.location.setCatalogActivity({ active: true, enabled: true });
  await vi.waitFor(() => expect(h.location.failure.value).toContain('Permission denied'));
  expect(h.location.ready.value).toBe(true);
  h.location.setCatalogActivity({ active: false, enabled: true });
  h.location.setCatalogActivity({ active: true, enabled: true });
  await h.location.refresh({ fromStorage: false });
  await nextTick();
  expect(h.listImageModels).toHaveBeenCalledOnce();
});

it('supports legacy catalogs manually and never automatically supplies missing companions', async () => {
  using h = harness();
  const catalog = imageCatalogFixture({});
  catalog.forEach(item => {
    delete item.selectionHints;
  });
  h.listImageModels.mockImplementation(() => catalogCall({ items: catalog }));
  await h.start({});
  await h.activate();
  expect(h.location.canAutomaticallySelect.value).toBe(false);
  expect(h.location.editor.value.primary).toBeUndefined();
  h.location.choosePrimary({ id: remoteImageFileKey({ file: catalog[0]!.file }) });
  expect(h.location.editor.value.automaticSlots).toEqual([]);
  for (const slot of ['vae', 'lm'] as const) {
    h.location.chooseComponent({ slot, id: remoteImageFileKey({ file: catalog.find(item => item.roles.includes(slot))!.file }) });
  }
  expect(h.location.ready.value).toBe(true);
});

it('does not publish a partial stream until the terminal acknowledgement succeeds', async () => {
  using h = harness();
  const closed = Promise.withResolvers<void>();
  h.listImageModels.mockImplementation(() => catalogCall({ items: h.catalog, closed: closed.promise }));
  await h.start({});
  const loading = h.location.loadModels();
  await vi.waitFor(() => expect(h.listImageModels).toHaveBeenCalledOnce());
  expect(h.location.catalog.value).toEqual([]);
  expect(h.location.editor.value.primary).toBeUndefined();
  closed.reject(new Error('Terminal error'));
  await loading;
  expect(h.location.failure.value).toContain('Terminal error');
  expect(h.location.catalogFresh.value).toBe(false);
  expect(h.location.capturePreferences().remoteModelEditors).toEqual([]);
});

it.each(['duplicate', 'oversize', 'invalid'] as const)('rejects an entire %s stream, preserving the previous editor', async kind => {
  using h = harness();
  await h.start({});
  await h.activate();
  const previous = h.location.editor.value;
  const items = kind === 'duplicate' ? [h.catalog[0]!, h.catalog[0]!] : kind === 'oversize' ? Array.from({ length: 257 }, () => h.catalog[0]!) : [{ ...h.catalog[0]!, roles: [] }];
  h.listImageModels.mockImplementation(() => catalogCall({ items }));
  await h.location.loadModels();
  expect(h.location.failure.value).not.toBe('');
  expect(h.location.catalogFresh.value).toBe(false);
  expect(h.location.catalogStale.value).toBe(true);
  expect(h.location.editor.value).toEqual(previous);
});

it('manual clearing during a scan wins over the scan completion', async () => {
  using h = harness();
  const closed = Promise.withResolvers<void>();
  h.listImageModels.mockImplementation(() => catalogCall({ items: h.catalog, closed: closed.promise }));
  await h.start({});
  const loading = h.location.loadModels();
  await vi.waitFor(() => expect(h.listImageModels).toHaveBeenCalledOnce());
  h.location.choosePrimary({ id: '' });
  closed.resolve();
  await loading;
  expect(h.location.editor.value.primary).toBeUndefined();
  expect(h.location.catalogFresh.value).toBe(true);
});

it('cancels an invisible editor scan and retries upon reactivation without retaining its partial result', async () => {
  using h = harness();
  const gate = Promise.withResolvers<ReadableStream<PeerImageCatalogItem>>();
  const cancel = vi.fn();
  h.listImageModels.mockReturnValueOnce({ result: gate.promise, closed: Promise.resolve(), cancel });
  await h.start({});
  h.location.setCatalogActivity({ active: true, enabled: true });
  await vi.waitFor(() => expect(h.listImageModels).toHaveBeenCalledOnce());
  h.location.setCatalogActivity({ active: false, enabled: true });
  expect(cancel).toHaveBeenCalledOnce();
  gate.resolve(new ReadableStream({
    start(controller) {
      controller.close();
    },
  }));
  await vi.waitFor(() => expect(h.location.loading.value).toBe(false));
  expect(h.location.catalogFresh.value).toBe(false);
  await h.activate();
  expect(h.listImageModels).toHaveBeenCalledTimes(2);
});

it('drops a late same-peer old-session reply and publishes only the new session', async () => {
  using h = harness();
  const oldResult = Promise.withResolvers<ReadableStream<PeerImageCatalogItem>>();
  const cancel = vi.fn();
  h.listImageModels.mockReturnValueOnce({ result: oldResult.promise, closed: Promise.resolve(), cancel });
  await h.start({});
  const oldLoad = h.location.loadModels();
  await vi.waitFor(() => expect(h.listImageModels).toHaveBeenCalledOnce());
  const nextStop = new AbortController();
  h.row.connectionToken = nextStop.signal;
  h.bind.mockImplementation(() => ({ registration: h.row.registration, signal: nextStop.signal, client: { listImageModels: h.listImageModels } }));
  await h.location.refresh({ fromStorage: false });
  expect(cancel).toHaveBeenCalledOnce();
  await h.location.loadModels();
  const nextEditor = h.location.editor.value;
  oldResult.resolve(new ReadableStream({
    start(controller) {
      controller.enqueue({ ...h.catalog[0]!, label: 'old session' });
      controller.close();
    },
  }));
  await oldLoad;
  expect(h.location.catalog.value).toEqual(h.catalog);
  expect(h.location.editor.value).toEqual(nextEditor);
  expect(h.location.catalogFresh.value).toBe(true);
});

it('invalidates a completed catalog immediately on session abort without waiting for a registry notification', async () => {
  using h = harness();
  await h.start({});
  await h.activate();
  const before = h.location.editor.value;
  h.stop.abort();
  expect(h.location.catalogFresh.value).toBe(false);
  expect(h.location.catalog.value).toEqual([]);
  expect(h.location.editor.value).toEqual(before);
  expect(h.location.ready.value).toBe(false);
});

it('keeps a live selection usable at the remembered-editor limit without deleting another peer', async () => {
  using h = harness();
  await h.start({});
  const editors = Array.from({ length: 32 }, (_, index) => ({ registrationId: toNaidanRpcRegistrationId({ raw: `saved-peer-${index}` }), peerPublicKey: h.row.registration.peerPublicKey, editor: emptyRemoteImageModelEditor() }));
  h.location.restorePreferences({ inferenceLocation: h.reference, remoteModelEditors: editors });
  await h.location.loadModels();
  expect(h.location.ready.value).toBe(true);
  expect(h.location.saveFailure.value).toContain('Too many');
  expect(h.location.capturePreferences().remoteModelEditors).toEqual(editors);
});

export const TEST_ONLY = {
};

it('reloads the catalog when returning from local mode to the same live session', async () => {
  using h = harness();
  await h.start({});
  await h.activate();
  const previous = h.location.selection.value;
  h.location.setKind({ value: 'local' });
  await nextTick();
  h.location.setKind({ value: 'naidan_rpc' });
  await vi.waitFor(() => expect(h.location.catalogFresh.value).toBe(true));
  expect(h.listImageModels).toHaveBeenCalledTimes(2);
  expect(h.location.selection.value).toEqual(previous);
});

it('refreshes evidence when another draft restores the same peer in the same session', async () => {
  using h = harness();
  await h.start({});
  await h.activate();
  const editor = h.location.editor.value;
  h.location.restoreLocation({ location: h.reference, modelEditor: editor });
  await vi.waitFor(() => expect(h.location.catalogFresh.value).toBe(true));
  expect(h.listImageModels).toHaveBeenCalledTimes(2);
  expect(h.location.editor.value).toEqual(editor);
});

it('an old cancelled attempt cannot clear the completed retry marker of the same session', async () => {
  using h = harness();
  const gate = Promise.withResolvers<ReadableStream<PeerImageCatalogItem>>();
  h.listImageModels.mockReturnValueOnce({ result: gate.promise, closed: Promise.resolve(), cancel: vi.fn() });
  await h.start({});
  const oldLoad = h.location.loadModels();
  h.location.setCatalogActivity({ active: true, enabled: true });
  await vi.waitFor(() => expect(h.listImageModels).toHaveBeenCalledOnce());
  h.location.restoreLocation({ location: h.reference, modelEditor: undefined });
  await vi.waitFor(() => expect(h.location.catalogFresh.value).toBe(true));
  gate.resolve(new ReadableStream({
    start(controller) {
      controller.close();
    },
  }));
  await oldLoad;
  await nextTick();
  expect(h.listImageModels).toHaveBeenCalledTimes(2);
  expect(h.location.ready.value).toBe(true);
});

it('does not evaluate owner busy state while that owner is still being constructed', async () => {
  using scope = {
    value: effectScope(),
    [Symbol.dispose]() {
      this.value.stop();
    },
  };
  const blocked = vi.fn(() => ownerBusy.value);
  const location = scope.value.run(() => useImageInferenceLocation({ form: createImageForm({ profile: 'webgpu-wasm32-asyncify' }), blocked, identifyInput: () => toBinaryObjectId({ raw: 'input' }) }))!;
  const ownerBusy = ref(false);
  expect(blocked).not.toHaveBeenCalled();
  location.setCatalogActivity({ active: true, enabled: true });
  await nextTick();
  expect(blocked).toHaveBeenCalled();
});

it('does not treat a same-path replacement of an automatic primary as permission to reset the draft', async () => {
  using h = harness();
  await h.start({});
  await h.activate();
  const before = h.location.editor.value;
  h.form.parameters.value.steps = 37;
  const image = new File(['reference'], 'image.png');
  h.form.imageInputs.value.referenceImages = [image];
  const items = structuredClone(h.catalog);
  items[0]!.file.expected!.lastModified++;
  h.listImageModels.mockImplementation(() => catalogCall({ items }));
  await h.location.loadModels();
  expect(h.location.editor.value).toEqual(before);
  expect(h.location.ready.value).toBe(false);
  expect(h.form.parameters.value.steps).toBe(37);
  expect(h.form.imageInputs.value.referenceImages).toEqual([image]);
});
