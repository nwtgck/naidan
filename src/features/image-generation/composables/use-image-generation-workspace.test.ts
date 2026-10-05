import { imagePendingRuns } from '@/features/image-generation/session/pending-runs';
import { selectImageGenerationAssets } from '@/features/image-generation/session/asset-query';
import { Blob as NodeBlob } from 'node:buffer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type Ref, computed, defineComponent, h, ref } from 'vue';
import { createMemoryHistory, createRouter, RouterView } from 'vue-router';
import ImageGeneration from '@/features/image-generation/components/ImageGenerationWorkspace.vue';
import ImageGenerationEditor from '@/features/image-generation/components/ImageGenerationEditor.vue';
import ImageGenerationAssetViewer from '@/features/image-generation/components/ImageGenerationAssetViewer.vue';
import ImageGenerationMonitor from '@/features/image-generation/components/ImageGenerationMonitor.vue';
import ImageGenerationProgress from '@/features/image-generation/components/ImageGenerationProgress.vue';
import { DOMWrapper } from '@vue/test-utils';
import ImageGenerationSidebar from '@/features/image-generation/components/ImageGenerationSidebar.vue';
import { useImageGenerationWorkspaceNavigation } from '@/features/image-generation/session/navigation';
import * as generationComposition from './use-image-generation-workspace';
import { chatDataStore } from '@/composables/chat/global/chat-core-singletons';
import { getImageGenerationToolsForChat } from '@/features/image-generation/session/assistant-registry';
import type { EnsureApproval } from '@/01-models/tool-approval';
import ImageGenerationAssistant from '@/features/image-generation/components/ImageGenerationAssistant.vue';
const chatChoices = ref<ChatSummary[]>([]);
vi.mock('@/composables/chat/ui/useCurrentChatState', () => ({ useCurrentChatState: () => ({ sidebarItems: computed(() => chatChoices.value.map(chat => ({ type: 'chat' as const, id: idToRaw({ id: chat.id }), chat }))), TEST_ONLY: {} }) }));
vi.mock('@/composables/chat/ui/useChatLifecycle', () => ({ useChatLifecycle: () => ({ createChatWithoutSelecting: vi.fn(), TEST_ONLY: {} }) }));
vi.mock('@/composables/chat/ui/useChatListData', () => ({ useChatListData: () => ({ chats: computed(() => chatChoices.value), TEST_ONLY: {} }) }));
// ChatPane owns conversation/model/approval rendering; this suite verifies the
// Workspace's visibility, selected Chat ID and capability lifetime boundary.
vi.mock('@/components/ChatPane.vue', async () => {
  const { defineComponent, h } = await import('vue');
  return { __esModule: true, default: defineComponent({ props: { chatId: { type: String, required: true } }, setup: props => () => h('div', { 'data-testid': 'existing-chat-pane', 'data-chat-id': props.chatId }) }) };
});
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { ensureAllStringsForTest } from '@/strings/test-utils';
import { storageService } from '@/00-storage/service';
import * as persistence from '@/00-storage/service/image-generation';
import { deleteImageGenerationAsset } from '@/00-storage/service/image-generation-curation';
import ImageGenerationCurationActions from '@/features/image-generation/components/ImageGenerationCurationActions.vue';
import { createImageGenerationStorageHarness, generationRunFixture } from '@/00-storage/service/image-generation/test-support';
import { MemoryStorageProvider } from '@/00-storage/service/memory-storage';
import { publishImageGenerationBinaries } from '@/00-storage/service/image-generation-binaries';
import { idToRaw, toChatId, toImageGenerationId, toImageGenerationSessionId, toNaidanRpcConnectionId, toNaidanRpcPeerId, toBinaryObjectId } from '@/01-models/ids';
import ImageGenerationTranslationButton from '@/features/image-generation/components/ImageGenerationTranslationButton.vue';
import ImageGenerationTranslationSettings from '@/features/image-generation/components/ImageGenerationTranslationSettings.vue';
import ModelSelector from '@/components/ModelSelector.vue';
import { useSettings } from '@/composables/useSettings';
import type { ImageGenerationSessionId } from '@/01-models/ids';
const translationMocks = vi.hoisted(() => ({ translate: vi.fn(), provider: vi.fn() }));
vi.mock('@/features/image-generation/translation/request', () => ({ translateImagePrompt: translationMocks.translate }));
vi.mock('@/features/lm/providerFactory', () => ({ loadLmProvider: translationMocks.provider }));
import { useImageInferenceLocation } from './use-image-inference-location';
import { copyRemoteImageModelEditor } from '@/features/image-generation/remote-image-model-editor';
const rpcManager = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('@/features/naidan-peer-rpc/runtime/feature', () => ({ getRpcManager: rpcManager.get, configureRpcFeature: async () => {}, subscribeRpcState: () => () => {} }));
import { planImageGenerationSeeds } from '@/01-models/image-generation';
import type { Chat, ChatSummary, StorageType } from '@/01-models/types';
import { useImageGeneration } from '@/features/image-generation/test-utils/unavailable-image-view';
import type { ImageGenerationDraft } from '@/features/image-generation/generation-draft';
import type { ImageGenerationView } from '@/features/image-generation/use-image-generation-types';
import { finishImageGenerationSnapshot } from '@/features/image-generation/history/snapshot';
import { createImageGenerationQueryWorker } from '@/features/image-generation/session/query-worker/impl';
import { generationQueryResultSchema } from '@/features/image-generation/session/query-worker/types';
import { useImageGenerationWorkspace, type ImageGenerationWorkspaceView } from './use-image-generation-workspace';

const mocks = vi.hoisted(() => ({ remove: vi.fn(), confirm: vi.fn(), publish: vi.fn(), subscribe: vi.fn(), getFile: vi.fn(), storage: 'opfs' as StorageType, query: vi.fn() }));
vi.mock('@/composables/useConfirm', () => ({ useConfirm: () => ({ showConfirm: mocks.confirm }) }));
vi.mock('@/00-storage/service', () => ({ storageService: { deleteImageGenerationOutput: mocks.remove, publishImageGeneration: mocks.publish, getCurrentType: () => mocks.storage, subscribeToChanges: mocks.subscribe, getFile: mocks.getFile } }));
vi.mock('@/features/image-generation/session/query-worker/client', () => ({ createImageGenerationQueryClient: () => ({ query: mocks.query, async dispose() {} }) }));
type Publication = Parameters<typeof storageService.publishImageGeneration>[0];
type Listener = Parameters<typeof storageService.subscribeToChanges>[0]['listener'];
let provider: MemoryStorageProvider;
let listener: Listener | undefined;
const views: { wrapper: VueWrapper, view: ImageGenerationWorkspaceView }[] = [];
async function publish({ store, publication, files }: Publication): Promise<void> {
  const referenced = publication.type === 'asset'
    ? [publication.asset.result.binaryObjectId, ...publication.asset.previews.map(preview => preview.binaryObjectId)]
    : (() => {
      const inputs = (publication.type === 'draft' ? publication.draft : publication.run).request.imageInputs;
      return [...(inputs.initImage ? [inputs.initImage.binaryObjectId] : []), ...inputs.referenceImages.map(image => image.binaryObjectId)];
    })();
  const write = () => publishImageGenerationBinaries({ provider, referenced, files });
  switch (publication.type) {
  case 'run': return persistence.createImageGenerationRun({ store, run: publication.run, writeInputs: write });
  case 'asset': return persistence.commitImageGenerationAsset({ store, asset: publication.asset, writeImages: write });
  case 'draft': return persistence.saveImageGenerationDraft({ store, draft: publication.draft, expectedRevision: publication.expectedRevision, writeInputs: write });
  default: { const exhaustive: never = publication; throw new Error(String(exhaustive)); }
  }
}
beforeEach(async () => {
  vi.resetAllMocks(); rpcManager.get.mockResolvedValue({ reload: async () => {}, list: () => [] }); mocks.storage = 'opfs'; listener = undefined; chatChoices.value = [];
  createImageGenerationStorageHarness(); vi.stubGlobal('Blob', NodeBlob);
  provider = new MemoryStorageProvider();
  mocks.confirm.mockResolvedValue(true);
  mocks.remove.mockImplementation((request: Parameters<typeof storageService.deleteImageGenerationOutput>[0]) => deleteImageGenerationAsset({ ...request, removeBinary: provider.deleteBinaryObject.bind(provider) }));
  mocks.publish.mockImplementation(publish); mocks.getFile.mockImplementation(provider.getFile.bind(provider));
  mocks.subscribe.mockImplementation(({ listener: value }: { listener: Listener }) => {
    listener = value; return () => {
      listener = undefined;
    };
  });
  const worker = createImageGenerationQueryWorker();
  mocks.query.mockImplementation(async request => generationQueryResultSchema.parse(await worker.query({ request })));
  await ensureAllStringsForTest({ locale: 'en' });
});
afterEach(async () => {
  for (const { wrapper, view } of views.splice(0)) {
    await view.flushDraft(); wrapper.unmount(); await flushPromises();
  }
  for (const entry of imagePendingRuns.list()) {
    if (entry.phase === 'retired') imagePendingRuns.discard({ id: entry.id });
  }
  vi.unstubAllGlobals(); vi.restoreAllMocks();
});
function open({ requestedSessionId }: { requestedSessionId: Readonly<Ref<ImageGenerationSessionId | undefined>> | undefined } = { requestedSessionId: undefined }) {
  const base = useImageGeneration(); const busy = ref(false), cancelled = ref(false);
  const native = vi.fn(async () => {}); const restored = vi.fn();
  const original = generationRunFixture({ id: 'fixture-aa', sessionId: toImageGenerationSessionId({ raw: 'fixture-aa' }), count: 1, seed: '42' }).request;
  original.loras = []; original.imageInputs = { initImage: undefined, referenceImages: [], strength: 0.75 };
  const generation: ImageGenerationView = { ...base, busy: computed(() => busy.value), formDisabled: computed(() => busy.value), draftDisabled: computed(() => false), supported: computed(() => true),
    captureDraft(): ImageGenerationDraft {
      const remote = generation.inferenceLocation?.kind.value === 'naidan_rpc';
      const request = remote ? generation.inferenceLocation!.captureDraftRequest({ seed: generation.parameters.value.seed }).request : structuredClone({ ...original, parameters: { ...generation.parameters.value } });
      return { inferenceLocation: generation.inferenceLocation?.captureLocation(), request, seedMode: generation.seedMode.value,
        layout: generation.layout.value, modelSelection: undefined, remoteModelEditor: remote ? copyRemoteImageModelEditor({ editor: generation.inferenceLocation!.editor.value }) : undefined, loraStates: [], debug: generation.debug.value, retainModel: generation.retainModel.value,
        keepPreviews: generation.keepPreviews.value, maxPreviews: generation.maxPreviews.value, maxResults: generation.maxResults.value, files: [], modelFiles: [] };
    },
    async restoreDraft({ draft }) {
      restored(draft); if (draft.inferenceLocation) generation.inferenceLocation?.restoreLocation({ location: draft.inferenceLocation, modelEditor: draft.remoteModelEditor }); generation.parameters.value = { ...generation.parameters.value, ...draft.request.parameters }; generation.seedMode.value = draft.seedMode; generation.layout.value = draft.layout;
    },
    resetDraft() {
      generation.parameters.value = { ...generation.parameters.value, prompt: '', negativePrompt: '' };
    },
    cancel() {
      cancelled.value = true;
    },
    async generate({ submission }) {
      if (busy.value) return;
      busy.value = true; cancelled.value = false;
      try {
        if (!submission) {
          await native(); return;
        }
        const capture = generation.captureDraft!();
        if (!capture) throw new Error('Missing fixture draft.');
        if (!capture.request.runtime) throw new Error('Missing fixture runtime.');
        const snapshot = { id: toImageGenerationId({ raw: 'fixture-aa' }), createdAt: Date.now(), request: { ...capture.request, runtime: capture.request.runtime }, inputFiles: capture.files };
        const seeds = planImageGenerationSeeds({ baseSeed: snapshot.request.parameters.seed, count: submission.count });
        await submission.accepted({ snapshot, seeds });
        for (let index = 0; index < seeds.length; index++) {
          if (cancelled.value) break;
          await native();
          const seed = seeds[index]; if (!seed) throw new Error('Missing seed.');
          const output = finishImageGenerationSnapshot({ snapshot: { ...snapshot, request: { ...snapshot.request, parameters: { ...snapshot.request.parameters, seed } } },
            result: { png: new Blob([`image-${seed}`], { type: 'image/png' }), width: 256, height: 256, modelVersion: 'fixture', uniformOutput: false }, previews: [], elapsedMs: 5 });
          await submission.output({ index, ...output });
        }
        await submission.finished({ completion: { type: cancelled.value ? 'cancelled' : 'completed' } });
      } catch (error) {
        await submission?.finished({ completion: { type: 'failed', message: error instanceof Error ? error.message : String(error) } });
      } finally {
        busy.value = false;
      }
    },
  };
  generation.parameters.value = { ...generation.parameters.value, ...original.parameters }; generation.seedMode.value = 'fixed';
  let view: ImageGenerationWorkspaceView | undefined;
  const wrapper = mount(defineComponent({ setup() {
    generation.inferenceLocation = useImageInferenceLocation({ form: generation, blocked: () => busy.value, identifyInput: () => toBinaryObjectId({ raw: 'test-input' }) });
    view = useImageGenerationWorkspace({ generation, requestedSessionId }); return () => h('div');
  } }));
  if (!view) throw new Error('Missing Workspace.');
  views.push({ wrapper, view });
  return { generation, view, native, restored, wrapper };
}
async function ready() {
  const value = open(); await flushPromises(); return value;
}

