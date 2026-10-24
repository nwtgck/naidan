import { computed, hasInjectionContext, inject, nextTick, onScopeDispose, provide, ref, shallowRef, watch, type InjectionKey, type Ref, type ShallowRef } from 'vue';
import { routerKey, START_LOCATION, type LocationQuery, type Router } from 'vue-router';
import { createModuleLoader } from '@/utils/module-loader';
import { ensureStrings } from '@/strings';
import { nanoid } from 'nanoid';
import { z } from 'zod';
import type { Settings } from '@/01-models/types';
import type { ChatId } from '@/01-models/ids';
import type { ModelLaunchTarget } from '@/01-models/llama-cpp-browser-model-launch';
import type { ModelDirectoryInput, LocalModel } from '@/features/llama-cpp-browser/types';
import type { SettingsNavigationTab } from '@/components/settings-navigation';
import { useSettings } from '@/composables/useSettings';
import { hasSelectedGlobalChatModel, MODEL_ENTRY_QUERY, resolveAppEntryKind } from '@/logic/startup/entry-intent';
import { resolveInitialRoute } from '@/logic/startup/startup-route';
import type { StartupState } from '@/logic/startup/types';
import type { ModelLaunchDefaultSnapshot } from '@/features/llama-cpp-browser/model-launch/defaults';
import { registerModelLaunchEntryContext } from '@/features/llama-cpp-browser/model-launch/entry-state';

export type AppEntryMode = 'home' | 'model-preview' | 'ordinary';
export type AppEntryInteraction = 'blocked' | 'ready';
export type AppEntryDiscoveryTab = 'candidates' | 'hugging-face' | 'local-files';
export type AppEntrySelection = { suggestionId: string, quantizationId: string | undefined };
export type AppEntryPreviewVariant = { kind: 'initial' } | { kind: 'selected', requestedVariant: string | undefined };
export type AppEntryIntent =
  | { kind: 'pending' }
  | { kind: AppEntryMode, owner: symbol, homeOriginId: string | undefined, routePath: string, fullPath: string, input: LocationQuery[typeof MODEL_ENTRY_QUERY] | undefined };
export type ModelLaunchAppContext = Readonly<{
  owner: symbol,
  homeOriginId: string | undefined,
  mode: AppEntryMode,
  fullPath: string,
  routePath: string,
  isCurrent(): boolean,
}>;
export type ModelLaunchStartContext = ModelLaunchAppContext & Readonly<{ defaults: Promise<ModelLaunchDefaultSnapshot | undefined>, applyTarget?: ({ target }: { target: ModelLaunchTarget }) => void }>;
export type AppEntrySettingsOverlay = { owner: symbol, tab: SettingsNavigationTab, opener: HTMLElement | undefined };
export type ModelSelectionTarget =
  | { kind: 'home' }
  | { kind: 'chat', chatId: ChatId, acceptFiles({ directories, controller }: { directories: Promise<ModelDirectoryInput[]>, controller: AbortController }): void, useRepositoryModel({ target }: { target: ModelLaunchTarget }): void, useModel({ model }: { model: LocalModel }): void };
export type ModelSelectionPresentation = { phase: 'open' | 'closing', owner: symbol, target: ModelSelectionTarget, selection: AppEntrySelection, opener: HTMLElement | undefined };
type NotFoundRecovery = { sourcePath: string, location: 'source' | 'root' };

// Share the same fulfilled UI import with its async renderer. Requesting the
// panel must not suspend the current dialog before the new UI can be rendered.
const discoveryLoader = createModuleLoader({ importModule: () => import('@/components/ModelDiscoveryPanel.vue'), onPrefetchError: () => {} });

export function loadModelDiscoveryPanel() {
  return discoveryLoader.load();
}

const originHistoryKey = '_internalNaidanHomeOrigin';
const homeOriginSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);

function activeEntryIntent({ intent }: { intent: AppEntryIntent }): Exclude<AppEntryIntent, { kind: 'pending' }> | undefined {
  const kind = intent.kind;
  switch (kind) {
  case 'pending':
    return undefined;
  case 'home':
  case 'model-preview':
  case 'ordinary':
    return intent;
  default: {
    const _ex: never = kind;
    throw new Error(`Unhandled app entry: ${String(_ex)}`);
  }
  }
}

