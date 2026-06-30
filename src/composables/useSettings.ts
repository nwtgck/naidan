import { ref, readonly, computed, type ComputedRef, type Ref } from 'vue';
import {
  ensureStrings,
  prepareLocale,
  resolveBrowserLocale,
  setLocale as setStringLocale,
} from '@/strings';
import {
  type Settings,
  type Endpoint,
  type EndpointType,
  DEFAULT_SETTINGS,
  type StorageType,
  type ProviderProfile,
  type UiLocale,
} from '@/01-models/types';
import { storageService } from '@/00-storage/service';
import { checkOPFSSupport } from '@/utils/opfs-detection';
import { STORAGE_BOOTSTRAP_KEY } from '@/constants';
import { createLmProvider } from '@/features/lm/providerFactory';
import { preloadFakeLmLanguagePacks, type FakeLmDebugModeStatus } from '@/features/fake-lm';
import { transformersJsService } from '@/features/transformers-js';
import {
  parseBootstrapStorageTypeOverride,
  readStoredBootstrapStorageType,
} from '@/00-storage/service/bootstrap-storage-type';
import { useGlobalEvents } from './useGlobalEvents';
import { useConfirm } from './useConfirm';
import { areEndpointsEqual, cloneEndpoint, isHttpEndpoint } from '@/01-models/endpoint';

const _settings = ref<Settings>({
  ...DEFAULT_SETTINGS,
  storageType: 'local',
  endpoint: { type: 'openai', url: '' },
} as Settings);

const _initialized = ref(false);
const _isOnboardingDismissed = ref(false);
const _onboardingDraft = ref<{ url: string, type: EndpointType, headers?: [string, string][], models: string[], selectedModel: string } | null>(null);
const availableModels = ref<string[]>([]);
const isFetchingModels = ref(false);
let nextModelFetchRequestId = 0;
let latestModelFetchRequestId = 0;
let activeModelFetchCount = 0;

type GlobalSearchSettings = NonNullable<NonNullable<Settings['experimental']>['globalSearch']>;
export type SearchPreviewMode = NonNullable<GlobalSearchSettings['previewMode']>;
export type SearchContextSize = NonNullable<GlobalSearchSettings['previewContextSize']>;
type GlobalSearchScopeSetting = NonNullable<GlobalSearchSettings['scope']>;
type GlobalSearchRoleFilterSetting = NonNullable<GlobalSearchSettings['roleFilter']>;

const globalSearchScope = computed<GlobalSearchScopeSetting>(() => (
  _settings.value.experimental?.globalSearch?.scope ?? 'title_only'
));
const globalSearchRoleFilter = computed<GlobalSearchRoleFilterSetting>(() => (
  _settings.value.experimental?.globalSearch?.roleFilter ?? 'all'
));
const searchPreviewMode = computed<SearchPreviewMode>(() => (
  _settings.value.experimental?.globalSearch?.previewMode ?? 'always'
));
const searchContextSize = computed<SearchContextSize>(() => (
  _settings.value.experimental?.globalSearch?.previewContextSize ?? 2
));