describe('Image Generation composition and lifetime', () => {
  it('does not create a session or metadata merely by opening the screen', async () => {
    const h = await ready(); expect(h.view.sessions.value).toEqual([]); expect(h.view.store.value).toBeUndefined(); expect(mocks.publish).not.toHaveBeenCalled();
  });
  it('creates a session at the first generation and saves every image under one immutable run', async () => {
    const h = await ready(); h.generation.parameters.value.prompt = '雨の夜景'; h.view.count.value = 3;
    await h.view.generate(); await flushPromises();
    expect(h.native).toHaveBeenCalledTimes(3); expect(h.view.currentSession.value?.title).toBe('雨の夜景');
    expect(h.view.runs.value).toHaveLength(1); expect(h.view.runs.value[0]?.execution.type).toBe('completed');
    expect(h.view.tiles.value.map(tile => tile.seed).sort()).toEqual(['42', '43', '44']);
    expect(new Set(h.view.tiles.value.map(tile => tile.runId)).size).toBe(1);
  });
  it('keeps generation owned by A when viewing B and restores the untouched B draft afterwards', async () => {
    const h = await ready(); h.generation.parameters.value.prompt = 'session A'; h.view.count.value = 2;
    const a = await h.view.newSession({ preserveDraft: true }); expect(a).toBeDefined(); await h.view.flushDraft();
    const b = await h.view.newSession({ preserveDraft: false }); expect(b).toBeDefined();
    h.generation.parameters.value.prompt = 'session B draft'; h.view.count.value = 4; await h.view.flushDraft();
    await h.view.selectSession({ sessionId: a!.id }); expect(h.generation.parameters.value.prompt).toBe('session A'); expect(h.view.count.value).toBe(2);
    const gate = Promise.withResolvers<void>(); h.native.mockImplementationOnce(() => gate.promise);
    const task = h.view.generate(); await vi.waitFor(() => expect(h.native).toHaveBeenCalledOnce());
    await h.view.selectSession({ sessionId: b!.id }); expect(h.view.editorReady.value).toBe(false);
    gate.resolve(); await task; await flushPromises();
    expect(h.view.selectedSessionId.value).toBe(b!.id); expect(h.generation.parameters.value.prompt).toBe('session B draft'); expect(h.view.count.value).toBe(4);
    expect(h.view.tiles.value).toHaveLength(0); expect(h.view.editorReady.value).toBe(true);
    const saved = selectImageGenerationAssets({ snapshot: await persistence.readImageGenerationSessionIndex({ store: h.view.store.value!, sessionId: a!.id }), query: { visibility: 'active' as const, text: '', tags: [], match: 'all', runId: undefined, cursor: undefined, limit: 40 } });
    expect(saved.items).toHaveLength(2);
  });
  it('persists unfinished RPC locations and exact model editors per session across switching and remount', async () => {
    const h = await ready(); const location = h.generation.inferenceLocation!;
    location.setKind({ value: 'naidan_rpc' }); h.generation.parameters.value.prompt = 'Waiting for a peer';
    const a = (await h.view.newSession({ preserveDraft: true }))!; await h.view.flushDraft();
    const b = (await h.view.newSession({ preserveDraft: false }))!;
    const connection = { connectionId: toNaidanRpcConnectionId({ raw: 'session-peer' }), peerId: toNaidanRpcPeerId({ raw: 'B'.repeat(43) }) };
    const file = { location: { kind: 'opfs' as const, path: 'models/session.gguf' } };
    location.restoreLocation({ location: { kind: 'naidan_rpc', connection }, modelEditor: { primary: { slot: 'model', file, family: undefined }, components: [], loras: [{ file, enabled: 'disabled', strength: 0.8 }] } });
    h.generation.parameters.value.prompt = 'Selected peer'; await h.view.flushDraft();
    // Disabled adapter edits do not change the generated model selection.
    location.changeLora({ index: 0, enabled: 'disabled', strength: 0.3 });
    await vi.waitFor(async () => expect((await persistence.loadImageGenerationDraft({ store: h.view.store.value!, sessionId: b.id }))?.remoteModelEditor?.loras[0]?.strength).toBe(0.3));
    await h.view.selectSession({ sessionId: a.id });
    expect(location.captureLocation()).toEqual({ kind: 'naidan_rpc', connection: undefined });
    expect(location.editor.value.primary).toBeUndefined(); expect(h.generation.parameters.value.prompt).toBe('Waiting for a peer');
    const saved = (await persistence.loadImageGenerationDraft({ store: h.view.store.value!, sessionId: a.id }))!;
    expect(saved.request.runtime).toBeUndefined(); expect(saved.inferenceLocation).toEqual({ kind: 'naidan_rpc', connection: undefined });
    await h.view.flushDraft(); h.wrapper.unmount(); await flushPromises();
    const reopened = open({ requestedSessionId: ref(b.id) }); await flushPromises();
    expect(reopened.generation.inferenceLocation!.captureLocation()).toEqual({ kind: 'naidan_rpc', connection });
    expect(reopened.generation.inferenceLocation!.editor.value.loras).toMatchObject([{ enabled: 'disabled', strength: 0.3 }]);
    expect(reopened.generation.parameters.value.prompt).toBe('Selected peer'); expect(reopened.native).not.toHaveBeenCalled();
  });
  it('retries failed image storage without additional inference or moving it to the selected session', async () => {
    const h = await ready(); let fail = true;
    mocks.publish.mockImplementation(async (value: Publication) => {
      if (value.publication.type === 'asset' && fail) {
        fail = false; throw new Error('quota');
      } await publish(value);
    });
    await h.view.generate(); const origin = h.view.selectedSessionId.value!;
    expect(h.native).toHaveBeenCalledOnce(); expect(h.view.hasPendingSave.value).toBe(true);
    const other = await h.view.newSession({ preserveDraft: false }); expect(other?.id).not.toBe(origin);
    await h.view.retrySave(); expect(h.view.hasPendingSave.value).toBe(false); expect(h.native).toHaveBeenCalledOnce();
    expect(h.view.tiles.value).toEqual([]);
    const saved = selectImageGenerationAssets({ snapshot: await persistence.readImageGenerationSessionIndex({ store: h.view.store.value!, sessionId: origin }), query: { visibility: 'active' as const, text: '', tags: [], match: 'all', runId: undefined, cursor: undefined, limit: 40 } });
    expect(saved.items).toHaveLength(1);
  });
  it('preserves exact failed draft attempts before publishing newer edits', async () => {
    const h = await ready(); await h.view.newSession({ preserveDraft: true });
    let lose = true;
    mocks.publish.mockImplementation(async (value: Publication) => {
      await publish(value); if (value.publication.type === 'draft' && lose) {
        lose = false; throw new Error('lost acknowledgement');
      }
    });
    await h.view.flushDraft(); expect(h.view.draftStatus.value).toBe('failed');
    h.generation.parameters.value.prompt = 'newer draft';
    expect(await h.view.flushDraft()).toBe(true);
    const drafts = mocks.publish.mock.calls.map(([value]) => value as Publication).filter(value => value.publication.type === 'draft');
    expect(drafts[0]?.publication).toEqual(drafts[1]?.publication);
    const saved = await persistence.loadImageGenerationDraft({ store: h.view.store.value!, sessionId: h.view.selectedSessionId.value! });
    expect(saved?.request.parameters.prompt).toBe('newer draft'); expect(saved?.revision).toBeGreaterThan(0);
  });
  it('renames tag definitions without changing identities or image binaries', async () => {
    const h = await ready(); await h.view.generate(); await h.view.editTag({ tagId: undefined, name: '背景候補 🟦' });
    const tag = h.view.userTags.value[0]!; const tile = h.view.tiles.value[0]!;
    await h.view.toggleTag({ tile, tag: { type: 'user', tagId: tag.id } });
    await h.view.toggleTag({ tile: h.view.tiles.value[0]!, tag: { type: 'system', key: 'favorite' } });
    const calls = mocks.publish.mock.calls.length;
    await h.view.editTag({ tagId: tag.id, name: '背景の最終候補' });
    expect(h.view.userTags.value[0]?.id).toBe(tag.id); expect(h.view.userTags.value[0]?.name).toBe('背景の最終候補');
    expect(h.view.tiles.value[0]?.annotations?.tags).toHaveLength(2); expect(mocks.publish.mock.calls.length).toBe(calls);
    await h.view.editTag({ tagId: undefined, name: '@favorite' }); expect(h.view.failure.value).not.toBe('');
  });
  it('reuses the selected output seed rather than the first seed of its run', async () => {
    const h = await ready(); h.view.count.value = 2; await h.view.generate();
    const tile = h.view.tiles.value.find(value => value.seed === '43')!;
    await h.view.inspect({ tile }); await h.view.reuse({ kind: 'settings' });
    expect(h.generation.parameters.value.seed).toBe('43'); expect(h.generation.seedMode.value).toBe('fixed');
    expect(h.restored.mock.lastCall?.[0].modelSelection).toBeUndefined();
    await h.view.generate(); const latest = h.view.runState.value?.run;
    expect(latest?.sources).toEqual([{ role: 'settings', sessionId: tile.sessionId, assetId: tile.id }]);
  });
  it('keeps the requested temporary run count when OPFS is not selected', async () => {
    mocks.storage = 'memory'; const h = await ready(); h.view.count.value = 4;
    await h.view.generate(); expect(h.native).toHaveBeenCalledTimes(4); expect(mocks.publish).not.toHaveBeenCalled(); expect(h.view.sessions.value).toEqual([]);
  });
  it('does not retry an old save into a reset store', async () => {
    const h = await ready(); mocks.publish.mockImplementation(async (value: Publication) => {
      if (value.publication.type === 'asset') throw new Error('quota'); await publish(value);
    });
    await h.view.generate(); const original = h.view.store.value!.storeId;
    createImageGenerationStorageHarness(); listener?.({ event: { type: 'migration', timestamp: Date.now() } }); await flushPromises();
    await h.view.newSession({ preserveDraft: false }); expect(h.view.store.value?.storeId).not.toBe(original);
    const calls = mocks.publish.mock.calls.length; await h.view.retrySave();
    expect(h.view.failure.value).toContain('original'); expect(mocks.publish.mock.calls.length).toBe(calls);
  });
});