function createAppEntry({ router, startupState, settingsInitialized, settings, captureStorage, captureModelLaunchDefaults, readHistoryEmpty, deferModelRefresh, resumeModelRefresh }: {
  router: Router | undefined,
  startupState: ShallowRef<StartupState>,
  settingsInitialized: Readonly<Ref<boolean>>,
  settings: Readonly<Ref<Pick<Settings, 'endpoint' | 'defaultModelId'>>>,
  captureStorage: () => () => boolean,
  captureModelLaunchDefaults: () => Promise<ModelLaunchDefaultSnapshot | undefined>,
  readHistoryEmpty(): Promise<boolean>,
  deferModelRefresh: () => void,
  resumeModelRefresh: () => void,
}) {
  const intentState = shallowRef<AppEntryIntent>(router === undefined
    ? { kind: 'ordinary', owner: Symbol('inactive-entry'), homeOriginId: undefined, routePath: '', fullPath: '', input: undefined }
    : { kind: 'pending' });
  const homeSelection = ref<AppEntrySelection>({ suggestionId: 'gemma-4-e2b', quantizationId: 'qat-q4_0' });
  const previewVariantSelection = ref<AppEntryPreviewVariant>({ kind: 'initial' });
  const settingsOverlay = shallowRef<AppEntrySettingsOverlay>();
  const discovery = shallowRef<{ owner: symbol, tab: AppEntryDiscoveryTab | undefined }>();
  const modelSelection = shallowRef<ModelSelectionPresentation>();
  const notFoundRecovery = shallowRef<NotFoundRecovery>();
  let initialHomePresentation: 'pending' | 'show' | 'skip' = 'pending';
  const automaticActivity = ref<'deferred' | 'ordinary'>('deferred');
  let storageCurrent = () => router !== undefined;
  let storageInitialized = false;
  let ownHandoff: { owner: symbol, chatPath: string } | undefined;
  let forcedHomeOrigin: string | undefined;
  let routeRevision = '';
  const selectionsByOrigin = new Map<string, AppEntrySelection>();
  const effectiveRoute = computed(() => {
    if (router === undefined) {
      return undefined;
    }
    const state = startupState.value;
    switch (state.kind) {
    case 'ready':
      return router.currentRoute.value;
    case 'initializing-foundation':
    case 'starting-main':
    case 'rendering-main':
    case 'foundation-failed':
    case 'main-failed':
      return router.currentRoute.value === START_LOCATION ? resolveInitialRoute({ router }) : router.currentRoute.value;
    default: {
      const _ex: never = state;
      return _ex;
    }
    }
  });
  const foundationResolved = computed(() => {
    const state = startupState.value;
    switch (state.kind) {
    case 'initializing-foundation':
      return false;
    case 'starting-main':
    case 'rendering-main':
    case 'ready':
    case 'foundation-failed':
    case 'main-failed':
      return true;
    default: {
      const _ex: never = state;
      return _ex;
    }
    }
  });
  const interaction = computed<AppEntryInteraction>(() => {
    const state = startupState.value;
    switch (state.kind) {
    case 'ready':
      return settingsInitialized.value ? 'ready' : 'blocked';
    case 'initializing-foundation':
    case 'starting-main':
    case 'rendering-main':
    case 'foundation-failed':
    case 'main-failed':
      return 'blocked';
    default: {
      const _ex: never = state;
      return _ex;
    }
    }
  });

  function rememberHomeSelection({ intent }: { intent: ReturnType<typeof activeEntryIntent> }): void {
    if (intent === undefined) {
      return;
    }
    const kind = intent.kind;
    switch (kind) {
    case 'home':
      if (intent.homeOriginId !== undefined) {
        selectionsByOrigin.set(intent.homeOriginId, { ...homeSelection.value });
      }
      return;
    case 'model-preview':
    case 'ordinary':
      return;
    default: {
      const _ex: never = kind;
      throw new Error(`Unhandled home selection owner: ${String(_ex)}`);
    }
    }
  }

  function syncIntent(): void {
    const route = effectiveRoute.value;
    if (route === undefined) {
      return;
    }
    const prior = activeEntryIntent({ intent: intentState.value });
    const storageChanged = storageInitialized && !storageCurrent();
    const revision = route.fullPath;
    const recovery = notFoundRecovery.value;
    if (recovery !== undefined) {
      if (storageChanged || route.fullPath !== '/' && (recovery.location === 'root' || route.fullPath !== recovery.sourcePath)) {
        notFoundRecovery.value = undefined;
      } else if (route.fullPath === '/') {
        recovery.location = 'root';
      }
    }
    if (!storageChanged && revision === routeRevision && prior !== undefined
      && (!settingsInitialized.value || storageInitialized)) {
      if (prior.kind === 'home' && prior.homeOriginId !== undefined
        && router?.options.history.state[originHistoryKey] !== prior.homeOriginId) {
        router?.options.history.replace(router.options.history.location, { ...router.options.history.state, [originHistoryKey]: prior.homeOriginId });
      }
      return;
    }
    const savedOrigin = homeOriginSchema.safeParse(router?.options.history.state[originHistoryKey]);
    const kind = resolveAppEntryKind({ route, initialized: settingsInitialized.value && foundationResolved.value });
    switch (kind) {
    case 'pending':
      closeModelSelection();
      settingsOverlay.value = undefined;
      discovery.value = undefined;
      ownHandoff = undefined;
      intentState.value = { kind };
      return;
    case 'home':
    case 'model-preview':
    case 'ordinary':
      break;
    default: {
      const _ex: never = kind;
      throw new Error(`Unhandled resolved app entry: ${String(_ex)}`);
    }
    }
    const handoff = ownHandoff;
    if (!storageChanged && handoff !== undefined && prior !== undefined && handoff.owner === prior.owner
      && route.path === handoff.chatPath && kind === 'ordinary') {
      routeRevision = revision;
      intentState.value = { ...prior, kind: 'ordinary', routePath: route.path, fullPath: route.fullPath, input: undefined, owner: handoff.owner };
      ownHandoff = undefined;
      settingsOverlay.value = undefined;
      discovery.value = undefined;
      closeModelSelection();
      return;
    }
    ownHandoff = undefined;
    settingsOverlay.value = undefined;
    discovery.value = undefined;
    rememberHomeSelection({ intent: prior });
    if (storageChanged) {
      selectionsByOrigin.clear();
    }
    storageCurrent = settingsInitialized.value ? captureStorage() : () => true;
    storageInitialized = settingsInitialized.value;
    routeRevision = revision;
    let homeOriginId: string | undefined;
    switch (kind) {
    case 'home': {
      homeOriginId = forcedHomeOrigin ?? (!storageChanged && savedOrigin.success ? savedOrigin.data : nanoid());
      forcedHomeOrigin = undefined;
      router?.options.history.replace(router.options.history.location, { ...router.options.history.state, [originHistoryKey]: homeOriginId });
      const selected = selectionsByOrigin.get(homeOriginId);
      if (selected !== undefined) {
        homeSelection.value = { ...selected };
      }
      break;
    }
    case 'model-preview':
    case 'ordinary':
      break;
    default: {
      const _ex: never = kind;
      throw new Error(`Unhandled home origin: ${String(_ex)}`);
    }
    }
    previewVariantSelection.value = { kind: 'initial' };
    intentState.value = { kind, owner: Symbol('app-entry-owner'), homeOriginId, routePath: route.path, fullPath: route.fullPath, input: route.query[MODEL_ENTRY_QUERY] };
    switch (kind) {
    case 'home': {
      // Startup arms this once from the saved sidebar, before chat bootstrap.
      // Ordinary returns to the root must not replay a dismissed introduction.
      if (initialHomePresentation === 'show' && startupState.value.kind === 'starting-main') {
        initialHomePresentation = 'skip';
        openModelSelection({ target: { kind: 'home' }, selection: homeSelection.value, opener: undefined });
      } else {
        closeModelSelection();
      }
      // Even configured users can have empty history. Do not start provider
      // work ahead of the initial dialog's paint or a pending recovery.
      const resumeActivity = modelSelection.value === undefined && notFoundRecovery.value === undefined
        && hasSelectedGlobalChatModel({ settings: settings.value });
      automaticActivity.value = resumeActivity ? 'ordinary' : 'deferred';
      if (resumeActivity) {
        resumeModelRefresh();
      } else {
        deferModelRefresh();
      }
      break;
    }
    case 'model-preview':
      closeModelSelection();
      automaticActivity.value = 'deferred';
      deferModelRefresh();
      break;
    case 'ordinary':
      closeModelSelection();
      if (settingsInitialized.value) {
        automaticActivity.value = 'ordinary';
        resumeModelRefresh();
      }
      break;
    default: {
      const _ex: never = kind;
      throw new Error(`Unhandled automatic entry activity: ${String(_ex)}`);
    }
    }
  }

  watch([effectiveRoute, settingsInitialized, settings, startupState], syncIntent, { immediate: true, flush: 'sync' });

  function initializeHomePresentation({ empty }: { empty: boolean }): void {
    switch (initialHomePresentation) {
    case 'pending':
      initialHomePresentation = empty ? 'show' : 'skip';
      return;
    case 'show':
    case 'skip': return;
    default: {
      const exhaustive: never = initialHomePresentation;
      throw new Error(`Unhandled initial home presentation: ${String(exhaustive)}`);
    }
    }
  }

  async function recoverNotFound({ isCurrent }: { isCurrent(): boolean }): Promise<void> {
    const route = effectiveRoute.value;
    if (router === undefined || route === undefined || !isCurrent()
      || route.query[MODEL_ENTRY_QUERY] !== undefined) {
      return;
    }
    const recovery: NotFoundRecovery = { sourcePath: route.fullPath, location: 'source' };
    const isStorageCurrent = captureStorage();
    notFoundRecovery.value = recovery;
    const ownsRecovery = () => notFoundRecovery.value === recovery && isStorageCurrent();
    try {
      // Decide this presentation from one confirmed snapshot. Actual chat
      // creation independently rechecks the latest sidebar under its own lock.
      const empty = await readHistoryEmpty();
      if (!ownsRecovery() || !isCurrent()) {
        return;
      }
      const failure = await router.replace({ path: '/', query: {}, hash: '' });
      // A successful replacement unmounts the reporting page. From here the
      // shared recovery owns the transition, rather than that page's request.
      if (!ownsRecovery()) {
        return;
      }
      if (failure || router.currentRoute.value.fullPath !== '/') {
        throw new Error('Could not recover a missing page');
      }
      if (empty) {
        openModelSelection({ target: { kind: 'home' }, selection: homeSelection.value, opener: undefined });
      }
    } finally {
      if (notFoundRecovery.value === recovery) {
        notFoundRecovery.value = undefined;
      }
    }
  }

  function captureModelLaunchContext(): ModelLaunchAppContext {
    const current = activeEntryIntent({ intent: intentState.value });
    const owner = current?.owner ?? Symbol('pending-entry');
    const isStorageCurrent = storageCurrent;
    return {
      owner,
      homeOriginId: current?.homeOriginId,
      mode: current?.kind ?? 'ordinary',
      fullPath: current?.fullPath ?? '',
      routePath: current?.routePath ?? '',
      isCurrent: () => activeEntryIntent({ intent: intentState.value })?.owner === owner && isStorageCurrent(),
    };
  }

  function captureModelLaunchStartContext(): ModelLaunchStartContext {
    const context = captureModelLaunchContext();
    const phase = interaction.value;
    switch (phase) {
    case 'ready': {
      const selection = modelSelection.value;
      if (selection?.phase === 'open' && selection.target.kind === 'chat') {
        const target = selection.target;
        return {
          ...context,
          isCurrent: () => context.isCurrent() && modelSelection.value?.phase === 'open' && modelSelection.value.target === target,
          defaults: Promise.resolve(undefined),
          applyTarget: ({ target: model }) => {
            target.useRepositoryModel({ target: model });
            closeDiscovery();
            closeModelSelection();
          },
        };
      }
      return { ...context, defaults: context.isCurrent() ? captureModelLaunchDefaults().catch(() => undefined) : Promise.resolve(undefined) };
    }
    case 'blocked':
      return { ...context, isCurrent: () => false, defaults: Promise.resolve(undefined) };
    default: {
      const _ex: never = phase;
      throw new Error(`Unhandled model launch capture interaction: ${String(_ex)}`);
    }
    }
  }

  function openModelSelection({ target, selection, opener }: { target: ModelSelectionTarget, selection: AppEntrySelection, opener: HTMLElement | undefined }): void {
    const current = activeEntryIntent({ intent: intentState.value });
    if (current !== undefined) {
      modelSelection.value = { phase: 'open', owner: current.owner, target, selection: { ...selection }, opener };
    }
  }

  function selectModel({ selection }: { selection: AppEntrySelection }): void {
    const current = modelSelection.value;
    if (current?.phase !== 'open' || interaction.value !== 'ready') {
      return;
    }
    modelSelection.value = { ...current, selection };
    const target = current.target;
    switch (target.kind) {
    case 'home': homeSelection.value = selection;
      return;
    case 'chat': return;
    default: {
      const exhaustive: never = target;
      throw new Error(String(exhaustive));
    }
    }
  }

  function closeModelSelection(): void {
    const current = modelSelection.value;
    if (current === undefined) {
      return;
    }
    switch (current.phase) {
    case 'open': modelSelection.value = { ...current, phase: 'closing' };
      return;
    case 'closing': return;
    default: {
      const exhaustive: never = current.phase;
      throw new Error(String(exhaustive));
    }
    }
  }

  function finishModelSelectionClose(): void {
    const current = modelSelection.value;
    if (current === undefined) {
      return;
    }
    switch (current.phase) {
    case 'open': return;
    case 'closing':
      modelSelection.value = undefined;
      void nextTick(() => {
        if (modelSelection.value === undefined && current.opener?.isConnected && current.owner === activeEntryIntent({ intent: intentState.value })?.owner) {
          current.opener.focus({ preventScroll: true });
        }
      });
      return;
    default: {
      const exhaustive: never = current.phase;
      throw new Error(String(exhaustive));
    }
    }
  }

  function prepareModelLaunchHandoff({ owner, chatPath }: { owner: symbol, chatPath: string }): boolean {
    const current = activeEntryIntent({ intent: intentState.value });
    if (current === undefined || current.owner !== owner || !storageCurrent()) {
      return false;
    }
    rememberHomeSelection({ intent: current });
    ownHandoff = { owner, chatPath };
    return true;
  }

  function openSettings({ tab, opener }: { tab: SettingsNavigationTab, opener: HTMLElement | undefined }): void {
    const current = activeEntryIntent({ intent: intentState.value });
    if (current === undefined || interaction.value !== 'ready' || router === undefined) {
      return;
    }
    const kind = current.kind;
    switch (kind) {
    case 'model-preview':
      settingsOverlay.value = { owner: current.owner, tab, opener };
      return;
    case 'home':
    case 'ordinary':
      break;
    default: {
      const _ex: never = kind;
      throw new Error(`Unhandled settings entry: ${String(_ex)}`);
    }
    }
    const settingsTab = tab.replaceAll('_', '-');
    void router.push({ path: effectiveRoute.value?.path, query: { ...effectiveRoute.value?.query, settings: settingsTab } });
  }

  function closeSettings(): void {
    const command = settingsOverlay.value;
    settingsOverlay.value = undefined;
    if (command !== undefined) {
      void nextTick(() => {
        if (command.opener?.isConnected && activeEntryIntent({ intent: intentState.value })?.owner === command.owner) {
          command.opener.focus();
        }
      });
    }
  }

  async function openDiscovery({ tab }: { tab: AppEntryDiscoveryTab | undefined }): Promise<void> {
    const current = activeEntryIntent({ intent: intentState.value });
    if (current === undefined || interaction.value !== 'ready') {
      return;
    }
    const context = captureModelLaunchContext();
    const selection = modelSelection.value;
    const isCurrent = () => {
      if (!context.isCurrent() || interaction.value !== 'ready' || effectiveRoute.value?.fullPath !== context.fullPath) {
        return false;
      }
      if (selection === undefined) {
        return modelSelection.value === undefined;
      }
      const latest = modelSelection.value;
      if (latest === undefined || latest.target !== selection.target) {
        return false;
      }
      switch (latest.phase) {
      case 'open': return true;
      case 'closing': return false;
      default: {
        const exhaustive: never = latest.phase;
        throw new Error(String(exhaustive));
      }
      }
    };
    try {
      await loadModelDiscoveryPanel();
      if (isCurrent()) {
        discovery.value = { owner: current.owner, tab };
      }
    } catch {
      if (!isCurrent()) {
        return;
      }
      const { useToast } = await import('@/composables/useToast');
      const message = await ensureStrings.useAppEntry__could_not_open_model_browser();
      const actionLabel = await ensureStrings.LlamaCppBrowserModelLaunch__retry();
      if (isCurrent()) {
        useToast().addToast({ message, actionLabel, onAction: () => isCurrent() ? openDiscovery({ tab }) : undefined });
      }
    }
  }

  function closeDiscovery(): void {
    discovery.value = undefined;
  }

  async function openHome(): Promise<void> {
    if (router === undefined || interaction.value !== 'ready') {
      return;
    }
    forcedHomeOrigin = nanoid();
    routeRevision = '';
    await router.push({ path: '/', query: {}, state: { [originHistoryKey]: forcedHomeOrigin } });
    syncIntent();
    openModelSelection({ target: { kind: 'home' }, selection: homeSelection.value, opener: undefined });
  }

  async function returnToHome({ homeOriginId }: { homeOriginId: string }): Promise<void> {
    if (router === undefined || interaction.value !== 'ready') {
      return;
    }
    forcedHomeOrigin = homeOriginId;
    routeRevision = '';
    await router.push({ path: '/', query: {}, state: { [originHistoryKey]: homeOriginId } });
    syncIntent();
    openModelSelection({ target: { kind: 'home' }, selection: homeSelection.value, opener: undefined });
  }

  async function handoffToChat({ context, chatPath }: { context: ModelLaunchAppContext, chatPath: string }): Promise<boolean> {
    if (router === undefined || interaction.value !== 'ready' || !context.isCurrent()
      || !prepareModelLaunchHandoff({ owner: context.owner, chatPath })) {
      return false;
    }
    const location = { path: chatPath, query: {} };
    const failure = await (() => {
      const mode = context.mode;
      switch (mode) {
      case 'model-preview':
        return router.replace(location);
      case 'home':
      case 'ordinary':
        return router.push(location);
      default: {
        const _ex: never = mode;
        throw new Error(`Unhandled model launch navigation: ${String(_ex)}`);
      }
      }
    })();
    return !failure && context.isCurrent() && router.currentRoute.value.path === chatPath;
  }

  return {
    intent: computed(() => intentState.value),
    interaction,
    effectiveRoute,
    automaticActivity,
    homeSelection,
    previewVariantSelection,
    settingsOverlay,
    discovery,
    modelSelection: computed(() => modelSelection.value),
    notFoundRecovery: computed(() => notFoundRecovery.value),
    initializeHomePresentation,
    recoverNotFound,
    openModelSelection,
    closeModelSelection,
    finishModelSelectionClose,
    selectModel,
    captureModelLaunchContext,
    captureModelLaunchStartContext,
    prepareModelLaunchHandoff,
    openSettings,
    closeSettings,
    openDiscovery,
    closeDiscovery,
    openHome,
    returnToHome,
    handoffToChat,
  };
}