interface UseSettingsApi {
  settings: Readonly<Ref<Settings>>,
  initialized: Readonly<Ref<boolean>>,
  isOnboardingDismissed: ComputedRef<boolean>,
  onboardingDraft: Readonly<Ref<{ url: string, type: EndpointType, headers?: [string, string][], models: string[], selectedModel: string } | null>>,
  availableModels: Readonly<Ref<string[]>>,
  isFetchingModels: Readonly<Ref<boolean>>,
  globalSearchScope: ComputedRef<GlobalSearchScopeSetting>,
  globalSearchRoleFilter: ComputedRef<GlobalSearchRoleFilterSetting>,
  searchPreviewMode: ComputedRef<SearchPreviewMode>,
  searchContextSize: ComputedRef<SearchContextSize>,
  init: ({ storageTypeOverride, dataZipBase64 }: { storageTypeOverride: string | undefined, dataZipBase64: string | undefined }) => Promise<void>,
  save: ({ patch, modelRefresh }: {
    patch: Partial<Settings>,
    modelRefresh: 'await' | 'background',
  }) => Promise<void>,
  updateExperimental: ({ updater }: {
    updater: ({ experimental }: { experimental: Settings['experimental'] }) => Settings['experimental'],
  }) => Promise<void>,
  fetchModels: ({ overrides }: { overrides?: Endpoint }) => Promise<string[]>,
  updateProviderProfiles: ({ profiles }: { profiles: ProviderProfile[] }) => Promise<void>,
  updateGlobalModel: ({ modelId }: { modelId: string }) => Promise<void>,
  updateGlobalEndpoint: ({ endpoint }: { endpoint: Endpoint }) => Promise<void>,
  updateSystemPrompt: ({ prompt }: { prompt: string }) => Promise<void>,
  updateStorageType: ({ type }: { type: StorageType }) => Promise<void>,
  setIsOnboardingDismissed: ({ dismissed }: { dismissed: boolean }) => void,
  setOnboardingDraft: ({ draft }: { draft: { url: string, type: EndpointType, headers?: [string, string][], models: string[], selectedModel: string } | null }) => void,
  setHeavyContentAlertDismissed: ({ dismissed }: { dismissed: boolean }) => void,
  setFakeLmDebugModeStatus: ({ status }: { status: FakeLmDebugModeStatus }) => Promise<void>,
  setLocale: ({ locale }: { locale: UiLocale }) => Promise<void>,
  setGlobalSearchScope: ({ scope }: { scope: GlobalSearchScopeSetting }) => Promise<void>,
  setGlobalSearchRoleFilter: ({ roleFilter }: { roleFilter: GlobalSearchRoleFilterSetting }) => Promise<void>,
  setSearchPreviewMode: ({ mode }: { mode: SearchPreviewMode }) => Promise<void>,
  setSearchContextSize: ({ size }: { size: SearchContextSize }) => Promise<void>,
  TEST_ONLY: {
    __testOnlyReset: () => void,
    __testOnlySetSettings: ({ newSettings }: { newSettings: Settings }) => void,
  },
}

let initPromise: Promise<void> | null = null;
let localeChangeQueue: Promise<void> = Promise.resolve();

// --- Synchronization ---

storageService.subscribeToChanges({ listener: async ({ event }) => {
  if (event.type === 'settings' || event.type === 'migration') {
    try {
      const fresh = await storageService.loadSettings();
      if (fresh) {
        _settings.value = fresh;
        preloadFakeLmIfEnabled({ status: fresh.experimental?.fakeLm ?? 'disabled' });
        await setStringLocale({
          locale: fresh.experimental?.locale ?? resolveBrowserLocale(),
        });
      }
    } catch (error) {
      console.error('Failed to synchronize settings:', error);
    }
  }
} });

transformersJsService.subscribeModelList({ listener: async () => {
  const type = _settings.value.endpoint.type;
  switch (type) {
  case 'transformers_js': {
    const { fetchModels } = useSettings();
    try {
      await fetchModels({});
    } catch {
      // fetchModels records the relevant error. Subscription callbacks must not
      // create unhandled promise rejections when a background refresh fails.
    }
    break;
  }
  case 'openai':
  case 'ollama':
    break;
  default: {
    const _ex: never = type;
    throw new Error(`Unhandled endpoint type: ${_ex}`);
  }
  }
} });

function preloadFakeLmIfEnabled({ status }: {
  status: FakeLmDebugModeStatus,
}): void {
  switch (status) {
  case 'enabled':
    preloadFakeLmLanguagePacks();
    break;
  case 'disabled':
    break;
  default: {
    const _ex: never = status;
    throw new Error(`Unhandled fake LM debug mode status: ${_ex}`);
  }
  }
}