describe('Image Generation component connections', () => {
  it('renders the existing editor, saves favorites from the gallery and opens selected-image details', async () => {
    const fixture = await ready();
    fixture.generation.parameters.value.prompt = '夜景の候補'; fixture.view.count.value = 2;
    await fixture.view.generate(); await flushPromises();
    vi.spyOn(generationComposition, 'useImageGenerationWorkspace').mockReturnValueOnce(fixture.view);
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/', component: ImageGeneration, props: { generation: fixture.generation, active: true } }] });
    await router.push('/'); await router.isReady();
    const surface = mount(RouterView, { global: { plugins: [router] } });
    try {
      await flushPromises();
      expect(surface.findComponent(ImageGenerationEditor).exists()).toBe(true);
      expect(surface.findAll('[data-testid="workspace-asset"]')).toHaveLength(2);
      const asset = surface.findAll('[data-testid="workspace-asset"]')[0]!;
      await asset.get('button[aria-label="Favorite"]').trigger('click'); await flushPromises();
      expect(asset.get('button[aria-label="Favorite"]').attributes('aria-pressed')).toBe('true');
      await asset.findAll('button')[0]!.trigger('click'); await flushPromises();
      expect(fixture.view.details.value?.asset.seed).toBe(fixture.view.tiles.value[0]?.seed);
      expect(useImageGenerationWorkspaceNavigation().active.value?.view).toBe(fixture.view);
    } finally {
      surface.unmount();
    }
    expect(useImageGenerationWorkspaceNavigation().active.value).toBeUndefined();
  });
  it('places New Session above session entries and delegates model and diagnostic navigation', async () => {
    const fixture = await ready();
    await fixture.view.newSession({ preserveDraft: false }); await flushPromises();
    const openModels = vi.fn(), openDiagnostics = vi.fn(), openGeneration = vi.fn();
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:pathMatch(.*)*', component: { render: () => h('div') } }] });
    await router.push('/'); await router.isReady();
    const surface = mount(ImageGenerationSidebar, { props: { navigation: { view: fixture.view, openModels, openDiagnostics, openGeneration } }, global: { plugins: [router], stubs: { SidebarDebugControls: true } } });
    try {
      const buttons = surface.findAll('button');
      expect(buttons[1]?.attributes('data-testid')).toBe('workspace-new-session');
      await surface.get('button[title="Models"]').trigger('click');
      await surface.get('button[title="Diagnostics"]').trigger('click');
      expect(openModels).toHaveBeenCalledOnce(); expect(openDiagnostics).toHaveBeenCalledOnce();
      await surface.get('[data-testid="workspace-new-session"]').trigger('click'); await flushPromises();
      expect(fixture.view.sessions.value).toHaveLength(2); expect(openGeneration).toHaveBeenCalledOnce();
    } finally {
      surface.unmount();
    }
  });
});