export type AppEntry = ReturnType<typeof createAppEntry>;
const appEntryKey: InjectionKey<AppEntry> = Symbol('app-entry');
let activeEntry: AppEntry | undefined;

export function provideAppEntry({ startupState }: { startupState: ShallowRef<StartupState> }): AppEntry {
  const settingsStore = useSettings();
  const entry = createAppEntry({
    router: inject(routerKey, undefined),
    startupState,
    settingsInitialized: settingsStore.initialized,
    settings: settingsStore.settings,
    captureStorage: () => settingsStore.captureExperimentalStorage(),
    captureModelLaunchDefaults: () => settingsStore.captureModelLaunchDefaults(),
    readHistoryEmpty: async () => {
      const { storageService } = await import('@/00-storage/service');
      return (await storageService.getSidebarStructure()).length === 0;
    },
    deferModelRefresh: () => settingsStore.deferModelRefresh(),
    resumeModelRefresh: () => settingsStore.resumeModelRefresh(),
  });
  const disposeLaunchContext = registerModelLaunchEntryContext({ capture: entry.captureModelLaunchStartContext });
  provide(appEntryKey, entry);
  activeEntry = entry;
  onScopeDispose(() => {
    disposeLaunchContext();
    if (activeEntry === entry) {
      activeEntry = undefined;
    }
  });
  return entry;
}

