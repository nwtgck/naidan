import { computed, hasInjectionContext, inject, nextTick, onScopeDispose, provide, ref, shallowRef, watch, type InjectionKey, type Ref, type ShallowRef } from 'vue';
import { routerKey, START_LOCATION, type LocationQuery, type Router } from 'vue-router';
import { nanoid } from 'nanoid';
import { z } from 'zod';
import type { Settings } from '@/01-models/types';
import type { SettingsNavigationTab } from '@/components/settings-navigation';
import { useSettings } from '@/composables/useSettings';
import { MODEL_ENTRY_QUERY, resolveAppEntryKind } from '@/logic/startup/entry-intent';
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
export type ModelLaunchStartContext = ModelLaunchAppContext & Readonly<{ defaults: Promise<ModelLaunchDefaultSnapshot | undefined> }>;
export type AppEntrySettingsOverlay = { owner: symbol, tab: SettingsNavigationTab, opener: HTMLElement | undefined };

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

function createAppEntry({ router, startupState, settingsInitialized, settings, captureStorage, captureModelLaunchDefaults, deferModelRefresh, resumeModelRefresh }: {
  router: Router | undefined,
  startupState: ShallowRef<StartupState>,
  settingsInitialized: Readonly<Ref<boolean>>,
  settings: Readonly<Ref<Pick<Settings, 'endpoint' | 'defaultModelId'>>>,
  captureStorage: () => () => boolean,
  captureModelLaunchDefaults: () => Promise<ModelLaunchDefaultSnapshot | undefined>,
  deferModelRefresh: () => void,
  resumeModelRefresh: () => void,
}) {
  const intentState = shallowRef<AppEntryIntent>(router === undefined
    ? { kind: 'ordinary', owner: Symbol('inactive-entry'), homeOriginId: undefined, routePath: '', fullPath: '', input: undefined }
    : { kind: 'pending' });
  const homeSelection = ref<AppEntrySelection>({ suggestionId: 'gemma-4-e2b', quantizationId: 'qat-q4_0' });
  const previewVariantSelection = ref<AppEntryPreviewVariant>({ kind: 'initial' });
  const settingsOverlay = shallowRef<AppEntrySettingsOverlay>();
  const discovery = shallowRef<{ owner: symbol, tab: AppEntryDiscoveryTab }>();
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
    if (!storageChanged && revision === routeRevision && prior !== undefined
      && (!settingsInitialized.value || storageInitialized)) {
      if (prior.kind === 'home' && prior.homeOriginId !== undefined
        && router?.options.history.state[originHistoryKey] !== prior.homeOriginId) {
        router?.options.history.replace(router.options.history.location, { ...router.options.history.state, [originHistoryKey]: prior.homeOriginId });
      }
      return;
    }
    const savedOrigin = homeOriginSchema.safeParse(router?.options.history.state[originHistoryKey]);
    const restoresRootHome = !storageChanged && route.path === '/' && route.query[MODEL_ENTRY_QUERY] === undefined
      && route.query.q === undefined && route.query.settings === undefined
      && savedOrigin.success && selectionsByOrigin.has(savedOrigin.data);
    const kind = restoresRootHome ? 'home' : resolveAppEntryKind({ route, initialized: settingsInitialized.value && foundationResolved.value, settings: settings.value });
    switch (kind) {
    case 'pending':
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
    case 'home':
    case 'model-preview':
      automaticActivity.value = 'deferred';
      deferModelRefresh();
      break;
    case 'ordinary':
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
    case 'ready':
      return { ...context, defaults: context.isCurrent() ? captureModelLaunchDefaults().catch(() => undefined) : Promise.resolve(undefined) };
    case 'blocked':
      return { ...context, isCurrent: () => false, defaults: Promise.resolve(undefined) };
    default: {
      const _ex: never = phase;
      throw new Error(`Unhandled model launch capture interaction: ${String(_ex)}`);
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

  function openDiscovery({ tab }: { tab: AppEntryDiscoveryTab }): void {
    const current = activeEntryIntent({ intent: intentState.value });
    if (current !== undefined && interaction.value === 'ready') {
      discovery.value = { owner: current.owner, tab };
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
    await router.push({ path: '/home', query: {}, state: { [originHistoryKey]: forcedHomeOrigin } });
    syncIntent();
  }

  async function returnToHome({ homeOriginId }: { homeOriginId: string }): Promise<void> {
    if (router === undefined || interaction.value !== 'ready') {
      return;
    }
    forcedHomeOrigin = homeOriginId;
    routeRevision = '';
    await router.push({ path: '/home', query: {}, state: { [originHistoryKey]: homeOriginId } });
    syncIntent();
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