describe('Image Generation viewer integration', () => {
  it('opens immediately, clears stale parameters and discards a slow result after moving to another image', async () => {
    const fixture = await ready(); fixture.view.count.value = 2; await fixture.view.generate();
    const [first, second] = fixture.view.tiles.value; if (!first || !second) throw new Error('Missing images.');
    const original = persistence.loadImageGenerationAsset, gate = Promise.withResolvers<void>();
    vi.spyOn(persistence, 'loadImageGenerationAsset').mockImplementationOnce(async request => {
      await gate.promise; return original(request);
    });
    const surface = mount(ImageGenerationAssetViewer, { props: { view: fixture.view, active: true } });
    try {
      const opening = fixture.view.inspect({ tile: first }); await flushPromises();
      expect(document.querySelector('[data-testid="image-viewer"]')).not.toBeNull();
      expect(fixture.view.inspectedTile.value?.id).toBe(first.id); expect(fixture.view.inspectLoading.value).toBe(true); expect(fixture.view.details.value).toBeUndefined();
      await fixture.view.inspect({ tile: second });
      expect(fixture.view.details.value?.asset.id).toBe(second.id);
      gate.resolve(); await opening;
      expect(fixture.view.details.value?.asset.id).toBe(second.id);
      expect(fixture.view.inspectedTile.value?.id).toBe(second.id);
      fixture.view.closeDetails(); await flushPromises();
      expect(document.querySelector('[data-testid="image-viewer"]')).toBeNull();
    } finally {
      gate.resolve(); surface.unmount();
    }
  });
  it('keeps its browsing order and current image when removing favorite excludes it from the gallery', async () => {
    const fixture = await ready(); fixture.view.count.value = 2; await fixture.view.generate();
    const favorite = { type: 'system', key: 'favorite' } as const;
    for (const tile of [...fixture.view.tiles.value]) await fixture.view.toggleTag({ tile, tag: favorite });
    fixture.view.onlyFavorite.value = true; await fixture.view.refresh({ append: false });
    const [first, second] = fixture.view.tiles.value; if (!first || !second) throw new Error('Missing images.');
    const surface = mount(ImageGenerationAssetViewer, { props: { view: fixture.view, active: true } });
    try {
      await fixture.view.inspect({ tile: first }); await flushPromises();
      const viewer = new DOMWrapper(document.querySelector<HTMLElement>('[data-testid="image-viewer"]')!);
      expect(viewer.find('[data-testid="workspace-viewer-details"]').exists()).toBe(false);
      await viewer.get('[data-testid="workspace-viewer-favorite"]').trigger('click'); await flushPromises();
      expect(fixture.view.tiles.value.map(tile => tile.id)).toEqual([second.id]);
      expect(fixture.view.inspectedTile.value?.id).toBe(first.id);
      expect(viewer.get('[data-testid="workspace-viewer-favorite"]').attributes('aria-pressed')).toBe('false');
      expect(surface.vm.TEST_ONLY.queue.value.map(tile => tile.id)).toEqual([first.id, second.id]);
      await viewer.get('[data-testid="image-viewer-next"]').trigger('click'); await flushPromises();
      expect(fixture.view.details.value?.asset.id).toBe(second.id);
      await viewer.get('[data-testid="image-viewer-previous"]').trigger('click'); await flushPromises();
      expect(fixture.view.details.value?.asset.id).toBe(first.id);
      // Returning uses the current annotation revision, not the old gallery one.
      await viewer.get('[data-testid="workspace-viewer-favorite"]').trigger('click'); await flushPromises();
      expect(fixture.view.failure.value).toBe(''); expect(fixture.view.tiles.value).toHaveLength(2);
      expect(viewer.get('[data-testid="workspace-viewer-favorite"]').attributes('aria-pressed')).toBe('true');
    } finally {
      surface.unmount();
    }
  });
  it('closes on a session change or hidden workspace and ignores a pending record after closing', async () => {
    const fixture = await ready(); await fixture.view.generate(); const first = fixture.view.tiles.value[0]!;
    const surface = mount(ImageGenerationAssetViewer, { props: { view: fixture.view, active: true } });
    try {
      await fixture.view.inspect({ tile: first }); await flushPromises();
      await surface.setProps({ active: false }); expect(fixture.view.inspectedTile.value).toBeUndefined();
      await surface.setProps({ active: true }); expect(document.querySelector('[data-testid="image-viewer"]')).toBeNull();
      const original = persistence.loadImageGenerationAsset, gate = Promise.withResolvers<void>();
      vi.spyOn(persistence, 'loadImageGenerationAsset').mockImplementationOnce(async request => {
        await gate.promise; return original(request);
      });
      const reading = fixture.view.inspect({ tile: first });
      await fixture.view.newSession({ preserveDraft: false }); gate.resolve(); await reading;
      expect(fixture.view.details.value).toBeUndefined(); expect(fixture.view.inspectedTile.value).toBeUndefined();
    } finally {
      surface.unmount();
    }
  });
  it('does not allow retargeting an asynchronous settings reuse into another session', async () => {
    const fixture = await ready(); await fixture.view.generate(); const first = fixture.view.tiles.value[0]!;
    const originalSession = fixture.view.selectedSessionId.value!;
    const other = await fixture.view.newSession({ preserveDraft: false }); if (!other) throw new Error('Missing other session.');
    await fixture.view.selectSession({ sessionId: originalSession }); await fixture.view.inspect({ tile: first });
    const gate = Promise.withResolvers<void>(); fixture.generation.restoreDraft = async () => {
      await gate.promise;
    };
    const reusing = fixture.view.reuse({ kind: 'settings' });
    expect(fixture.view.busy.value).toBe(true); expect(fixture.view.editor.formDisabled.value).toBe(true);
    await fixture.view.selectSession({ sessionId: other.id });
    expect(fixture.view.selectedSessionId.value).toBe(originalSession);
    expect(fixture.view.setPromptDraft({ field: 'prompt', value: 'stale tool edit' })).toBe(false);
    gate.resolve(); expect(await reusing).toBe('applied'); expect(fixture.view.busy.value).toBe(false);
    await fixture.view.selectSession({ sessionId: other.id }); expect(fixture.view.selectedSessionId.value).toBe(other.id);
  });
});

describe('Image Generation live monitor', () => {
  it('shows the executing session and live image while another session is being browsed', async () => {
    const fixture = await ready(); const first = await fixture.view.newSession({ preserveDraft: true });
    if (!first) throw new Error('Missing session.');
    await fixture.view.renameSession({ sessionId: first.id, title: 'Generating here' });
    const other = await fixture.view.newSession({ preserveDraft: false }); if (!other) throw new Error('Missing session.');
    await fixture.view.renameSession({ sessionId: other.id, title: 'Browsing there' });
    await fixture.view.selectSession({ sessionId: first.id }); fixture.view.count.value = 2;
    const gate = Promise.withResolvers<void>(); fixture.native.mockImplementationOnce(() => gate.promise);
    const task = fixture.view.generate(); await vi.waitFor(() => expect(fixture.native).toHaveBeenCalledOnce());
    fixture.generation.latestRun.value = { status: 'running', width: 768, height: 512 };
    fixture.generation.livePreview.value = { type: 'naidan-image-preview-v1', mode: 'projection', runId: 8, revision: 0, step: 1, steps: 8, id: 1, elapsedMs: 10, url: 'blob:active-run', width: 768, height: 512 };
    const surface = mount(ImageGenerationMonitor, { props: { workspace: fixture.view, generation: fixture.generation, active: true, compact: false } });
    try {
      await fixture.view.selectSession({ sessionId: other.id });
      expect(surface.text()).toContain('Generating here'); expect(surface.text()).not.toContain('Browsing there');
      expect(surface.get('[data-testid="image-generation-current-preview"]').attributes('src')).toBe('blob:active-run');
      expect(surface.findComponent(ImageGenerationProgress).props('width')).toBe(768);
      expect(surface.findComponent(ImageGenerationProgress).props('size')).toBe('monitor');
      expect(surface.get('[data-testid="workspace-generation-monitor"]').classes()).not.toContain('sticky');
      expect(surface.get('[data-testid="workspace-generation-monitor"]').classes()).not.toContain('fixed');
      await surface.setProps({ compact: true }); expect(surface.findComponent(ImageGenerationProgress).props('size')).toBe('compact');
      gate.resolve(); await task; await flushPromises();
      expect(surface.find('[data-testid="workspace-generation-monitor"]').exists()).toBe(true);
      expect(surface.text()).not.toContain('Retry saving');
    } finally {
      gate.resolve(); await task; surface.unmount();
    }
  });
  it('keeps a failed publication visible and retries only saving', async () => {
    const fixture = await ready(); let fail = true;
    mocks.publish.mockImplementation(async (value: Publication) => {
      if (value.publication.type === 'asset' && fail) {
        fail = false; throw new Error('quota');
      }
      await publish(value);
    });
    await fixture.view.generate();
    const surface = mount(ImageGenerationMonitor, { props: { workspace: fixture.view, generation: fixture.generation, active: true, compact: false } });
    try {
      expect(surface.find('[data-testid="workspace-generation-monitor"]').exists()).toBe(true);
      await surface.get('button').trigger('click'); await flushPromises();
      expect(fixture.native).toHaveBeenCalledOnce(); expect(fixture.view.hasPendingSave.value).toBe(false);
      expect(surface.find('[data-testid="workspace-generation-monitor"]').exists()).toBe(true);
      expect(surface.text()).not.toContain('Retry saving');
    } finally {
      surface.unmount();
    }
  });
});

describe('Image Generation existing chat panel', () => {
  function chat({ raw, title }: { raw: string, title: string }): Chat {
    return { id: toChatId({ raw }), title, createdAt: 1, updatedAt: 1, root: { items: [] }, debugEnabled: false };
  }
  it('opens a visible dialog with a chooser even without a chat and closes from its explicit button', async () => {
    const fixture = await ready();
    vi.spyOn(generationComposition, 'useImageGenerationWorkspace').mockReturnValueOnce(fixture.view);
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/', component: ImageGeneration, props: { generation: fixture.generation, active: true } }] });
    await router.push('/'); await router.isReady(); const surface = mount(RouterView, { global: { plugins: [router] } });
    try {
      await flushPromises();
      const openButton = surface.get('[data-testid="workspace-open-chat"]');
      expect(openButton.text()).toBe('Connect a chat');
      expect(document.querySelector('[data-testid="image-generation-assistant"]')).toBeNull();
      await openButton.trigger('click'); await vi.dynamicImportSettled(); await flushPromises();
      const panel = new DOMWrapper(document.querySelector<HTMLElement>('[data-testid="image-generation-assistant"]')!);
      expect(panel.isVisible()).toBe(true); expect(panel.attributes('role')).toBe('dialog');
      expect(panel.find('[data-testid="workspace-chat-picker"]').exists()).toBe(true);
      expect(panel.text()).toContain('existing chat');
      expect(document.querySelector('[data-testid="existing-chat-pane"]')).toBeNull();
      expect(openButton.attributes('aria-expanded')).toBe('true');
      expect(panel.attributes('id')).toBe(openButton.attributes('aria-controls'));
      await panel.get('[data-testid="workspace-chat-close"]').trigger('click'); await flushPromises();
      expect(panel.isVisible()).toBe(false); expect(openButton.attributes('aria-expanded')).toBe('false');
    } finally {
      surface.unmount();
    }
  });
  it('reuses the selected ChatPane, revokes tools on hide or replacement, and remembers the selection on reopen', async () => {
    const fixture = await ready(); await fixture.view.newSession({ preserveDraft: true });
    const a = chat({ raw: 'assistant-a', title: 'English prompt helper' }), b = chat({ raw: 'assistant-b', title: 'Other helper' });
    chatChoices.value = [a, b];
    vi.spyOn(chatDataStore, 'getLiveChatById').mockImplementation(({ chatId }) => chatId === a.id ? a : b);
    vi.spyOn(chatDataStore, 'getLiveChat').mockImplementation(({ chat: value }) => value);
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:pathMatch(.*)*', component: { render: () => h('div') } }] });
    await router.push('/image-generation'); await router.isReady();
    const surface = mount(ImageGenerationAssistant, { props: { workspace: fixture.view, active: true }, global: { plugins: [router] } });
    const ensureApproval = vi.fn<EnsureApproval>().mockResolvedValue({ status: 'approved' });
    const context = { signal: new AbortController().signal, approvalContext: { chatId: a.id, ensureApproval } };
    try {
      const panel = new DOMWrapper(document.querySelector<HTMLElement>('[data-testid="image-generation-assistant"]')!);
      await panel.get('[data-testid="workspace-chat-choice-assistant-a"]').trigger('click'); await vi.dynamicImportSettled(); await flushPromises();
      expect(panel.get('[data-testid="existing-chat-pane"]').attributes('data-chat-id')).toBe(idToRaw({ id: a.id }));
      expect(panel.get('a[aria-label="Open regular chat"]').attributes('href')).toContain(idToRaw({ id: a.id }));
      const tools = getImageGenerationToolsForChat({ chatId: a.id }); expect(tools).toHaveLength(2);
      expect(await tools[0]!.execute({ ...context, args: {} })).toMatchObject({ status: 'success' });
      await surface.setProps({ active: false });
      expect(getImageGenerationToolsForChat({ chatId: a.id })).toEqual([]);
      expect(await tools[0]!.execute({ ...context, args: {} })).toMatchObject({ status: 'error' });
      await surface.setProps({ active: true }); await flushPromises();
      expect(fixture.view.currentSession.value?.assistantChatId).toBe(a.id);
      expect(panel.get('[data-testid="existing-chat-pane"]').attributes('data-chat-id')).toBe(idToRaw({ id: a.id }));
      const renewed = getImageGenerationToolsForChat({ chatId: a.id }); expect(renewed).toHaveLength(2);
      expect(await renewed[0]!.execute({ ...context, args: {} })).toMatchObject({ status: 'success' });
      await panel.get('[data-testid="workspace-chat-picker-toggle"]').trigger('click');
      await panel.get('[data-testid="workspace-chat-choice-assistant-b"]').trigger('click'); await flushPromises();
      expect(panel.get('[data-testid="existing-chat-pane"]').attributes('data-chat-id')).toBe(idToRaw({ id: b.id }));
      expect(getImageGenerationToolsForChat({ chatId: a.id })).toEqual([]);
      expect(getImageGenerationToolsForChat({ chatId: b.id })).toHaveLength(2);
      expect(await renewed[0]!.execute({ ...context, args: {} })).toMatchObject({ status: 'error' });
      chatChoices.value = [a]; await flushPromises();
      expect(getImageGenerationToolsForChat({ chatId: b.id })).toEqual([]);
      expect(panel.find('[data-testid="existing-chat-pane"]').exists()).toBe(false);
    } finally {
      surface.unmount();
    }
    expect(getImageGenerationToolsForChat({ chatId: a.id })).toEqual([]);
    expect(getImageGenerationToolsForChat({ chatId: b.id })).toEqual([]);
  });
});