export function useSettings(): UseSettingsApi {
  const loading = ref(false);

  const isOnboardingDismissed = computed(() => {
    const endpoint = _settings.value.endpoint;
    const hasEndpoint = endpoint.type === 'transformers_js' || endpoint.url !== '';
    const hasModel = !!_settings.value.defaultModelId;
    return _isOnboardingDismissed.value || (hasEndpoint && hasModel);
  });

  async function init({ storageTypeOverride, dataZipBase64 }: { storageTypeOverride: string | undefined, dataZipBase64: string | undefined }) {
    if (_initialized.value) return;
    if (initPromise) return initPromise;
    console.log("storageTypeOverride", storageTypeOverride);

    initPromise = (async () => {
      loading.value = true;
      try {
        // Determine storage type from persisted flag
        const {
          rawSavedStorageType,
          parsedSavedStorageType,
        } = readStoredBootstrapStorageType();
        let bootstrapType: 'local' | 'opfs' | 'memory' | null = (() => {
          switch (parsedSavedStorageType.status) {
          case 'valid':
            return parsedSavedStorageType.savedStorageType;
          case 'invalid':
          case 'missing':
            return null;
          default: {
            const _ex: never = parsedSavedStorageType;
            throw new Error(`Unhandled stored bootstrap storage type status: ${((_ex satisfies never) as { readonly status: string }).status}`);
          }
          }
        })();

        if (storageTypeOverride) {
          if (rawSavedStorageType !== null) {
            if (storageTypeOverride !== rawSavedStorageType) {
              const { addInfoEvent } = useGlobalEvents();
              addInfoEvent({
                source: 'SettingsService',
                message: await ensureStrings.useSettings__storage_type_is_already_set_and_requested_type_was_ignored({
                  savedStorageType: rawSavedStorageType,
                  requestedStorageType: storageTypeOverride,
                }),
              });

              const { showConfirm } = useConfirm();
              // Do not await to avoid blocking initialization/mount
              showConfirm({
                title: await ensureStrings.useSettings__storage_already_initialized(),
                message: await ensureStrings.useSettings__request_to_use_storage_type_was_ignored({
                  savedStorageType: rawSavedStorageType,
                  requestedStorageType: storageTypeOverride,
                }),
                confirmButtonText: await ensureStrings.useSettings__ok(),
              });
            }
          } else {
            const parsedOverrideStorageType = parseBootstrapStorageTypeOverride({
              rawStorageType: storageTypeOverride,
            });
            switch (parsedOverrideStorageType.status) {
            case 'valid':
              bootstrapType = parsedOverrideStorageType.savedStorageType;
              break;
            case 'invalid':
              console.warn(`Invalid storage-type override: "${storageTypeOverride}". Ignoring.`);
              break;
            default: {
              const _ex: never = parsedOverrideStorageType;
              throw new Error(`Unhandled bootstrap storage type override status: ${((_ex satisfies never) as { readonly status: string }).status}`);
            }
            }
          }
        }

        if (rawSavedStorageType !== null && parsedSavedStorageType.status === 'invalid') {
          console.warn(`Invalid storage type found in localStorage: "${rawSavedStorageType}". Falling back to detection.`, parsedSavedStorageType.savedStorageTypeValidationError);
          const { addErrorEvent } = useGlobalEvents();
          addErrorEvent({
            source: 'SettingsService',
            message: await ensureStrings.useSettings__invalid_storage_type_falling_back_to_default_detection(),
            details: parsedSavedStorageType.savedStorageTypeValidationError,
          });
        }

        if (rawSavedStorageType === null && bootstrapType && typeof localStorage !== 'undefined') {
          localStorage.setItem(STORAGE_BOOTSTRAP_KEY, bootstrapType);
        }

        if (!bootstrapType) {
          // First run or cleared state: detect best available storage
          const isSupported = await checkOPFSSupport();
          bootstrapType = isSupported ? 'opfs' : 'local';

          if (typeof localStorage !== 'undefined') {
            localStorage.setItem(STORAGE_BOOTSTRAP_KEY, bootstrapType);
          }
        }

        // Sync local settings ref with determined storage type
        _settings.value.storageType = bootstrapType;

        await storageService.init({ type: bootstrapType });

        // Handle URL-based data import BEFORE loading existing settings to ensure append mode works correctly
        if (dataZipBase64) {
          try {
            const { urlImportExportLogic } = await import('@/features/import-export/url-logic');
            await urlImportExportLogic.importFromBase64({ zipBase64: dataZipBase64 });
            // Clear local reference to large data to help GC
            dataZipBase64 = undefined;
            const { addInfoEvent } = useGlobalEvents();
            addInfoEvent({
              source: 'SettingsService',
              message: await ensureStrings.useSettings__data_successfully_imported_from_url(),
            });
          } catch (err) {
            console.error('Failed to import data from URL:', err);
            const { addErrorEvent } = useGlobalEvents();
            addErrorEvent({
              source: 'SettingsService',
              message: await ensureStrings.useSettings__failed_to_import_data_from_url(),
              details: err instanceof Error ? err : String(err),
            });
          }
        }

        const s = await storageService.loadSettings();
        if (s) {
          _settings.value = s;
          preloadFakeLmIfEnabled({ status: s.experimental?.fakeLm ?? 'disabled' });
          await setStringLocale({
            locale: s.experimental?.locale ?? resolveBrowserLocale(),
          });
          if (s.endpoint.type === 'transformers_js' || s.endpoint.url !== '') {
            // Initial model refresh is non-blocking, but its rejection must be
            // observed because initialization intentionally does not await it.
            void fetchModels({}).catch(() => {
              // fetchModels records the relevant error details.
            });
          }
        } else {
          // If no settings saved yet (new user), ensure defaults are clean but functional
          _settings.value.endpoint = { type: 'openai', url: '' };
          await setStringLocale({ locale: resolveBrowserLocale() });
        }
      } finally {
        loading.value = false;
        _initialized.value = true;
        initPromise = null;
      }
    })();

    return initPromise;
  }

  async function fetchModels({ overrides }: { overrides?: Endpoint }): Promise<string[]> {
    const requestId = ++nextModelFetchRequestId;
    latestModelFetchRequestId = requestId;
    activeModelFetchCount += 1;
    isFetchingModels.value = true;

    const endpoint = overrides ?? _settings.value.endpoint;

    try {
      if (isHttpEndpoint(endpoint) && endpoint.url === '') {
        if (requestId === latestModelFetchRequestId) {
          availableModels.value = [];
        }
        return [];
      }

      const provider = createLmProvider({
        endpoint,
        fakeLmDebugModeStatus: _settings.value.experimental?.fakeLm ?? 'disabled',
      });

      const models = await provider.listModels({});
      if (requestId === latestModelFetchRequestId) {
        availableModels.value = models;
      }
      return models;
    } catch (err) {
      if (requestId === latestModelFetchRequestId) {
        const { addErrorEvent } = useGlobalEvents();
        addErrorEvent({
          source: 'useSettings:fetchModels',
          message: await ensureStrings.useSettings__failed_to_fetch_models_for_settings(),
          details: err instanceof Error ? err : String(err),
        });
        console.error('Failed to fetch models:', err);
      }
      throw err;
    } finally {
      activeModelFetchCount -= 1;
      isFetchingModels.value = activeModelFetchCount > 0;
    }
  }

  async function save({ patch, modelRefresh }: {
    patch: Partial<Settings>,
    modelRefresh: 'await' | 'background',
  }) {
    if (Object.hasOwn(patch, 'endpoint') && patch.endpoint === undefined) {
      throw new Error('Global settings endpoint cannot be undefined');
    }

    const previousEndpoint = _settings.value.endpoint;
    const normalizedPatch: Partial<Settings> = patch.endpoint === undefined
      ? patch
      : { ...patch, endpoint: cloneEndpoint({ endpoint: patch.endpoint }) };

    // Update local reactive state
    _settings.value = { ..._settings.value, ...normalizedPatch };

    // If storage type is changed, handle provider switching/migration
    if (normalizedPatch.storageType && normalizedPatch.storageType !== storageService.getCurrentType()) {
      await storageService.switchProvider({ type: normalizedPatch.storageType });
    }

    // Persist as a patch to ensure we don't overwrite concurrent changes to other fields
    await storageService.updateSettings({ updater: ({ current: curr }) => {
      const base = curr || _settings.value;
      return { ...base, ...normalizedPatch } as Settings;
    } });

    // Re-fetch models if connection changed
    const endpointChanged = normalizedPatch.endpoint !== undefined
      && !areEndpointsEqual({ left: previousEndpoint, right: normalizedPatch.endpoint });
    if (endpointChanged) {
      switch (modelRefresh) {
      case 'await':
        await fetchModels({});
        break;
      case 'background':
        // URL-provided connection settings must become usable before a network
        // model-list request completes. Waiting here would put endpoint latency
        // back on the onboarding critical path that this startup refactor removes.
        void fetchModels({}).catch(() => {
          // fetchModels already records the user-visible/global error details.
        });
        break;
      default: {
        const _ex: never = modelRefresh;
        return _ex;
      }
      }
    }
  }

  async function updateExperimental({
    updater,
  }: {
    updater: ({ experimental }: { experimental: Settings['experimental'] }) => Settings['experimental'],
  }): Promise<void> {
    let savedSettings: Settings | undefined;
    await storageService.updateSettings({
      updater: ({ current }) => {
        const base = current ?? _settings.value;
        savedSettings = {
          ...base,
          experimental: updater({ experimental: base.experimental }),
        };
        return savedSettings;
      },
    });

    if (savedSettings !== undefined) {
      _settings.value = savedSettings;
    }
  }

  // --- Explicit Actions ---

  async function updateProviderProfiles({ profiles }: { profiles: ProviderProfile[] }) {
    const patch = { providerProfiles: [...profiles] };
    _settings.value.providerProfiles = patch.providerProfiles;
    await storageService.updateSettings({ updater: ({ current: curr }) => ({ ...(curr || _settings.value), ...patch } as Settings) });
  }

  async function updateGlobalModel({ modelId }: { modelId: string }) {
    _settings.value.defaultModelId = modelId;
    await storageService.updateSettings({ updater: ({ current: curr }) => ({ ...(curr || _settings.value), defaultModelId: modelId }) });
  }

  async function updateGlobalEndpoint({ endpoint }: { endpoint: Endpoint }) {
    const previousEndpoint = _settings.value.endpoint;
    const nextEndpoint = cloneEndpoint({ endpoint });

    _settings.value.endpoint = nextEndpoint;

    await storageService.updateSettings({ updater: ({ current: curr }) => ({
      ...(curr || _settings.value),
      endpoint: cloneEndpoint({ endpoint: nextEndpoint }),
    }) });

    if (!areEndpointsEqual({ left: previousEndpoint, right: nextEndpoint })) {
      await fetchModels({});
    }
  }

  async function updateSystemPrompt({ prompt }: { prompt: string }) {
    _settings.value.systemPrompt = prompt;
    await storageService.updateSettings({ updater: ({ current: curr }) => ({ ...(curr || _settings.value), systemPrompt: prompt }) });
  }

  async function updateStorageType({ type }: { type: StorageType }) {
    if (_settings.value.storageType === type) return;

    _settings.value.storageType = type;
    await storageService.switchProvider({ type });
    await storageService.updateSettings({ updater: ({ current: curr }) => ({ ...(curr || _settings.value), storageType: type }) });
  }

  function setIsOnboardingDismissed({ dismissed }: { dismissed: boolean }) {
    _isOnboardingDismissed.value = dismissed;
  }

  function setOnboardingDraft({ draft }: { draft: { url: string, type: EndpointType, headers?: [string, string][], models: string[], selectedModel: string } | null }) {
    _onboardingDraft.value = draft;
  }

  function setHeavyContentAlertDismissed({ dismissed }: { dismissed: boolean }) {
    _settings.value.heavyContentAlertDismissed = dismissed;
    storageService.updateSettings({ updater: ({ current: curr }) => ({ ...(curr || _settings.value), heavyContentAlertDismissed: dismissed }) });
  }

  async function setFakeLmDebugModeStatus({ status }: {
    status: FakeLmDebugModeStatus,
  }): Promise<void> {
    _settings.value.experimental = {
      ..._settings.value.experimental,
      fakeLm: status,
    };

    await storageService.updateSettings({ updater: ({ current: curr }) => {
      const base = curr ?? _settings.value;
      return {
        ...base,
        experimental: {
          ...base.experimental,
          fakeLm: status,
        },
      };
    } });

    preloadFakeLmIfEnabled({ status });
  }

  async function setLocale({ locale }: {
    locale: UiLocale,
  }): Promise<void> {
    const operation = localeChangeQueue.catch(() => {
      // A failed locale change must not prevent a later explicit request.
    }).then(async () => {
      await prepareLocale({ locale });
      await updateExperimental({
        updater: ({ experimental }) => ({
          ...experimental,
          locale,
        }),
      });
      await setStringLocale({ locale });
    });
    localeChangeQueue = operation;
    await operation;
  }

  async function setGlobalSearchScope({ scope }: {
    scope: GlobalSearchScopeSetting,
  }): Promise<void> {
    await updateExperimental({
      updater: ({ experimental }) => ({
        ...experimental,
        globalSearch: {
          ...experimental?.globalSearch,
          scope,
        },
      }),
    });
  }

  async function setGlobalSearchRoleFilter({ roleFilter }: {
    roleFilter: GlobalSearchRoleFilterSetting,
  }): Promise<void> {
    await updateExperimental({
      updater: ({ experimental }) => ({
        ...experimental,
        globalSearch: {
          ...experimental?.globalSearch,
          roleFilter,
        },
      }),
    });
  }

  async function setSearchPreviewMode({ mode }: {
    mode: SearchPreviewMode,
  }): Promise<void> {
    await updateExperimental({
      updater: ({ experimental }) => ({
        ...experimental,
        globalSearch: {
          ...experimental?.globalSearch,
          previewMode: mode,
        },
      }),
    });
  }

  async function setSearchContextSize({ size }: {
    size: SearchContextSize,
  }): Promise<void> {
    await updateExperimental({
      updater: ({ experimental }) => ({
        ...experimental,
        globalSearch: {
          ...experimental?.globalSearch,
          previewContextSize: size,
        },
      }),
    });
  }

  function __testOnlySetSettings({ newSettings }: { newSettings: Settings }) {
    _settings.value = JSON.parse(JSON.stringify(newSettings));
  }

  function __testOnlyReset() {
    _initialized.value = false;
    _isOnboardingDismissed.value = false;
    _onboardingDraft.value = null;
    _settings.value = {
      ...DEFAULT_SETTINGS,
      storageType: 'local',
      endpoint: { type: 'openai', url: '' },
    } as Settings;
    availableModels.value = [];
    isFetchingModels.value = false;
    nextModelFetchRequestId = 0;
    latestModelFetchRequestId = 0;
    activeModelFetchCount = 0;
    initPromise = null;
    localeChangeQueue = Promise.resolve();
  }

  return {
    settings: readonly(_settings) as Readonly<Ref<Settings>>,
    initialized: readonly(_initialized),
    isOnboardingDismissed,
    onboardingDraft: readonly(_onboardingDraft) as Readonly<Ref<{ url: string, type: EndpointType, headers?: [string, string][], models: string[], selectedModel: string } | null>>,
    availableModels: readonly(availableModels) as Readonly<Ref<string[]>>,
    isFetchingModels: readonly(isFetchingModels),
    globalSearchScope,
    globalSearchRoleFilter,
    searchPreviewMode,
    searchContextSize,
    init,
    save,
    updateExperimental,
    fetchModels,
    updateProviderProfiles,
    updateGlobalModel,
    updateGlobalEndpoint,
    updateSystemPrompt,
    updateStorageType,
    setIsOnboardingDismissed,
    setOnboardingDraft,
    setHeavyContentAlertDismissed,
    setFakeLmDebugModeStatus,
    setLocale,
    setGlobalSearchScope,
    setGlobalSearchRoleFilter,
    setSearchPreviewMode,
    setSearchContextSize,
    ...((__BUILD_MODE_IS_TEST__ && {
      TEST_ONLY: {
        __testOnlyReset,
        __testOnlySetSettings,
      },
    }) || {}),
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {};