export function useAppEntry(): AppEntry {
  const provided = hasInjectionContext() ? inject(appEntryKey, undefined) : undefined;
  return provided ?? createAppEntry({
    router: undefined,
    startupState: shallowRef({ kind: 'initializing-foundation' }),
    settingsInitialized: ref(false),
    settings: ref<Pick<Settings, 'endpoint' | 'defaultModelId'>>({ endpoint: { type: 'openai', url: '' }, defaultModelId: undefined }),
    captureStorage: () => () => false,
    captureModelLaunchDefaults: () => Promise.resolve(undefined),
    readHistoryEmpty: async () => false,
    deferModelRefresh: () => {},
    resumeModelRefresh: () => {},
  });
}

export function requestAppSettings({ tab, opener }: { tab: SettingsNavigationTab, opener: HTMLElement | undefined }): void {
  activeEntry?.openSettings({ tab, opener });
}

export function getActiveAppEntry(): AppEntry | undefined {
  return activeEntry;
}

export async function handoffAppEntryToChat({ context, chatPath }: { context: ModelLaunchAppContext, chatPath: string }): Promise<boolean> {
  return activeEntry === undefined ? false : activeEntry.handoffToChat({ context, chatPath });
}

export const TEST_ONLY = {
  createAppEntry,
  originHistoryKey,
};