describe('Image Generation curation and durable assistant choice', () => {
  it('keeps the newest-first gallery immediately below the ordinary-flow preview, independent of editor height', async () => {
    const fixture = await ready(); fixture.view.count.value = 3; await fixture.view.generate();
    vi.spyOn(generationComposition, 'useImageGenerationWorkspace').mockReturnValueOnce(fixture.view);
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/', component: ImageGeneration, props: { generation: fixture.generation, active: true } }] });
    await router.push('/'); await router.isReady(); const surface = mount(RouterView, { global: { plugins: [router] } });
    try {
      await flushPromises();
      const preview = surface.get('[data-testid="workspace-preview-column"]');
      const gallery = surface.get('[data-testid="workspace-gallery-area"]');
      const editor = surface.findComponent(ImageGenerationEditor);
      expect(preview.element.parentElement?.contains(editor.element)).toBe(false);
      expect(preview.element.parentElement?.contains(gallery.element)).toBe(true);
      expect(surface.get('[data-testid="workspace-settings-column"]').element.contains(editor.element)).toBe(true);
      // The notice may sit between preview and gallery, but the tall editor is
      // never their grid row owner.
      expect(preview.element.parentElement).toBe(gallery.element.parentElement);
      expect(preview.html()).not.toMatch(/class="[^"\n]*\b(?:sticky|fixed)\b/);
      expect(surface.findAll('[data-testid="workspace-generation-monitor"]')).toHaveLength(1);
      expect(surface.text()).not.toContain('Storage and data rescue');
      const dates = fixture.view.tiles.value.map(tile => tile.createdAt);
      expect(dates).toEqual([...dates].sort((a, b) => b - a));
    } finally {
      surface.unmount();
    }
  });
  it('selects more than two images for bulk archive and restoration without deleting their files', async () => {
    const fixture = await ready(); fixture.view.count.value = 4; await fixture.view.generate();
    const original = [...fixture.view.tiles.value];
    for (const tile of original) fixture.view.toggleSelection({ tile });
    expect(fixture.view.selection.value).toHaveLength(4);
    await fixture.view.curate({ items: [...fixture.view.selection.value], action: { type: 'archive' } });
    expect(fixture.view.failure.value).toBe(''); expect(fixture.view.tiles.value).toEqual([]); expect(fixture.view.selection.value).toEqual([]);
    for (const tile of original) expect(await provider.getFile({ binaryObjectId: tile.binaryObjectId })).toBeTruthy();
    fixture.view.visibility.value = 'archived'; await fixture.view.refresh({ append: false });
    expect(fixture.view.tiles.value).toHaveLength(4);
    await fixture.view.curate({ items: [...fixture.view.tiles.value], action: { type: 'restore' } });
    expect(fixture.view.tiles.value).toEqual([]);
    fixture.view.visibility.value = 'active'; await fixture.view.refresh({ append: false });
    expect(fixture.view.tiles.value).toHaveLength(4); expect(mocks.remove).not.toHaveBeenCalled();
  });
  it('adds and removes the same named tag on every selected image', async () => {
    const fixture = await ready(); fixture.view.count.value = 3; await fixture.view.generate();
    await fixture.view.editTag({ tagId: undefined, name: '夜景の候補' });
    const tagId = fixture.view.userTags.value[0]!.id;
    await fixture.view.curate({ items: [...fixture.view.tiles.value], action: { type: 'tag', tag: { type: 'user', tagId }, assignment: 'add' } });
    expect(fixture.view.tiles.value.every(tile => tile.annotations?.tags.some(item => item.tag.type === 'user' && item.tag.tagId === tagId))).toBe(true);
    await fixture.view.editTag({ tagId, name: '採用候補🌃' });
    expect(fixture.view.userTags.value[0]!.id).toBe(tagId);
    await fixture.view.curate({ items: [...fixture.view.tiles.value], action: { type: 'tag', tag: { type: 'user', tagId }, assignment: 'remove' } });
    expect(fixture.view.tiles.value.every(tile => tile.annotations?.tags.length === 0)).toBe(true);
  });
  it('deletes selected BinaryObjects and leaves unselected images available', async () => {
    const fixture = await ready(); fixture.view.count.value = 3; await fixture.view.generate();
    const [a, b, c] = fixture.view.tiles.value; if (!a || !b || !c) throw new Error('Missing test images.');
    await fixture.view.curate({ items: [a, b], action: { type: 'delete' } });
    expect(fixture.view.failure.value).toBe('');
    expect(await provider.getFile({ binaryObjectId: a.binaryObjectId })).toBeNull();
    expect(await provider.getFile({ binaryObjectId: b.binaryObjectId })).toBeNull();
    expect(await provider.getFile({ binaryObjectId: c.binaryObjectId })).toBeTruthy();
    fixture.view.visibility.value = 'all'; await fixture.view.refresh({ append: false });
    expect(fixture.view.tiles.value.map(tile => tile.id)).toEqual([c.id]);
    expect(fixture.view.deletedAssetIds.value).toEqual(expect.arrayContaining([a.id, b.id]));
  });
  it('keeps deletion retryable and closes a viewer whose image is pending byte removal', async () => {
    const fixture = await ready(); await fixture.view.generate(); const tile = fixture.view.tiles.value[0]!;
    await fixture.view.inspect({ tile }); fixture.view.toggleSelection({ tile });
    const remove = vi.spyOn(provider, 'deleteBinaryObject').mockRejectedValueOnce(new Error('disk failure'));
    mocks.remove.mockImplementationOnce((request: Parameters<typeof storageService.deleteImageGenerationOutput>[0]) => deleteImageGenerationAsset({ ...request, removeBinary: remove }));
    await fixture.view.curate({ items: [tile], action: { type: 'delete' } });
    expect(fixture.view.pendingDeletions.value).toHaveLength(1); expect(fixture.view.inspectedTile.value).toBeUndefined();
    expect(fixture.view.selection.value).toEqual([]); expect(fixture.view.tiles.value).toEqual([]);
    await fixture.view.retryDeletions();
    expect(fixture.view.pendingDeletions.value).toEqual([]); expect(fixture.native).toHaveBeenCalledOnce();
    expect(await provider.getFile({ binaryObjectId: tile.binaryObjectId })).toBeNull();
  });
  it('confirms byte deletion, permits cancellation, and rejects confirmation after a session switch', async () => {
    const fixture = await ready(); await fixture.view.generate(); const tile = fixture.view.tiles.value[0]!;
    const surface = mount(ImageGenerationCurationActions, { props: { view: fixture.view, items: [tile] } });
    try {
      mocks.confirm.mockResolvedValueOnce(false);
      await surface.get('[data-testid="workspace-bulk-delete"]').trigger('click'); await flushPromises();
      expect(mocks.remove).not.toHaveBeenCalled();
      expect(mocks.confirm.mock.calls[0]?.[0].message).toContain('BinaryObjects');
      const gate = Promise.withResolvers<boolean>(); mocks.confirm.mockReturnValueOnce(gate.promise);
      await surface.get('[data-testid="workspace-bulk-delete"]').trigger('click');
      await fixture.view.newSession({ preserveDraft: false }); gate.resolve(true); await flushPromises();
      expect(mocks.remove).not.toHaveBeenCalled(); expect(await provider.getFile({ binaryObjectId: tile.binaryObjectId })).toBeTruthy();
    } finally {
      surface.unmount();
    }
  });
  it('persists independent assistant selections per session and preserves them after reload', async () => {
    const fixture = await ready(); const chatA = toChatId({ raw: 'chat-aa' }), chatB = toChatId({ raw: 'chat-bb' });
    expect(await fixture.view.connectChat({ chatId: chatA })).toBe(true);
    const sessionA = fixture.view.selectedSessionId.value!;
    const sessionB = await fixture.view.newSession({ preserveDraft: false }); if (!sessionB) throw new Error('Missing session.');
    expect(await fixture.view.connectChat({ chatId: chatB })).toBe(true);
    await fixture.view.selectSession({ sessionId: sessionA }); expect(fixture.view.currentSession.value?.assistantChatId).toBe(chatA);
    await fixture.view.reload(); expect(fixture.view.currentSession.value?.assistantChatId).toBe(chatA);
    await fixture.view.selectSession({ sessionId: sessionB.id }); expect(fixture.view.currentSession.value?.assistantChatId).toBe(chatB);
    await fixture.view.connectChat({ chatId: undefined }); await fixture.view.reload(); expect(fixture.view.currentSession.value?.assistantChatId).toBeUndefined();
    expect((await persistence.loadImageGenerationSession({ store: fixture.view.store.value!, sessionId: sessionA }))?.assistantChatId).toBe(chatA);
  });
  it('does not count a committed edit twice when its annotation readback fails', async () => {
    const fixture = await ready(); fixture.view.count.value = 2; await fixture.view.generate();
    const items = [...fixture.view.tiles.value];
    vi.spyOn(persistence, 'loadImageGenerationAssetAnnotations').mockRejectedValueOnce(new Error('readback failure'));
    await fixture.view.curate({ items, action: { type: 'archive' } });
    expect(fixture.view.failure.value).toContain('1 completed; 1 failed');
    expect(fixture.view.failure.value).not.toContain('2 completed');
    fixture.view.visibility.value = 'archived'; await fixture.view.refresh({ append: false });
    expect(fixture.view.tiles.value).toHaveLength(2);
  });
  it('does not show an empty failed-run group after archiving all of its completed images', async () => {
    const fixture = await ready();
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/', component: ImageGeneration }] });
    await router.push('/'); await router.isReady();
    const surface = mount(ImageGeneration, { props: { generation: fixture.generation, active: true }, global: { plugins: [router] } });
    const view = surface.vm.TEST_ONLY.view;
    try {
      await flushPromises(); view.count.value = 2;
      fixture.native.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('second image failed'));
      await view.generate(); await flushPromises();
      expect(view.tiles.value).toHaveLength(1); expect(view.runs.value[0]?.execution.type).toBe('failed');
      expect(surface.find('[data-testid="workspace-run"]').exists()).toBe(true);
      await view.curate({ items: [...view.tiles.value], action: { type: 'archive' } }); await flushPromises();
      expect(surface.find('[data-testid="workspace-run"]').exists()).toBe(false);
      view.visibility.value = 'archived'; await view.refresh({ append: false }); await flushPromises();
      expect(surface.find('[data-testid="workspace-run"]').exists()).toBe(true);
    } finally {
      await view.flushDraft(); surface.unmount(); await flushPromises();
    }
  });
  it('renders recorded JSON with the existing highlighter and copies the exact selected prompt', async () => {
    const fixture = await ready(); fixture.generation.parameters.value.prompt = '日本語 prompt <script>not executable</script>';
    await fixture.view.generate(); const tile = fixture.view.tiles.value[0]!;
    const writeText = vi.fn().mockResolvedValue(undefined); Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const surface = mount(ImageGenerationAssetViewer, { props: { view: fixture.view, active: true } });
    try {
      await fixture.view.inspect({ tile }); await flushPromises();
      const viewer = new DOMWrapper(document.querySelector<HTMLElement>('[data-testid="image-viewer"]')!);
      await viewer.get('[data-testid="image-viewer-details-toggle"]').trigger('click');
      expect(viewer.find('pre span').exists()).toBe(true);
      expect(viewer.find('pre script').exists()).toBe(false);
      await viewer.get('[data-testid="workspace-copy-prompt"]').trigger('click'); await flushPromises();
      expect(writeText).toHaveBeenCalledWith('日本語 prompt <script>not executable</script>');
      expect(viewer.text()).toContain('Copied');
    } finally {
      surface.unmount();
    }
  });
});

