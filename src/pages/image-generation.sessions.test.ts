import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { computed, defineComponent, h, onScopeDispose } from 'vue';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createMemoryHistory, createRouter, RouterView } from 'vue-router';
import { routes } from 'vue-router/auto-routes';
import { ensureAllStringsForTest } from '@/strings/test-utils';
import { idToRaw } from '@/01-models/ids';
import type { ImageGenerationView } from '@/features/stable-diffusion-cpp-browser/use-image-generation-types';
import type { ImageGenerationDraft } from '@/features/stable-diffusion-cpp-browser/generation-draft';
import { createImageGenerationStorageHarness, generationSessionFixture, generationDraftFixture } from '@/00-storage/service/image-generation/test-support';
import * as persistence from '@/00-storage/service/image-generation';
import type { storageService } from '@/00-storage/service';
import { useImageGenerationWorkspaceNavigation } from '@/features/stable-diffusion-cpp-browser/session/navigation';
import ImageGenerationSidebar from '@/features/stable-diffusion-cpp-browser/components/ImageGenerationSidebar.vue';
import { createImageGenerationQueryWorker } from '@/features/stable-diffusion-cpp-browser/session/query-worker/impl';
import { generationQueryResultSchema } from '@/features/stable-diffusion-cpp-browser/session/query-worker/types';
// Compile the actual surfaces during module collection, like other component
// integration tests. A route's first lazy import must not charge the whole UI
// transform graph to the first session-navigation test's 5-second deadline.
// Keep the generated routes and the real workspace/storage/controller below.
import ImageGenerationPage from './image-generation.vue';
import ImageGenerationWorkspace from '@/features/stable-diffusion-cpp-browser/components/ImageGenerationWorkspace.vue';
const mocks = vi.hoisted(() => ({ query: vi.fn(), publish: vi.fn(), restore: vi.fn(), confirm: vi.fn(), owners: 0, disposed: 0 }));
vi.mock('@/00-storage/service', () => ({ storageService: { getCurrentType: () => 'opfs', subscribeToChanges: () => () => {}, publishImageGeneration: mocks.publish } }));
vi.mock('@/composables/useConfirm', () => ({ useConfirm: () => ({ showConfirm: mocks.confirm }) }));
vi.mock('@/features/stable-diffusion-cpp-browser/session/query-worker/client', () => ({ createImageGenerationQueryClient: () => ({ query: mocks.query, async dispose() {} }) }));
vi.mock('@/features/stable-diffusion-cpp-browser/use-image-generation', async () => {
  const { useImageGeneration } = await import('@/features/stable-diffusion-cpp-browser/use-image-generation-standalone');
  return { useImageGeneration(): ImageGenerationView {
    mocks.owners++; onScopeDispose(() => {
      mocks.disposed++;
    });
    const form = useImageGeneration();
    const base = generationDraftFixture({ sessionId: generationSessionFixture({ id: 'session-aa' }).id });
    return { ...form, supported: computed(() => true), formDisabled: computed(() => false), draftDisabled: computed(() => false),
      captureDraft(): ImageGenerationDraft {
        return { ...base, request: { ...base.request, parameters: { ...form.parameters.value } }, files: [], modelFiles: [] };
      },
      async restoreDraft({ draft }) {
        await mocks.restore({ draft }); form.parameters.value = { ...draft.request.parameters };
      },
      resetDraft() {
        form.parameters.value = { ...form.parameters.value, prompt: '', negativePrompt: '' };
      },
    };
  } };
});
const a = generationSessionFixture({ id: 'session-aa' }), b = { ...generationSessionFixture({ id: 'session-bb' }), title: 'Second purpose', updatedAt: 10 };
let wrapper: VueWrapper | undefined;
beforeEach(async () => {
  vi.resetAllMocks(); mocks.owners = 0; mocks.disposed = 0; mocks.confirm.mockResolvedValue(true); mocks.restore.mockResolvedValue(undefined);
  createImageGenerationStorageHarness(); await ensureAllStringsForTest({ locale: 'en' });
  const catalog = await persistence.openImageGenerationStore({ storageType: 'opfs', creation: 'allow' }); if (!catalog) throw new Error('Missing catalog.');
  const store = { storeId: catalog.id, storageType: 'opfs' as const };
  for (const session of [a, b]) {
    await persistence.saveImageGenerationSession({ store, session, expectedRevision: undefined });
    const draft = generationDraftFixture({ sessionId: session.id }); draft.request.parameters.prompt = session.id === a.id ? 'first draft' : 'second draft';
    await persistence.saveImageGenerationDraft({ store, draft, expectedRevision: undefined, writeInputs: async () => {} });
  }
  const worker = createImageGenerationQueryWorker(); mocks.query.mockImplementation(async request => generationQueryResultSchema.parse(await worker.query({ request })));
  mocks.publish.mockImplementation(async ({ store, publication }: Parameters<typeof storageService.publishImageGeneration>[0]) => {
    if (publication.type !== 'draft') throw new Error('This test publishes only drafts.');
    await persistence.saveImageGenerationDraft({ store, draft: publication.draft, expectedRevision: publication.expectedRevision, writeInputs: async () => {} });
  });
});
afterEach(async () => {
  await useImageGenerationWorkspaceNavigation().active.value?.view?.flushDraft();
  wrapper?.unmount(); wrapper = undefined; await flushPromises(); vi.unstubAllGlobals(); vi.restoreAllMocks();
});
async function open({ path }: { path: string }) {
  const router = createRouter({ history: createMemoryHistory(), routes: [...routes.filter(route => route.path === '/image-generation'), { path: '/', component: { template: '<div />' } }] });
  await router.push(path); await router.isReady();
  wrapper = mount(defineComponent({ setup() {
    const { active } = useImageGenerationWorkspaceNavigation();
    return () => h('div', [active.value ? h(ImageGenerationSidebar, { navigation: active.value }) : undefined, h(RouterView)]);
  } }), { global: { plugins: [router], stubs: { SidebarDebugControls: true } } });
  await vi.dynamicImportSettled(); await flushPromises();
  const view = useImageGenerationWorkspaceNavigation().active.value?.view;
  if (!view) throw new Error('Missing workspace owner.');
  return { router, view, page: wrapper.getComponent(ImageGenerationPage).vm, workspace: wrapper.getComponent(ImageGenerationWorkspace).vm };
}
it('opens an exact session URL, preserves one owner through models and gives new sessions their own URL', async () => {
  const { router, view, page, workspace } = await open({ path: '/image-generation/session/session-aa' });
  await vi.waitFor(() => expect(view.currentSession.value?.id).toBe(a.id));
  expect(view.editor.parameters.value.prompt).toBe('first draft'); expect(mocks.owners).toBe(1);
  await wrapper!.get('[data-testid="workspace-nav-models"]').trigger('click'); await vi.dynamicImportSettled(); await flushPromises();
  expect(router.currentRoute.value.path).toBe('/image-generation/models');
  await wrapper!.get('[data-testid="workspace-nav-generate"]').trigger('click'); await vi.dynamicImportSettled(); await flushPromises();
  expect(router.currentRoute.value.path).toBe('/image-generation/session/session-aa');
  await wrapper!.get('[data-testid="workspace-new-session"]').trigger('click'); await flushPromises();
  expect(view.currentSession.value?.id).not.toBe(a.id); expect(view.currentSession.value?.id).not.toBe(b.id);
  expect(router.currentRoute.value.path).toBe('/image-generation/session/' + idToRaw({ id: view.currentSession.value!.id }));
  expect(wrapper!.getComponent(ImageGenerationPage).vm.$.uid).toBe(page.$.uid);
  expect(wrapper!.getComponent(ImageGenerationWorkspace).vm.$.uid).toBe(workspace.$.uid);
  expect(mocks.owners).toBe(1); expect(mocks.disposed).toBe(0);
});
it('loads the explicit session on reload and never redirects a missing session to unrelated work', async () => {
  const { router, view } = await open({ path: '/image-generation/session/session-aa' });
  expect(view.currentSession.value?.id).toBe(a.id);
  await router.push('/image-generation/session/missing-aa'); await flushPromises();
  expect(view.currentSession.value).toBeUndefined(); expect(view.failure.value).toContain('unavailable');
  expect(router.currentRoute.value.path).toBe('/image-generation/session/missing-aa');
  expect(view.editor.draftDisabled.value).toBe(true); expect(mocks.owners).toBe(1);
});
it('keeps only the latest route while an earlier draft restore is pending', async () => {
  const gate = Promise.withResolvers<void>(); mocks.restore.mockImplementationOnce(() => gate.promise);
  const { router, view } = await open({ path: '/image-generation/session/session-aa' });
  expect(view.switching.value).toBe(true);
  await router.push('/image-generation/session/session-bb'); await flushPromises();
  gate.resolve(); await vi.waitFor(() => expect(view.editorReady.value && view.currentSession.value?.id === b.id).toBe(true));
  expect(view.editor.parameters.value.prompt).toBe('second draft'); expect(router.currentRoute.value.path).toBe('/image-generation/session/session-bb');
  expect(mocks.owners).toBe(1);
});
it('replaces only the entry URL with the selected session and returns to the entry after deletion', async () => {
  const { router, view } = await open({ path: '/image-generation' });
  await vi.waitFor(() => expect(router.currentRoute.value.path).toBe('/image-generation/session/session-bb'));
  const index = view.sessions.value.findIndex(session => session.id === b.id);
  await wrapper!.findAll('[data-testid="generation-delete-session"]')[index]!.trigger('click'); await flushPromises();
  expect(router.currentRoute.value.path).toBe('/image-generation'); expect(view.currentSession.value).toBeUndefined();
  expect(view.sessions.value.map(session => session.id)).toEqual([a.id]);
  expect(mocks.confirm.mock.calls[0]![0].message).toContain('Image files');
});


it('restores each draft through browser back and forward without replacing the runtime owner', async () => {
  const { router, view } = await open({ path: '/image-generation/session/session-aa' });
  view.editor.parameters.value.prompt = 'edited first draft'; await view.flushDraft();
  await router.push('/image-generation/session/session-bb'); await flushPromises();
  expect(view.editor.parameters.value.prompt).toBe('second draft');
  const waitForBack = new Promise<void>(resolve => {
    const stop = router.afterEach(() => {
      stop(); resolve();
    });
  });
  router.back(); await waitForBack; await flushPromises();
  expect(view.currentSession.value?.id).toBe(a.id); expect(view.editor.parameters.value.prompt).toBe('edited first draft');
  const waitForForward = new Promise<void>(resolve => {
    const stop = router.afterEach(() => {
      stop(); resolve();
    });
  });
  router.forward(); await waitForForward; await flushPromises();
  expect(view.currentSession.value?.id).toBe(b.id); expect(view.editor.parameters.value.prompt).toBe('second draft');
  expect(mocks.owners).toBe(1); expect(mocks.disposed).toBe(0);
});
