import { flushPromises } from '@vue/test-utils';
import { defineComponent, effectScope, ref, shallowRef } from 'vue';
import { createMemoryHistory, createRouter, START_LOCATION } from 'vue-router';
import { describe, expect, it, vi } from 'vitest';
import type { Settings } from '@/01-models/types';
import type { StartupState } from '@/logic/startup/types';
import { TEST_ONLY, useAppEntry } from './useAppEntry';

async function createEntryHarness({ path, startupKind }: { path: string, startupKind: 'initializing-foundation' | 'ready' }) {
  const page = defineComponent({ template: '<div />' });
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:pathMatch(.*)*', component: page }] });
  await router.push(path);
  const startupState = shallowRef<StartupState>({ kind: 'initializing-foundation' });
  switch (startupKind) {
  case 'initializing-foundation':
    break;
  case 'ready':
    startupState.value = { kind: 'ready', mainApp: page };
    break;
  default: {
    const _ex: never = startupKind;
    throw new Error(`Unhandled harness startup: ${String(_ex)}`);
  }
  }
  const settings = ref<Pick<Settings, 'endpoint' | 'defaultModelId'>>({ endpoint: { type: 'openai', url: '' }, defaultModelId: undefined });
  const initialized = ref(true);
  let generation = 0;
  const captureDefaults = vi.fn(() => {
    const capturedGeneration = generation;
    return Promise.resolve({ endpoint: settings.value.endpoint, modelId: settings.value.defaultModelId, revision: 0, storedMatches: true, isStorageCurrent: () => capturedGeneration === generation });
  });
  const defer = vi.fn();
  const resume = vi.fn();
  const readHistoryEmpty = vi.fn(async () => true);
  const scope = effectScope();
  const entry = scope.run(() => TEST_ONLY.createAppEntry({
    router,
    startupState,
    settingsInitialized: initialized,
    settings,
    captureStorage: () => {
      const captured = generation;
      return () => captured === generation;
    },
    captureModelLaunchDefaults: captureDefaults,
    readHistoryEmpty,
    deferModelRefresh: defer,
    resumeModelRefresh: resume,
  }))!;
  return {
    router,
    startupState,
    settings,
    entry,
    defer,
    resume,
    captureDefaults,
    readHistoryEmpty,
    retireStorage: () => {
      generation++;
      settings.value = { ...settings.value };
    },
    [Symbol.dispose]() {
      scope.stop();
    },
  };
}