describe('global experimental preferences and compact creation controls', () => {
  it('shows the inline notice only after output, keeps it across filtering, and dismisses it across sessions and remounts', async () => {
    const fixture = await ready();
    expect(fixture.view.experimentalNoticeVisible.value).toBe(false);
    await fixture.view.generate(); expect(fixture.view.experimentalNoticeVisible.value).toBe(true);
    fixture.view.text.value = 'not in any prompt'; await fixture.view.refresh({ append: false });
    expect(fixture.view.tiles.value).toEqual([]); expect(fixture.view.experimentalNoticeVisible.value).toBe(true);
    expect(await fixture.view.updatePreferences({ change: { type: 'dismiss-notice' } })).toBe(true);
    const saved = await persistence.loadImageGenerationCatalog({ store: fixture.view.store.value! });
    expect(saved.preferences.experimentalNoticeDismissedAt).toEqual(expect.any(Number));
    await fixture.view.newSession({ preserveDraft: false });
    expect(fixture.view.experimentalNoticeVisible.value).toBe(false);
    await fixture.view.generate(); expect(fixture.view.experimentalNoticeVisible.value).toBe(false);
    const reloaded = await ready();
    expect(reloaded.view.catalog.value?.preferences.experimentalNoticeDismissedAt).toBe(saved.preferences.experimentalNoticeDismissedAt);
    expect(reloaded.view.experimentalNoticeVisible.value).toBe(false);
  });
  it('does not hide the notice on failed persistence and permits an explicit retry', async () => {
    const fixture = await ready(); await fixture.view.generate();
    vi.spyOn(persistence, 'saveImageGenerationCatalog').mockRejectedValueOnce(new Error('disk full'));
    expect(await fixture.view.updatePreferences({ change: { type: 'dismiss-notice' } })).toBe(false);
    expect(fixture.view.experimentalNoticeVisible.value).toBe(true);
    expect(fixture.view.failure.value).toContain('disk full');
    expect(await fixture.view.updatePreferences({ change: { type: 'dismiss-notice' } })).toBe(true);
    expect(fixture.view.experimentalNoticeVisible.value).toBe(false);
  });
  it('stores dock preferences in the experimental catalog and does not revert another tab tag edit', async () => {
    const fixture = await ready(); await fixture.view.generate();
    const other = await ready(); await other.view.editTag({ tagId: undefined, name: '別のタブの候補' });
    expect(await fixture.view.updatePreferences({ change: { type: 'assistant-layout', layout: 'docked' } })).toBe(true);
    const reloaded = await ready();
    expect(reloaded.view.assistantLayout.value).toBe('docked');
    expect(reloaded.view.userTags.value.map(tag => tag.name)).toEqual(['別のタブの候補']);
    expect(reloaded.view.catalog.value?.preferences.experimentalNoticeDismissedAt).toBeUndefined();
  });
  it('copies full run prompts without opening a viewer or changing the draft, then exposes the same action in flat gallery cards', async () => {
    const fixture = await ready(); const prompt = `  日本語 <script>text only</script> ${'long '.repeat(600)}  `;
    fixture.generation.parameters.value.prompt = prompt; await fixture.view.generate();
    fixture.generation.parameters.value.prompt = 'different next draft';
    vi.spyOn(generationComposition, 'useImageGenerationWorkspace').mockReturnValueOnce(fixture.view);
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/', component: ImageGeneration, props: { generation: fixture.generation, active: true } }] });
    await router.push('/'); await router.isReady(); const surface = mount(RouterView, { global: { plugins: [router] } });
    const writeText = vi.fn().mockResolvedValue(undefined); Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    try {
      await flushPromises(); await surface.get('[data-testid="workspace-copy-run-prompt"]').trigger('click'); await flushPromises();
      expect(writeText).toHaveBeenLastCalledWith(prompt); expect(fixture.view.inspectedTile.value).toBeUndefined();
      expect(fixture.generation.parameters.value.prompt).toBe('different next draft');
      fixture.view.mode.value = 'gallery'; await flushPromises();
      await surface.get('[data-testid="workspace-copy-card-prompt"]').trigger('click'); await flushPromises();
      expect(writeText).toHaveBeenCalledTimes(2); expect(writeText).toHaveBeenLastCalledWith(prompt);
      expect(surface.find('script').exists()).toBe(false);
    } finally {
      surface.unmount();
    }
  });
  it('keeps tag explanations behind a small explicit control and expands bulk tags in a separate toolbar row', async () => {
    const fixture = await ready(); fixture.view.count.value = 2; await fixture.view.generate();
    await fixture.view.editTag({ tagId: undefined, name: '候補' });
    const surface = mount(ImageGenerationCurationActions, { props: { view: fixture.view, items: [...fixture.view.tiles.value] } });
    try {
      expect(surface.find('[data-testid="workspace-bulk-tags-panel"]').exists()).toBe(false);
      await surface.get('[data-testid="workspace-bulk-tags-toggle"]').trigger('click');
      const tags = surface.get('[data-testid="workspace-bulk-tags-panel"]');
      const archive = surface.get('[data-testid="workspace-bulk-archive"]');
      expect(tags.element.parentElement).toBe(archive.element.parentElement?.parentElement);
      expect(tags.element.parentElement).not.toBe(archive.element.parentElement);
      await surface.get('[data-testid="workspace-bulk-tag-choice"]').setValue(idToRaw({ id: fixture.view.userTags.value[0]!.id }));
      await surface.get('[data-testid="workspace-bulk-tag-add"]').trigger('click'); await flushPromises();
      expect(fixture.view.tiles.value.every(tile => tile.annotations?.tags.length === 1)).toBe(true);
    } finally {
      surface.unmount();
    }
  });
  it('docks in normal layout without a focus trap and moves the same ChatPane into floating mode', async () => {
    const fixture = await ready(); const a: Chat = { id: toChatId({ raw: 'docked-chat-aa' }), title: 'Docked chat', createdAt: 1, updatedAt: 1, root: { items: [] }, debugEnabled: false };
    chatChoices.value = [a]; await fixture.view.connectChat({ chatId: a.id });
    vi.spyOn(chatDataStore, 'getLiveChatById').mockReturnValue(a); vi.spyOn(chatDataStore, 'getLiveChat').mockReturnValue(a);
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/', component: { render: () => h('div') } }] });
    await router.push('/'); await router.isReady();
    const surface = mount(ImageGenerationAssistant, { props: { workspace: fixture.view, active: true, presentation: 'docked' }, attachTo: document.body, global: { plugins: [router] } });
    try {
      await vi.dynamicImportSettled(); await flushPromises();
      const panel = surface.get('[data-testid="image-generation-assistant"]');
      expect(panel.attributes('role')).toBe('complementary'); expect(panel.attributes('aria-modal')).toBeUndefined();
      expect(surface.find('[data-testid="workspace-chat-overlay"]').exists()).toBe(false);
      expect(surface.find('[data-testid="workspace-chat-help"]').exists()).toBe(false);
      const pane = panel.get('[data-testid="existing-chat-pane"]').element;
      const key = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }); panel.element.dispatchEvent(key);
      expect(key.defaultPrevented).toBe(false);
      await panel.trigger('keydown', { key: 'Escape' }); expect(surface.emitted('close')).toBeUndefined();
      await surface.setProps({ presentation: 'floating' }); await flushPromises();
      const floating = new DOMWrapper(document.querySelector<HTMLElement>('[data-testid="workspace-chat-overlay"]')!);
      expect(floating.get('[data-testid="existing-chat-pane"]').element).toBe(pane);
      expect(floating.get('[data-testid="image-generation-assistant"]').attributes('aria-modal')).toBe('true');
      expect(getImageGenerationToolsForChat({ chatId: a.id })).toHaveLength(2);
      await floating.get('[data-testid="workspace-chat-help-toggle"]').trigger('click');
      expect(floating.get('[data-testid="workspace-chat-help"]').text()).toContain('prompt');
      await floating.get('[data-testid="image-generation-assistant"]').trigger('keydown', { key: 'Escape' });
      expect(surface.emitted('close')).toHaveLength(1);
    } finally {
      surface.unmount();
    }
    expect(getImageGenerationToolsForChat({ chatId: a.id })).toEqual([]);
  });
  it('recovers a persisted chat selection when the chat list arrives late', async () => {
    const fixture = await ready(); const a: Chat = { id: toChatId({ raw: 'late-chat-aa' }), title: 'Late chat', createdAt: 1, updatedAt: 1, root: { items: [] }, debugEnabled: false };
    await fixture.view.connectChat({ chatId: a.id });
    vi.spyOn(chatDataStore, 'getLiveChatById').mockReturnValue(a); vi.spyOn(chatDataStore, 'getLiveChat').mockReturnValue(a);
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/', component: { render: () => h('div') } }] });
    await router.push('/'); await router.isReady();
    const surface = mount(ImageGenerationAssistant, { props: { workspace: fixture.view, active: true, presentation: 'docked' }, global: { plugins: [router] } });
    try {
      await flushPromises(); expect(surface.find('[data-testid="existing-chat-pane"]').exists()).toBe(false);
      expect(fixture.view.currentSession.value?.assistantChatId).toBe(a.id);
      chatChoices.value = [a]; await vi.dynamicImportSettled(); await flushPromises();
      expect(surface.get('[data-testid="existing-chat-pane"]').attributes('data-chat-id')).toBe(idToRaw({ id: a.id }));
    } finally {
      surface.unmount();
    }
  });
});

describe('session navigation, deletion and persisted chat visibility', () => {
  it('loads a requested session instead of whichever was most recently updated', async () => {
    const fixture = await ready(); const a = await fixture.view.newSession({ preserveDraft: true });
    const b = await fixture.view.newSession({ preserveDraft: false }); if (!a || !b) throw new Error('Missing sessions.');
    const opened = open({ requestedSessionId: ref(a.id) }); await flushPromises();
    expect(opened.view.currentSession.value?.id).toBe(a.id);
    const missing = open({ requestedSessionId: ref(toImageGenerationSessionId({ raw: 'missing-session' })) }); await flushPromises();
    expect(missing.view.currentSession.value).toBeUndefined(); expect(missing.view.failure.value).toContain('unavailable');
    expect(missing.view.editor.draftDisabled.value).toBe(true);
  });
  it('removes a session and its metadata without deleting generated BinaryObjects', async () => {
    const fixture = await ready(); await fixture.view.generate();
    const sessionId = fixture.view.selectedSessionId.value!, image = fixture.view.tiles.value[0]!;
    await fixture.view.inspect({ tile: image });
    expect(await fixture.view.deleteSession({ sessionId })).toBe(true);
    expect(fixture.view.currentSession.value).toBeUndefined(); expect(fixture.view.tiles.value).toEqual([]);
    expect(fixture.view.inspectedTile.value).toBeUndefined(); expect(mocks.remove).not.toHaveBeenCalled();
    expect(await provider.getFile({ binaryObjectId: image.binaryObjectId })).toBeTruthy();
    await fixture.view.reload(); expect(fixture.view.sessions.value).toEqual([]);
  });
  it('does not lose the current draft autosave when deleting a different session', async () => {
    const fixture = await ready();
    const removed = await fixture.view.newSession({ preserveDraft: true });
    const retained = await fixture.view.newSession({ preserveDraft: false });
    if (!removed || !retained || !fixture.view.store.value) throw new Error('No sessions.');
    await fixture.view.flushDraft();
    fixture.generation.parameters.value.prompt = 'pending autosave survives unrelated deletion';
    expect(fixture.view.draftStatus.value).toBe('dirty');
    expect(await fixture.view.deleteSession({ sessionId: removed.id })).toBe(true);
    const restored = await persistence.loadImageGenerationDraft({ store: fixture.view.store.value, sessionId: retained.id });
    expect(restored?.request.parameters.prompt).toBe('pending autosave survives unrelated deletion');
    expect(fixture.view.currentSession.value?.id).toBe(retained.id);
  });
  it('refuses to delete the executing session or outputs awaiting publication', async () => {
    const fixture = await ready(); const session = await fixture.view.newSession({ preserveDraft: true }); if (!session) throw new Error('No session.');
    const gate = Promise.withResolvers<void>(); fixture.native.mockReturnValueOnce(gate.promise);
    const operation = fixture.view.generate(); await vi.waitFor(() => expect(fixture.native).toHaveBeenCalled());
    try {
      expect(await fixture.view.deleteSession({ sessionId: session.id })).toBe(false);
    } finally {
      gate.resolve(); await operation;
    }
    mocks.publish.mockRejectedValueOnce(new Error('quota'));
    await fixture.view.generate(); expect(fixture.view.hasPendingSave.value).toBe(true);
    expect(await fixture.view.deleteSession({ sessionId: session.id })).toBe(false);
    await fixture.view.retrySave();
  });
  it('keeps a closed attached chat closed after remount even when its layout is docked', async () => {
    const fixture = await ready(); await fixture.view.connectChat({ chatId: toChatId({ raw: 'remembered-chat' }) });
    await fixture.view.updatePreferences({ change: { type: 'assistant-layout', layout: 'docked' } });
    await fixture.view.updatePreferences({ change: { type: 'assistant-visibility', visibility: 'open' } });
    await fixture.view.updatePreferences({ change: { type: 'assistant-visibility', visibility: 'closed' } });
    const reopened = await ready();
    expect(reopened.view.assistantLayout.value).toBe('docked'); expect(reopened.view.assistantVisibility.value).toBe('closed');
    expect(reopened.view.currentSession.value?.assistantChatId).toBe(toChatId({ raw: 'remembered-chat' }));
    vi.spyOn(generationComposition, 'useImageGenerationWorkspace').mockReturnValueOnce(reopened.view);
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/', component: ImageGeneration, props: { generation: reopened.generation, active: true } }] });
    await router.push('/'); await router.isReady(); const surface = mount(RouterView, { global: { plugins: [router] } });
    try {
      await vi.dynamicImportSettled(); await flushPromises();
      expect(surface.get('[data-testid="workspace-open-chat"]').text()).toBe('Open chat');
      expect(surface.get('[data-testid="workspace-open-chat"]').attributes('aria-expanded')).toBe('false');
      expect(document.querySelector('[data-testid="image-generation-assistant"]')).toBeNull();
    } finally {
      surface.unmount();
    }
  });
});