describe('application entry ownership', () => {
  it('opens the initial unconfigured root dialog before MainApp, and does not reopen it after settings', async () => {
    using harness = await createEntryHarness({ path: '/', startupKind: 'initializing-foundation' });
    harness.entry.initializeHomePresentation({ empty: true });
    expect(harness.entry.modelSelection.value).toBeUndefined();
    harness.startupState.value = { kind: 'starting-main' };
    expect(harness.entry.modelSelection.value?.phase).toBe('open');
    const presentation = harness.entry.modelSelection.value;
    const page = defineComponent({ template: '<div />' });
    harness.startupState.value = { kind: 'rendering-main', mainApp: page };
    harness.startupState.value = { kind: 'ready', mainApp: page };
    expect(harness.entry.modelSelection.value).toBe(presentation);
    harness.entry.closeModelSelection();
    expect(harness.entry.modelSelection.value?.phase).toBe('closing');
    harness.entry.finishModelSelectionClose();
    await harness.router.push('/?settings=connection');
    await harness.router.push('/');
    expect(harness.entry.modelSelection.value).toBeUndefined();
    await harness.entry.openHome();
    expect(harness.entry.modelSelection.value?.phase).toBe('open');
    expect(harness.router.currentRoute.value.path).toBe('/');
  });

  it.each([true, false])('uses saved history rather than global model setup for the initial dialog (empty=%s)', async empty => {
    using owner = await createEntryHarness({ path: '/', startupKind: 'initializing-foundation' });
    owner.settings.value = { endpoint: { type: 'llama_cpp_browser' }, defaultModelId: 'configured' };
    owner.entry.initializeHomePresentation({ empty });
    owner.startupState.value = { kind: 'starting-main' };
    expect(owner.entry.modelSelection.value?.phase).toBe(empty ? 'open' : undefined);
    expect(owner.entry.automaticActivity.value).toBe(empty ? 'deferred' : 'ordinary');
    expect(owner.resume).toHaveBeenCalledTimes(empty ? 0 : 1);
    if (empty) {
      owner.entry.closeModelSelection();
      owner.entry.finishModelSelectionClose();
      expect(owner.resume).not.toHaveBeenCalled();
      await owner.router.push('/chat/created');
      expect(owner.resume).toHaveBeenCalledOnce();
    }
  });

  it.each(['/chat/missing', '/chat-group/missing', '/myunknown'])('owns a missing-target recovery across source unmount: %s', async path => {
    using owner = await createEntryHarness({ path: `${path}?q=must-not-send`, startupKind: 'ready' });
    let sourceMounted = true;
    const remove = owner.router.afterEach(route => {
      if (route.path === '/') {
        sourceMounted = false;
      }
    });
    using _guard = { [Symbol.dispose]: remove };
    await owner.entry.recoverNotFound({ isCurrent: () => sourceMounted });
    expect(sourceMounted).toBe(false);
    expect(owner.router.currentRoute.value.fullPath).toBe('/');
    expect(owner.entry.modelSelection.value?.phase).toBe('open');
    expect(owner.entry.notFoundRecovery.value).toBeUndefined();
    owner.entry.closeModelSelection();
    owner.entry.finishModelSelectionClose();
    owner.settings.value = { ...owner.settings.value };
    expect(owner.entry.modelSelection.value).toBeUndefined();
  });

  it('recovers a missing target without a dialog when saved history remains', async () => {
    using owner = await createEntryHarness({ path: '/chat/missing', startupKind: 'ready' });
    owner.readHistoryEmpty.mockResolvedValue(false);
    await owner.entry.recoverNotFound({ isCurrent: () => true });
    expect(owner.router.currentRoute.value.fullPath).toBe('/');
    expect(owner.entry.modelSelection.value).toBeUndefined();
  });

  it('retains the source route and releases recovery after a failed history read', async () => {
    using owner = await createEntryHarness({ path: '/chat/missing', startupKind: 'ready' });
    owner.readHistoryEmpty.mockRejectedValue(new Error('Permission lost'));
    await expect(owner.entry.recoverNotFound({ isCurrent: () => true })).rejects.toThrow('Permission lost');
    expect(owner.router.currentRoute.value.path).toBe('/chat/missing');
    expect(owner.entry.notFoundRecovery.value).toBeUndefined();
    expect(owner.entry.modelSelection.value).toBeUndefined();
  });

  it.each(['route', 'storage'] as const)('does not recover a delayed missing target after its %s changes', async changed => {
    using owner = await createEntryHarness({ path: '/chat/missing', startupKind: 'ready' });
    const pending = Promise.withResolvers<boolean>();
    owner.readHistoryEmpty.mockReturnValue(pending.promise);
    const recovering = owner.entry.recoverNotFound({ isCurrent: () => true });
    expect(owner.entry.notFoundRecovery.value).toBeDefined();
    switch (changed) {
    case 'route': await owner.router.push('/chat/newer');
      break;
    case 'storage': owner.retireStorage();
      break;
    default: {
      const exhaustive: never = changed;
      throw new Error(String(exhaustive));
    }
    }
    pending.resolve(true);
    await recovering;
    expect(owner.router.currentRoute.value.path).toBe(changed === 'route' ? '/chat/newer' : '/chat/missing');
    expect(owner.entry.modelSelection.value).toBeUndefined();
    expect(owner.entry.notFoundRecovery.value).toBeUndefined();
  });

  it('leaves a blocked recovery retryable and never reinterprets explicit model input as Not Found', async () => {
    using owner = await createEntryHarness({ path: '/myunknown', startupKind: 'ready' });
    const remove = owner.router.beforeEach(route => route.path === '/' ? false : true);
    using _guard = { [Symbol.dispose]: remove };
    await expect(owner.entry.recoverNotFound({ isCurrent: () => true })).rejects.toThrow('Could not recover');
    expect(owner.router.currentRoute.value.path).toBe('/myunknown');
    expect(owner.entry.notFoundRecovery.value).toBeUndefined();
    owner.readHistoryEmpty.mockClear();
    await owner.router.push('/myunknown?llama-cpp-browser-model=');
    await owner.entry.recoverNotFound({ isCurrent: () => true });
    expect(owner.readHistoryEmpty).not.toHaveBeenCalled();
    expect(owner.router.currentRoute.value.fullPath).toBe('/myunknown?llama-cpp-browser-model=');
  });

  it('does not reopen a stale recovery dialog after a newer navigation leaves and returns to the root', async () => {
    using owner = await createEntryHarness({ path: '/myunknown', startupKind: 'ready' });
    const replace = owner.router.replace.bind(owner.router);
    using _replace = vi.spyOn(owner.router, 'replace').mockImplementationOnce(async location => {
      const result = await replace(location);
      await owner.router.push('/chat/newer');
      await owner.router.push('/');
      return result;
    });
    await owner.entry.recoverNotFound({ isCurrent: () => true });
    expect(owner.router.currentRoute.value.fullPath).toBe('/');
    expect(owner.entry.modelSelection.value).toBeUndefined();
    expect(owner.entry.notFoundRecovery.value).toBeUndefined();
  });

  it('restores the modal opener only after the background DOM can leave its inert state', async () => {
    using harness = await createEntryHarness({ path: '/', startupKind: 'ready' });
    const background = document.createElement('div');
    background.setAttribute('inert', '');
    const opener = document.createElement('button');
    background.append(opener);
    document.body.append(background);
    using _background = {
      [Symbol.dispose]() {
        background.remove();
      },
    };
    const focus = vi.spyOn(opener, 'focus');
    harness.entry.openModelSelection({ target: { kind: 'home' }, selection: harness.entry.homeSelection.value, opener });
    harness.entry.closeModelSelection();
    harness.entry.finishModelSelectionClose();
    expect(focus).not.toHaveBeenCalled();
    background.removeAttribute('inert');
    await flushPromises();
    expect(focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true });
  });

  it('retires the model-link owner when leaving for an unconfigured ordinary root', async () => {
    using harness = await createEntryHarness({ path: '/?llama-cpp-browser-model=owner/model', startupKind: 'ready' });
    const context = harness.entry.captureModelLaunchContext();
    expect(harness.entry.intent.value.kind).toBe('model-preview');
    expect(harness.captureDefaults).not.toHaveBeenCalled();
    await harness.router.push('/');
    expect(harness.entry.intent.value.kind).toBe('home');
    expect(context.isCurrent()).toBe(false);
    expect(harness.entry.captureModelLaunchContext().owner).not.toBe(context.owner);
    expect(harness.captureDefaults).not.toHaveBeenCalled();
  });

  it.each(['/chat/saved', '/chat/unrelated', '/chat/missing'])('opens %s directly without making entry presentation depend on chat model metadata', async path => {
    using harness = await createEntryHarness({ path, startupKind: 'ready' });
    expect(harness.entry.intent.value.kind).toBe('ordinary');
    expect(harness.entry.interaction.value).toBe('ready');
    expect(harness.entry.captureModelLaunchContext().routePath).toBe(path);
    expect(harness.entry.captureModelLaunchContext().homeOriginId).toBeUndefined();
    expect(harness.router.currentRoute.value.path).toBe(path);
    expect(harness.captureDefaults).not.toHaveBeenCalled();
  });

  it.each(['/', '/settings/connection'])('recognizes a formal model URL before initial navigation completes at %s', async path => {
    const page = defineComponent({ template: '<div />' });
    const history = createMemoryHistory();
    history.replace(`${path}?llama-cpp-browser-model=owner/model`);
    const router = createRouter({ history, routes: [{ path: '/:pathMatch(.*)*', component: page }] });
    const guard = Promise.withResolvers<boolean>();
    router.beforeEach(() => guard.promise);
    const navigation = router.push(history.location);
    const scope = effectScope();
    await using _cleanup = {
      async [Symbol.asyncDispose]() {
        guard.resolve(true);
        await navigation;
        scope.stop();
      },
    };
    const captureDefaults = vi.fn(() => Promise.resolve(undefined));
    const entry = scope.run(() => TEST_ONLY.createAppEntry({
      router,
      startupState: shallowRef<StartupState>({ kind: 'initializing-foundation' }),
      settingsInitialized: ref(true),
      settings: ref<Pick<Settings, 'endpoint' | 'defaultModelId'>>({ endpoint: { type: 'openai', url: '' }, defaultModelId: undefined }),
      captureStorage: () => () => true,
      captureModelLaunchDefaults: captureDefaults,
      readHistoryEmpty: async () => true,
      deferModelRefresh: vi.fn(),
      resumeModelRefresh: vi.fn(),
    }))!;
    expect(router.currentRoute.value).toBe(START_LOCATION);
    expect(entry.intent.value.kind).toBe('model-preview');
    expect(entry.captureModelLaunchContext().routePath).toBe(path);
    expect(entry.interaction.value).toBe('blocked');
    expect(await entry.captureModelLaunchStartContext().defaults).toBeUndefined();
    expect(captureDefaults).not.toHaveBeenCalled();
    guard.resolve(true);
    await navigation;
    expect(entry.intent.value.kind).toBe('model-preview');
  });

  it('captures default initialization authority at the explicit Start action before a lazy runtime arrives', async () => {
    using harness = await createEntryHarness({ path: '/', startupKind: 'ready' });
    harness.settings.value = { endpoint: { type: 'openai', url: 'https://original.example' }, defaultModelId: 'original-model' };
    harness.entry.captureModelLaunchContext();
    expect(harness.captureDefaults).not.toHaveBeenCalled();
    const context = harness.entry.captureModelLaunchStartContext();
    expect(harness.captureDefaults).toHaveBeenCalledOnce();
    harness.settings.value = { endpoint: { type: 'ollama', url: 'http://localhost:11434' }, defaultModelId: 'other-model' };
    harness.settings.value = { endpoint: { type: 'openai', url: '' }, defaultModelId: undefined };
    const snapshot = await context.defaults;
    expect(snapshot?.endpoint).toEqual({ type: 'openai', url: 'https://original.example' });
    expect(snapshot?.modelId).toBe('original-model');
    expect(harness.captureDefaults).toHaveBeenCalledOnce();
    harness.retireStorage();
    expect(snapshot?.isStorageCurrent()).toBe(false);
  });

  it('does not acquire default initialization authority before ready', async () => {
    using harness = await createEntryHarness({ path: '/', startupKind: 'initializing-foundation' });
    const context = harness.entry.captureModelLaunchStartContext();
    expect(await context.defaults).toBeUndefined();
    expect(context.isCurrent()).toBe(false);
    expect(harness.captureDefaults).not.toHaveBeenCalled();
  });

  it('keeps the root home routing only after the initial global query has been applied', async () => {
    using harness = await createEntryHarness({ path: '/?global-endpoint-type=ollama&global-endpoint-url=http%3A%2F%2Flocalhost%3A11434&global-model=chosen', startupKind: 'initializing-foundation' });
    expect(harness.entry.intent.value.kind).toBe('pending');
    expect(harness.resume).not.toHaveBeenCalled();
    harness.settings.value = { endpoint: { type: 'ollama', url: 'http://localhost:11434' }, defaultModelId: 'chosen' };
    expect(harness.entry.intent.value.kind).toBe('pending');
    expect(harness.resume).not.toHaveBeenCalled();
    harness.startupState.value = { kind: 'starting-main' };
    expect(harness.entry.intent.value.kind).toBe('home');
    expect(harness.entry.modelSelection.value).toBeUndefined();
    expect(harness.entry.automaticActivity.value).toBe('ordinary');
    expect(harness.resume).toHaveBeenCalledOnce();
  });

  it('keeps a formal model preview isolated across the initial query boundary', async () => {
    using harness = await createEntryHarness({ path: '/?llama-cpp-browser-model=owner/repo&global-endpoint-type=ollama&global-endpoint-url=http%3A%2F%2Flocalhost%3A11434&global-model=ignored', startupKind: 'initializing-foundation' });
    const context = harness.entry.captureModelLaunchContext();
    expect(harness.entry.intent.value.kind).toBe('model-preview');
    harness.startupState.value = { kind: 'starting-main' };
    expect(harness.entry.intent.value.kind).toBe('model-preview');
    expect(context.isCurrent()).toBe(true);
    expect(harness.entry.automaticActivity.value).toBe('deferred');
    expect(harness.resume).not.toHaveBeenCalled();
  });

  it('keeps the same home owner while a drop initializes the global temporary model', async () => {
    using harness = await createEntryHarness({ path: '/', startupKind: 'ready' });
    const context = harness.entry.captureModelLaunchContext();
    harness.settings.value = { endpoint: { type: 'llama_cpp_browser' }, defaultModelId: 'temp/actual-model' };
    expect(harness.entry.intent.value.kind).toBe('home');
    expect(context.isCurrent()).toBe(true);
    expect(harness.entry.automaticActivity.value).toBe('deferred');
    expect(harness.resume).not.toHaveBeenCalled();
  });

  it('continues an owned chat handoff without enabling unrelated automatic connections', async () => {
    using harness = await createEntryHarness({ path: '/', startupKind: 'ready' });
    const context = harness.entry.captureModelLaunchContext();
    expect(harness.entry.prepareModelLaunchHandoff({ owner: context.owner, chatPath: '/chat/created' })).toBe(true);
    await harness.router.push('/chat/created');
    expect(context.isCurrent()).toBe(true);
    expect(harness.entry.intent.value.kind).toBe('ordinary');
    expect(harness.entry.automaticActivity.value).toBe('deferred');
    await harness.router.push('/chat/other');
    expect(context.isCurrent()).toBe(false);
    expect(harness.resume).toHaveBeenCalledOnce();
  });

  it('restores an origin on Back and gives an explicit home visit a new origin', async () => {
    using harness = await createEntryHarness({ path: '/', startupKind: 'ready' });
    const context = harness.entry.captureModelLaunchContext();
    harness.entry.homeSelection.value = { suggestionId: 'gpt-oss-20b', quantizationId: 'mxfp4' };
    harness.entry.prepareModelLaunchHandoff({ owner: context.owner, chatPath: '/chat/created' });
    await harness.router.push('/chat/created');
    harness.router.back();
    await flushPromises();
    expect(harness.entry.captureModelLaunchContext().homeOriginId).toBe(context.homeOriginId);
    expect(harness.entry.homeSelection.value.suggestionId).toBe('gpt-oss-20b');
    await harness.entry.openHome();
    expect(harness.entry.captureModelLaunchContext().homeOriginId).not.toBe(context.homeOriginId);
  });

  it('restores the original root home after its own launch initializes global defaults', async () => {
    using harness = await createEntryHarness({ path: '/', startupKind: 'ready' });
    const context = harness.entry.captureModelLaunchContext();
    harness.entry.homeSelection.value = { suggestionId: 'gpt-oss-20b', quantizationId: 'mxfp4' };
    harness.entry.prepareModelLaunchHandoff({ owner: context.owner, chatPath: '/chat/created' });
    await harness.router.push('/chat/created');
    harness.settings.value = { endpoint: { type: 'llama_cpp_browser' }, defaultModelId: 'actual-saved-model' };
    harness.router.back();
    await flushPromises();
    expect(harness.router.currentRoute.value.path).toBe('/');
    expect(harness.entry.intent.value.kind).toBe('home');
    expect(harness.entry.captureModelLaunchContext().homeOriginId).toBe(context.homeOriginId);
    expect(harness.entry.homeSelection.value.suggestionId).toBe('gpt-oss-20b');
    expect(harness.entry.automaticActivity.value).toBe('ordinary');
    expect(harness.resume).toHaveBeenCalledOnce();
  });

  it('opens explicit model settings without consuming query or changing the URL', async () => {
    using harness = await createEntryHarness({ path: '/settings/connection?llama-cpp-browser-model=owner/repo&settings=storage&q=ignored', startupKind: 'ready' });
    const url = harness.router.currentRoute.value.fullPath;
    expect(harness.entry.settingsOverlay.value).toBeUndefined();
    const opener = document.createElement('button');
    document.body.append(opener);
    using _opener = {
      [Symbol.dispose]() {
        opener.remove();
      },
    };
    harness.entry.openSettings({ tab: 'llama_cpp_browser', opener });
    expect(harness.entry.settingsOverlay.value?.tab).toBe('llama_cpp_browser');
    expect(harness.router.currentRoute.value.fullPath).toBe(url);
    harness.entry.closeSettings();
    await flushPromises();
    expect(harness.entry.settingsOverlay.value).toBeUndefined();
    expect(document.activeElement).toBe(opener);
  });

  it('retires commands and captures when storage changes without changing the route', async () => {
    using harness = await createEntryHarness({ path: '/home?llama-cpp-browser-model=owner/repo', startupKind: 'ready' });
    const context = harness.entry.captureModelLaunchContext();
    harness.entry.openSettings({ tab: 'connection', opener: undefined });
    harness.retireStorage();
    expect(context.isCurrent()).toBe(false);
    expect(harness.entry.intent.value.kind).toBe('model-preview');
    expect(harness.entry.captureModelLaunchContext().owner).not.toBe(context.owner);
    expect(harness.entry.automaticActivity.value).toBe('deferred');
    expect(harness.entry.settingsOverlay.value).toBeUndefined();
    expect(harness.entry.prepareModelLaunchHandoff({ owner: context.owner, chatPath: '/chat/old' })).toBe(false);
  });

  it('uses the ordinary settings query outside model preview', async () => {
    using harness = await createEntryHarness({ path: '/chat/existing', startupKind: 'ready' });
    harness.entry.openSettings({ tab: 'llama_cpp_browser', opener: undefined });
    await flushPromises();
    expect(harness.router.currentRoute.value.query.settings).toBe('llama-cpp-browser');
  });

  it('blocks early controls until the existing ready state and has a passive fallback', async () => {
    using harness = await createEntryHarness({ path: '/', startupKind: 'ready' });
    harness.startupState.value = { kind: 'starting-main' };
    await harness.entry.openHome();
    harness.entry.openSettings({ tab: 'connection', opener: undefined });
    expect(harness.entry.interaction.value).toBe('blocked');
    expect(harness.entry.settingsOverlay.value).toBeUndefined();
    const fallback = useAppEntry();
    expect(fallback.intent.value.kind).toBe('ordinary');
    expect(fallback.interaction.value).toBe('blocked');
  });
});