describe('read-only translation controls', () => {
  it.each(['prompt', 'negativePrompt'] as const)('views and copies %s translation without editing or persisting a chat', async field => {
    const fixture = await ready(); await fixture.view.newSession({ preserveDraft: true });
    const { settings, TEST_ONLY: settingsTest } = useSettings(), originalSettings = settings.value;
    settingsTest.__testOnlySetSettings({ newSettings: { ...originalSettings, endpoint: { type: 'ollama', url: 'http://translator.test', httpHeaders: undefined }, defaultModelId: 'translator' } });
    await ensureAllStringsForTest({ locale: 'ja' });
    const original = `\
  soft colors 🐈
(weight:1.2)  `, before = { ...fixture.generation.parameters.value };
    translationMocks.translate.mockResolvedValue('柔らかな色');
    const writeText = vi.fn().mockResolvedValue(undefined); vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    const surface = mount(ImageGenerationTranslationButton, { props: { workspace: fixture.view, text: original, field, active: true } });
    const published = mocks.publish.mock.calls.length;
    try {
      await surface.get('[data-testid="view-prompt-translation"]').trigger('click'); await flushPromises();
      const dialog = new DOMWrapper(document.querySelector<HTMLElement>('[data-testid="prompt-translation-dialog"]')!);
      expect(dialog.get('select[data-testid="translation-language"]').element).toHaveProperty('value', 'ja');
      expect(translationMocks.translate).not.toHaveBeenCalled();
      await dialog.get('[data-testid="translation-start"]').trigger('click'); await flushPromises();
      expect(translationMocks.translate).toHaveBeenCalledWith(expect.objectContaining({ prompt: original, language: 'ja', modelId: 'translator' }));
      expect(dialog.get('[data-testid="translation-result"]').text()).toContain('柔らかな色');
      await dialog.get('[data-testid="translation-result"] button').trigger('click'); await flushPromises();
      expect(writeText).toHaveBeenCalledWith('柔らかな色');
      expect(fixture.generation.parameters.value).toEqual(before); expect(mocks.publish.mock.calls.length).toBe(published);
      expect(chatChoices.value).toEqual([]);
    } finally {
      surface.unmount(); settingsTest.__testOnlySetSettings({ newSettings: originalSettings });
    }
  });
  it('cancels and discards late translation when the prompt, language, endpoint or session changes', async () => {
    const fixture = await ready(); await fixture.view.newSession({ preserveDraft: true });
    const { settings, TEST_ONLY: settingsTest } = useSettings(), originalSettings = settings.value;
    settingsTest.__testOnlySetSettings({ newSettings: { ...originalSettings, defaultModelId: 'model' } });
    const surface = mount(ImageGenerationTranslationButton, { props: { workspace: fixture.view, text: 'before', field: 'prompt', active: true } });
    try {
      await surface.get('button').trigger('click'); await flushPromises();
      const dialog = new DOMWrapper(document.querySelector<HTMLElement>('[data-testid="prompt-translation-dialog"]')!);
      const gate = Promise.withResolvers<string>(); translationMocks.translate.mockReturnValueOnce(gate.promise);
      await dialog.get('[data-testid="translation-start"]').trigger('click');
      const signal: AbortSignal = translationMocks.translate.mock.calls[0]![0].signal;
      await surface.setProps({ text: 'after' }); expect(signal.aborted).toBe(true);
      gate.resolve('stale'); await flushPromises(); expect(dialog.find('[data-testid="translation-result"]').exists()).toBe(false);
      const later = Promise.withResolvers<string>(); translationMocks.translate.mockReturnValueOnce(later.promise);
      await dialog.get('[data-testid="translation-start"]').trigger('click');
      await fixture.view.newSession({ preserveDraft: false });
      expect(translationMocks.translate.mock.calls[1]![0].signal.aborted).toBe(true);
      later.resolve('other session'); await flushPromises(); expect(dialog.text()).not.toContain('other session');
      await dialog.get('[data-testid="translation-close"]').trigger('click'); expect(document.querySelector('[data-testid="prompt-translation-dialog"]')).toBeNull();
    } finally {
      surface.unmount(); settingsTest.__testOnlySetSettings({ newSettings: originalSettings });
    }
  });
  it('persists workspace defaults and independent session model overrides without changing global connection settings', async () => {
    const fixture = await ready(); await fixture.view.newSession({ preserveDraft: true });
    const { settings, availableModels } = useSettings(); const endpoint = settings.value.endpoint, modelId = settings.value.defaultModelId;
    const globalModels = [...availableModels.value];
    const surface = mount(ImageGenerationTranslationSettings, { props: { workspace: fixture.view, scope: 'workspace' } });
    try {
      await surface.get('[data-testid="translation-endpoint-choice"]').setValue('ollama');
      await surface.get('[data-testid="translation-endpoint-url"]').setValue('http://workspace.test');
      await surface.get('[data-testid="translation-model-input"]').setValue('workspace-model');
      await surface.get('[data-testid="translation-settings-save"]').trigger('click'); await flushPromises();
      expect(fixture.view.catalog.value?.preferences.translation).toEqual({ endpoint: { type: 'ollama', url: 'http://workspace.test', httpHeaders: undefined }, modelId: 'workspace-model' });
      await surface.setProps({ scope: 'session' });
      await surface.get('[data-testid="translation-model-input"]').setValue('session-model');
      await surface.get('[data-testid="translation-settings-save"]').trigger('click'); await flushPromises();
      expect(fixture.view.currentSession.value?.translation).toEqual({ endpoint: undefined, modelId: 'session-model' });
      await fixture.view.reload(); expect(fixture.view.currentSession.value?.translation?.modelId).toBe('session-model');
      translationMocks.provider.mockResolvedValue({ listModels: vi.fn(async () => ['private-model']) });
      surface.getComponent(ModelSelector).vm.$emit('refresh'); await flushPromises();
      expect(surface.getComponent(ModelSelector).props('models')).toEqual(['private-model']);
      expect(availableModels.value).toEqual(globalModels); expect(settings.value.endpoint).toEqual(endpoint); expect(settings.value.defaultModelId).toBe(modelId);
    } finally {
      surface.unmount();
    }
  });
  it('hides disabled RPC choices in translation settings and preserves a saved RPC reference', async () => {
    const fixture = await ready();
    const { settings, TEST_ONLY: settingsTest } = useSettings(), originalSettings = settings.value;
    settingsTest.__testOnlySetSettings({ newSettings: { ...originalSettings, experimental: { ...originalSettings.experimental, naidanRpc: 'disabled' } } });
    const surface = mount(ImageGenerationTranslationSettings, { props: { workspace: fixture.view, scope: 'workspace' }, global: { stubs: { RpcConnectionSelect: true } } });
    try {
      await flushPromises();
      expect(surface.get('[data-testid="translation-endpoint-choice"]').find('option[value="naidan_rpc"]').exists()).toBe(false);
      await fixture.view.updatePreferences({ change: { type: 'translation', translation: { endpoint: { type: 'naidan_rpc', connectionId: undefined }, modelId: 'remote-translator' } } });
      await flushPromises();
      const select = surface.get('[data-testid="translation-endpoint-choice"]');
      expect(select.element).toHaveProperty('value', 'naidan_rpc');
      expect(select.get('option[value="naidan_rpc"]').element).toHaveProperty('disabled', true);
      await surface.get('[data-testid="translation-settings-save"]').trigger('click'); await flushPromises();
      expect(fixture.view.catalog.value?.preferences.translation).toEqual({ endpoint: { type: 'naidan_rpc', connectionId: undefined }, modelId: 'remote-translator' });
      settingsTest.__testOnlySetSettings({ newSettings: { ...originalSettings, experimental: { ...originalSettings.experimental, naidanRpc: 'enabled' } } });
      await flushPromises(); expect(select.get('option[value="naidan_rpc"]').element).toHaveProperty('disabled', false);
      expect(translationMocks.translate).not.toHaveBeenCalled();
    } finally {
      surface.unmount(); settingsTest.__testOnlySetSettings({ newSettings: originalSettings });
    }
  });
});


it('retains a failed successful image after unmount and saves it from a new workspace without rerunning inference', async () => {
  const h = await ready();
  let fail = true;
  mocks.publish.mockImplementation(async (value: Publication) => {
    if (value.publication.type === 'asset' && fail) {
      fail = false; throw new Error('quota');
    }
    await publish(value);
  });
  await h.view.generate(); expect(h.native).toHaveBeenCalledOnce();
  const before = imagePendingRuns.list().find(entry => entry.state.needsRetry)!;
  const asset = before.state.pending[0]!.asset;
  h.wrapper.unmount(); await flushPromises();
  const next = await ready();
  expect(imagePendingRuns.list().find(entry => entry.id === before.id)?.state.pending[0]?.asset.id).toBe(asset.id);
  await imagePendingRuns.retry({ id: before.id });
  expect(next.native).not.toHaveBeenCalled(); expect(h.native).toHaveBeenCalledOnce();
  const saved = await persistence.loadImageGenerationAsset({ store: before.store, sessionId: before.sessionId, assetId: asset.id });
  expect(saved?.result.binaryObjectId).toBe(asset.result.binaryObjectId);
  expect(imagePendingRuns.list().some(entry => entry.id === before.id)).toBe(false);
});
it('retains only a failed terminal save across unmount and does not generate or duplicate assets on retry', async () => {
  const h = await ready();
  const realUpdate = persistence.updateImageGenerationRunExecution;
  let fail = true;
  vi.spyOn(persistence, 'updateImageGenerationRunExecution').mockImplementation(async request => {
    if (request.execution.type === 'completed' && fail) {
      fail = false; throw new Error('terminal');
    }
    return realUpdate(request);
  });
  // The fixture reports its catch path too; the sink deliberately rejects a
  // duplicate terminal but the first failed terminal must still remain owned.
  await h.view.generate().catch(() => {});
  const entry = imagePendingRuns.list().find(item => item.state.needsRetry)!;
  expect(entry.state.pending).toEqual([]);
  h.wrapper.unmount(); await flushPromises();
  const writes = mocks.publish.mock.calls.length;
  await imagePendingRuns.retry({ id: entry.id });
  expect(mocks.publish).toHaveBeenCalledTimes(writes); expect(h.native).toHaveBeenCalledOnce();
  expect(imagePendingRuns.list()).toEqual([]);
});
it('offers explicit temporary generation after storage opening fails without changing the editor or global storage', async () => {
  vi.spyOn(persistence, 'openImageGenerationStore').mockRejectedValue(new Error('Storage unavailable'));
  const h = open(); await flushPromises();
  h.generation.parameters.value.prompt = 'keep prompt'; h.generation.parameters.value.seed = '41'; h.view.count.value = 3;
  expect(h.view.storageUnavailable.value).toBe(true); expect(h.native).not.toHaveBeenCalled();
  expect(h.view.useTemporary()).toBe(true); expect(mocks.storage).toBe('opfs');
  expect(h.view.available.value).toBe(false); expect(h.generation.parameters.value.prompt).toBe('keep prompt');
  await h.view.generate(); expect(h.native).toHaveBeenCalledTimes(3); expect(mocks.publish).not.toHaveBeenCalled();
  expect(h.view.count.value).toBe(3); expect(h.generation.parameters.value.seed).toBe('41');
});
