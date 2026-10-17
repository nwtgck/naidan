<script setup lang="ts">
import RpcRegistrationSelect from '@/features/naidan-rpc-integration/components/RpcRegistrationSelect.vue';
import { getEndpointBuildAvailability } from '@/logic/endpoint-build-availability';
import { generateId } from '@/01-models/id';
import { ref, watch, computed, h, useId } from 'vue';
import { useSettings } from '@/composables/useSettings';
import { useToast } from '@/composables/useToast';
import type { Endpoint, EndpointType, LmParameters, ProviderProfile, Reasoning, Settings, SettingsTitleGeneration } from '@/01-models/types';
import { EMPTY_LM_PARAMETERS } from '@/01-models/types';
import { areEndpointModelNamespacesEqual, areEndpointsEqual, cloneEndpoint, isHttpEndpoint, selectHttpEndpointSeed } from '@/01-models/endpoint';
import { naturalSort } from '@/utils/string';
import { cloneLmParameters as clonePlainLmParameters } from '@/utils/lm-parameters';
import {
  Loader2Icon, SaveIcon, CheckCircle2Icon, BookmarkPlusIcon,
  CheckIcon, ActivityIcon, LinkIcon, FolderOpenIcon, ChevronDownIcon, SlidersHorizontalIcon, TypeIcon,
} from 'lucide-vue-next';
import { defineAsyncComponentAndLoadOnMounted } from '@/utils/vue';

// IMPORTANT: ModelSelector is a core part of the connection setup UI and should not flicker.
import ModelSelector from './ModelSelector.vue';
import ReasoningSettings from './ReasoningSettings.vue';
import SettingsSelect from './SettingsSelect.vue';
import EndpointPresetButtons from './EndpointPresetButtons.vue';
import SettingsCollapse from './SettingsCollapse.vue';
import SettingsDisclosure from './SettingsDisclosure.vue';
import HttpHeadersEditor from './HttpHeadersEditor.vue';
import type { SettingsSourcePresentation } from './SettingsSourceBadge.vue';
import { endpointTypeLabel, endpointTypeDescription, endpointUrlPlaceholder } from './endpoint-type-label';

// Lazily load heavier or secondary settings components, but prefetch them when idle.
const LmParametersEditor = defineAsyncComponentAndLoadOnMounted({ loader: () => import('./LmParametersEditor.vue') });
// Lazily load previews that are only shown during specific actions
const ProviderProfilePreview = defineAsyncComponentAndLoadOnMounted({ loader: () => import('./ProviderProfilePreview.vue') });
const OllamaManagementView = defineAsyncComponentAndLoadOnMounted({ loader: () => import('./OllamaManagementView.vue') });

import { useConfirm } from '@/composables/useConfirm';
import { usePrompt } from '@/composables/usePrompt';
import { ENDPOINT_PRESETS } from '@/constants';
import { idToRaw } from '@/01-models/ids';
import type { ProviderProfileId } from '@/01-models/ids';
import { lazyStrings, ensureStrings } from '@/strings';
import PromptApiStatus from '@/features/prompt-api/components/PromptApiStatus.vue';
import { getPromptApiLanguageModel } from '@/features/prompt-api/api';
import { BROWSER_PROVIDED_LM_MODEL_ID } from '@/features/prompt-api';
import { hasLmParameterOverrides } from '@/utils/lm-parameters';

const props = defineProps<{
  modelValue: Settings,
  availableModels: readonly string[],
  isFetchingModels: boolean,
  hasUnsavedChanges: boolean,
}>();

const emit = defineEmits<{
  (e: 'update:modelValue', value: Settings): void,
  (e: 'save'): void,
  (e: 'goToProfiles'): void,
  (e: 'goToTransformersJs'): void,
}>();

const sortedModels = computed(() => naturalSort({ values: Array.isArray(props.availableModels) ? props.availableModels : [] }));
const titleEndpointModels = ref<string[]>([]);
const isFetchingTitleEndpointModels = ref(false);
const sortedTitleEndpointModels = computed(() => naturalSort({ values: titleEndpointModels.value }));

const { save, fetchModels: fetchModelsGlobal, updateProviderProfiles } = useSettings();
const { showConfirm } = useConfirm();
const { showPrompt } = usePrompt();
const { addToast } = useToast();


const form = computed({
  get: () => props.modelValue,
  set: (val) => emit('update:modelValue', val),
});

const rpcEnabled = computed(() => form.value.experimental?.naidanRpc === 'enabled');

const endpointType = computed<Endpoint['type']>({
  get: () => form.value.endpoint.type,
  set: (type) => {
    const previousEndpoint = cloneEndpoint({ endpoint: form.value.endpoint });
    const clearBrowserProvidedLmModelIds = (): void => {
      if (form.value.defaultModelId === BROWSER_PROVIDED_LM_MODEL_ID) {
        form.value.defaultModelId = '';
      }
      clearBrowserProvidedTitleModelOverride();
    };

    switch (type) {
    case 'openai':
    case 'ollama': {
      clearBrowserProvidedLmModelIds();
      const current = form.value.endpoint;
      form.value.endpoint = {
        type,
        url: isHttpEndpoint(current) ? current.url : '',
        httpHeaders: isHttpEndpoint(current)
          ? current.httpHeaders?.map(([name, value]) => [name, value])
          : undefined,
      };
      resetModelsWhenEndpointNamespaceChanges({ previousEndpoint, nextEndpoint: form.value.endpoint });
      return;
    }
    case 'naidan_rpc':
      clearBrowserProvidedLmModelIds();
      form.value.endpoint = { type, registrationId: undefined };
      resetModelsWhenEndpointNamespaceChanges({ previousEndpoint, nextEndpoint: form.value.endpoint });
      return;
    case 'llama_cpp_browser':
    case 'transformers_js':
      clearBrowserProvidedLmModelIds();
      form.value.endpoint = { type };
      resetModelsWhenEndpointNamespaceChanges({ previousEndpoint, nextEndpoint: form.value.endpoint });
      return;
    case 'browser_provided_lm':
      form.value.endpoint = { type };
      form.value.defaultModelId = BROWSER_PROVIDED_LM_MODEL_ID;
      setFormTitleGeneration({ titleGeneration: { endpoint: 'same_scope', model: 'same_scope' } });
      return;
    case 'unsupported_experimental_endpoint':
      return;
    default: {
      const _ex: never = type;
      throw new Error(`Unhandled endpoint type: ${_ex}`);
    }
    }
  },
});

const endpointUrl = computed({
  get: () => isHttpEndpoint(form.value.endpoint) ? form.value.endpoint.url : '',
  set: (url: string) => {
    const endpoint = form.value.endpoint;
    if (!isHttpEndpoint(endpoint)) {
      return;
    }
    const previousEndpoint = cloneEndpoint({ endpoint });
    form.value.endpoint = {
      ...endpoint,
      url,
    };
    resetModelsWhenEndpointNamespaceChanges({ previousEndpoint, nextEndpoint: form.value.endpoint });
  },
});

const endpointHttpHeaders = computed<[string, string][] | undefined>({
  get: () => isHttpEndpoint(form.value.endpoint)
    ? form.value.endpoint.httpHeaders
    : undefined,
  set: (httpHeaders) => {
    const endpoint = form.value.endpoint;
    if (!isHttpEndpoint(endpoint)) {
      return;
    }
    form.value.endpoint = {
      ...endpoint,
      httpHeaders,
    };
  },
});

const connectionSuccess = ref(false);
const isPromptApiSupported = computed(() => getPromptApiLanguageModel() !== undefined);

const error = ref<string | null>(null);

const saveSuccess = ref(false);

const selectedProviderProfileId = ref('');

const copied = ref(false);

type TitleReasoningSelectValue = 'same_scope' | Reasoning['effort'];

type SettingsTitleGenerationDraft =
  | 'disabled'
  | {
      endpoint: 'same_scope',
      model: 'same_scope' | { id: string },
      lmParameters?: 'same_scope' | LmParameters,
    }
  | {
      endpoint: Endpoint,
      model: { id: string },
      lmParameters?: LmParameters,
    };

function emptyLmParameters(): LmParameters {
  return {
    ...EMPTY_LM_PARAMETERS,
    reasoning: { ...EMPTY_LM_PARAMETERS.reasoning },
  };
}

function cloneTitleLmParameters({
  lmParameters,
}: {
  lmParameters: 'same_scope' | LmParameters | undefined,
}): 'same_scope' | LmParameters | undefined {
  if (lmParameters === undefined) {
    return undefined;
  }
  if (lmParameters === 'same_scope') {
    return 'same_scope';
  }
  return clonePlainLmParameters({ lmParameters }) ?? emptyLmParameters();
}

function titleLmParametersForEndpoint({
  endpoint,
  lmParameters,
}: {
  endpoint: Endpoint | 'same_scope',
  lmParameters: 'same_scope' | LmParameters | undefined,
}): 'same_scope' | LmParameters {
  if (endpoint === 'same_scope' && lmParameters === 'same_scope') {
    return 'same_scope';
  }
  return cloneTitleLmParameters({ lmParameters }) as LmParameters | undefined ?? emptyLmParameters();
}

function titleGenerationWithLmParameters({
  titleGeneration,
}: {
  titleGeneration: SettingsTitleGenerationDraft,
}): SettingsTitleGeneration {
  if (titleGeneration === 'disabled') {
    return 'disabled';
  }

  const current = currentSettingsTitleGeneration();
  const currentLmParameters = current === 'disabled' ? undefined : current.lmParameters;
  return {
    ...titleGeneration,
    lmParameters: titleLmParametersForEndpoint({
      endpoint: titleGeneration.endpoint,
      lmParameters: titleGeneration.lmParameters ?? currentLmParameters,
    }),
  } as SettingsTitleGeneration;
}

function titleReasoningSelectValueFromLmParameters({
  endpoint,
  lmParameters,
}: {
  endpoint: Endpoint | 'same_scope',
  lmParameters: 'same_scope' | LmParameters | undefined,
}): TitleReasoningSelectValue {
  if (endpoint === 'same_scope' && lmParameters === 'same_scope') {
    return 'same_scope';
  }
  return lmParameters !== 'same_scope' && lmParameters?.reasoning?.effort !== undefined
    ? lmParameters.reasoning.effort
    : undefined;
}

function titleLmParametersFromReasoningSelectValue({
  value,
  current,
}: {
  value: TitleReasoningSelectValue,
  current: 'same_scope' | LmParameters | undefined,
}): 'same_scope' | LmParameters {
  switch (value) {
  case 'same_scope':
    return 'same_scope';
  case undefined: {
    const lmParameters = current === 'same_scope'
      ? emptyLmParameters()
      : clonePlainLmParameters({ lmParameters: current }) ?? emptyLmParameters();
    lmParameters.reasoning.effort = undefined;
    return lmParameters;
  }
  case 'none':
  case 'low':
  case 'medium':
  case 'high': {
    const lmParameters = current === 'same_scope'
      ? emptyLmParameters()
      : clonePlainLmParameters({ lmParameters: current }) ?? emptyLmParameters();
    lmParameters.reasoning.effort = value;
    return lmParameters;
  }
  default: {
    const _ex: never = value;
    throw new Error(`Unhandled title reasoning value: ${_ex}`);
  }
  }
}

function reasoningEffortFromTitleReasoningValue({
  value,
}: {
  value: TitleReasoningSelectValue,
}): Reasoning['effort'] {
  switch (value) {
  case 'same_scope':
  case undefined:
    return undefined;
  case 'none':
  case 'low':
  case 'medium':
  case 'high':
    return value;
  default: {
    const _ex: never = value;
    throw new Error(`Unhandled title reasoning value: ${_ex}`);
  }
  }
}

const globalTitleReasoningLeadingOptions = computed(() => {
  const label = globalTitleEndpointUsesSameScope.value
    ? lazyStrings.ConnectionTab__same_as_conversation()
    : undefined;
  return [{
    value: 'same_scope' as const,
    label,
    shortLabel: label,
    testId: 'same-scope',
  }];
});

function currentSettingsTitleGeneration(): SettingsTitleGeneration {
  return form.value.titleGeneration ?? { endpoint: 'same_scope', model: 'same_scope', lmParameters: emptyLmParameters() };
}

function resetSameScopeTitleModel(): void {
  const titleGeneration = form.value.titleGeneration;
  if (titleGeneration === 'disabled' || titleGeneration.endpoint !== 'same_scope' || titleGeneration.model === 'same_scope') {
    return;
  }
  setFormTitleGeneration({ titleGeneration: { endpoint: 'same_scope', model: 'same_scope' } });
}

function resetModelsWhenEndpointNamespaceChanges({
  previousEndpoint,
  nextEndpoint,
}: {
  previousEndpoint: Endpoint,
  nextEndpoint: Endpoint,
}): void {
  if (areEndpointModelNamespacesEqual({ left: previousEndpoint, right: nextEndpoint })) {
    return;
  }
  form.value.defaultModelId = '';
  resetSameScopeTitleModel();
}


function titleModelIdFromSettingsTitleGeneration({
  titleGeneration,
}: {
  titleGeneration: SettingsTitleGeneration,
}): string | undefined {
  if (titleGeneration === 'disabled' || titleGeneration.model === 'same_scope') {
    return undefined;
  }
  return titleGeneration.model.id;
}

const globalTitleGenerationEnabled = computed(() => currentSettingsTitleGeneration() !== 'disabled');

const titleEndpointTypeSelectValueRecord: Readonly<Record<EndpointType, true>> = {
  naidan_rpc: true,
  openai: true,
  ollama: true,
  transformers_js: true,
  llama_cpp_browser: true,
  browser_provided_lm: true,
};

type TitleEndpointTypeSelectValue = 'same_scope' | Endpoint['type'];

function titleEndpointTypeFromSelectValue({ value }: { value: string }): TitleEndpointTypeSelectValue {
  if (value === 'same_scope') {
    return 'same_scope';
  }
  if (value === 'unsupported_experimental_endpoint') {
    return 'unsupported_experimental_endpoint';
  }
  if (Object.hasOwn(titleEndpointTypeSelectValueRecord, value)) {
    return value as EndpointType;
  }
  throw new Error(`Unhandled title endpoint type value: ${value}`);
}

const globalTitleEndpoint = computed(() => {
  const titleGeneration = currentSettingsTitleGeneration();
  if (titleGeneration === 'disabled') {
    return 'same_scope';
  }
  return titleGeneration.endpoint;
});
const globalTitleEndpointSelectValue = computed<TitleEndpointTypeSelectValue>(() => {
  const endpoint = globalTitleEndpoint.value;
  return endpoint === 'same_scope' ? 'same_scope' : endpoint.type;
});
const globalTitleEndpointUsesSameScope = computed(() => globalTitleEndpoint.value === 'same_scope');
const globalEffectiveTitleEndpoint = computed<Endpoint>(() => globalTitleEndpoint.value === 'same_scope'
  ? form.value.endpoint
  : globalTitleEndpoint.value);
const globalTitleEndpointUrl = computed({
  get: () => {
    const endpoint = globalTitleEndpoint.value;
    return endpoint !== 'same_scope' && isHttpEndpoint(endpoint) ? endpoint.url : '';
  },
  set: (url: string) => {
    const titleGeneration = currentSettingsTitleGeneration();
    const endpoint = globalTitleEndpoint.value;
    if (titleGeneration === 'disabled' || endpoint === 'same_scope' || !isHttpEndpoint(endpoint)) {
      return;
    }
    setFormTitleGeneration({
      titleGeneration: {
        endpoint: {
          type: endpoint.type,
          url,
          httpHeaders: endpoint.httpHeaders?.map(([name, value]) => [name, value]),
        },
        model: titleGeneration.model === 'same_scope' ? explicitSettingsTitleModel({ modelId: undefined }) : titleGeneration.model,
      },
    });
  },
});
const globalTitleEndpointHttpHeaders = computed(() => {
  const endpoint = globalTitleEndpoint.value;
  return endpoint !== 'same_scope' && isHttpEndpoint(endpoint)
    ? endpoint.httpHeaders?.map(([name, value]) => [name, value] as [string, string]) ?? []
    : undefined;
});

function setGlobalTitleEndpointHttpHeaders({
  httpHeaders,
}: {
  httpHeaders: [string, string][],
}): void {
  const titleGeneration = currentSettingsTitleGeneration();
  const endpoint = globalTitleEndpoint.value;
  if (titleGeneration === 'disabled' || endpoint === 'same_scope' || !isHttpEndpoint(endpoint)) {
    return;
  }
  setFormTitleGeneration({
    titleGeneration: {
      endpoint: {
        type: endpoint.type,
        url: endpoint.url,
        httpHeaders,
      },
      model: titleGeneration.model === 'same_scope' ? explicitSettingsTitleModel({ modelId: undefined }) : titleGeneration.model,
    },
  });
}

const globalTitleModelOptions = computed(() => globalTitleEndpointUsesSameScope.value
  ? sortedModels.value
  : sortedTitleEndpointModels.value);
const globalTitleModelAllowClear = computed(() => globalTitleEndpointUsesSameScope.value);
const globalTitleModelLoading = computed(() => globalTitleEndpointUsesSameScope.value
  ? props.isFetchingModels
  : isFetchingTitleEndpointModels.value);

const globalTitleModelId = computed(() => {
  const titleGeneration = currentSettingsTitleGeneration();
  if (titleGeneration === 'disabled' || titleGeneration.model === 'same_scope') {
    return undefined;
  }
  return titleGeneration.model.id;
});

const globalTitleReasoningSelectValue = computed<TitleReasoningSelectValue>(() => {
  const titleGeneration = currentSettingsTitleGeneration();
  if (titleGeneration === 'disabled') {
    return undefined;
  }
  return titleReasoningSelectValueFromLmParameters({
    endpoint: titleGeneration.endpoint,
    lmParameters: titleGeneration.lmParameters,
  });
});

function setGlobalTitleReasoningSelectValue({ value }: { value: TitleReasoningSelectValue }): void {
  const titleGeneration = currentSettingsTitleGeneration();
  if (titleGeneration === 'disabled') {
    return;
  }
  if (value === 'same_scope' && titleGeneration.endpoint !== 'same_scope') {
    return;
  }
  setFormTitleGeneration({
    titleGeneration: {
      ...titleGeneration,
      lmParameters: titleLmParametersFromReasoningSelectValue({
        value,
        current: titleGeneration.lmParameters,
      }),
    } as SettingsTitleGeneration,
  });
}

function setFormTitleGeneration({
  titleGeneration,
}: {
  titleGeneration: SettingsTitleGenerationDraft,
}): void {
  form.value.titleGeneration = titleGenerationWithLmParameters({ titleGeneration });
}

function setGlobalAutoTitleEnabled({ enabled }: { enabled: boolean }): void {
  if (!enabled) {
    setFormTitleGeneration({ titleGeneration: 'disabled' });
    return;
  }

  const current = currentSettingsTitleGeneration();
  setFormTitleGeneration({
    titleGeneration: current === 'disabled'
      ? { endpoint: 'same_scope', model: 'same_scope', lmParameters: emptyLmParameters() }
      : current,
  });
}

function handleGlobalAutoTitleChange({ event }: { event: Event }): void {
  setGlobalAutoTitleEnabled({ enabled: (event.target as HTMLInputElement).checked });
}

function sameScopeSettingsTitleModel({
  modelId,
}: {
  modelId: string | undefined,
}): 'same_scope' | { id: string } {
  return modelId === undefined || modelId === '' ? 'same_scope' : { id: modelId };
}

function explicitSettingsTitleModel({
  modelId,
}: {
  modelId: string | undefined,
}): { id: string } {
  return { id: modelId || globalTitleModelOptions.value[0] || form.value.defaultModelId || BROWSER_PROVIDED_LM_MODEL_ID };
}

function setGlobalTitleEndpointType({
  endpointType,
}: {
  endpointType: TitleEndpointTypeSelectValue,
}): void {
  const modelId = globalTitleModelId.value;
  switch (endpointType) {
  case 'same_scope':
    setFormTitleGeneration({
      titleGeneration: {
        endpoint: 'same_scope',
        model: sameScopeSettingsTitleModel({ modelId }),
      },
    });
    return;
  case 'browser_provided_lm':
    setFormTitleGeneration({
      titleGeneration: {
        endpoint: { type: 'browser_provided_lm' },
        model: { id: BROWSER_PROVIDED_LM_MODEL_ID },
      },
    });
    return;
  case 'naidan_rpc':
    setFormTitleGeneration({ titleGeneration: { endpoint: { type: 'naidan_rpc', registrationId: undefined }, model: explicitSettingsTitleModel({ modelId }) } });
    return;
  case 'llama_cpp_browser':
  case 'transformers_js':
    setFormTitleGeneration({
      titleGeneration: {
        endpoint: { type: endpointType },
        model: explicitSettingsTitleModel({ modelId }),
      },
    });
    return;
  case 'unsupported_experimental_endpoint':
    return;
  case 'openai':
  case 'ollama': {
    const currentTitleEndpoint = globalTitleEndpoint.value;
    const seed = selectHttpEndpointSeed({
      preferred: currentTitleEndpoint === 'same_scope' ? undefined : currentTitleEndpoint,
      fallback: form.value.endpoint,
    });
    setFormTitleGeneration({
      titleGeneration: {
        endpoint: {
          type: endpointType,
          url: seed?.url ?? '',
          httpHeaders: seed?.httpHeaders?.map(([name, value]) => [name, value]),
        },
        model: explicitSettingsTitleModel({ modelId }),
      },
    });
    return;
  }
  default: {
    const _ex: never = endpointType;
    throw new Error(`Unhandled title endpoint type: ${_ex}`);
  }
  }
}

function setGlobalTitleModelId({ modelId }: { modelId: string | undefined }): void {
  const titleGeneration = currentSettingsTitleGeneration();
  const endpoint = titleGeneration === 'disabled' ? 'same_scope' : titleGeneration.endpoint;
  if (endpoint === 'same_scope') {
    setFormTitleGeneration({
      titleGeneration: {
        endpoint: 'same_scope',
        model: sameScopeSettingsTitleModel({ modelId }),
      },
    });
    return;
  }
  setFormTitleGeneration({
    titleGeneration: {
      endpoint: cloneEndpoint({ endpoint }),
      model: explicitSettingsTitleModel({ modelId }),
    },
  });
}

async function fetchTitleEndpointModels(): Promise<void> {
  if (globalTitleEndpointUsesSameScope.value) {
    await fetchModels();
    return;
  }
  const endpoint = cloneEndpoint({ endpoint: globalEffectiveTitleEndpoint.value });
  if (isHttpEndpoint(endpoint) && endpoint.url === '') {
    titleEndpointModels.value = [];
    return;
  }

  isFetchingTitleEndpointModels.value = true;
  error.value = null;
  try {
    const models = await fetchModelsGlobal({ overrides: endpoint });
    if (!areEndpointsEqual({ left: endpoint, right: globalEffectiveTitleEndpoint.value })) {
      return;
    }
    if (models.length === 0 && endpoint.type !== 'transformers_js' && endpoint.type !== 'llama_cpp_browser') {
      throw new Error(await ensureStrings.SHARED__no_models_found_at_this_endpoint());
    }
    titleEndpointModels.value = models;
    const titleGeneration = currentSettingsTitleGeneration();
    if (titleGeneration === 'disabled' || titleGeneration.endpoint === 'same_scope') {
      return;
    }
    if (!models.includes(titleGeneration.model.id) && models[0] !== undefined) {
      setFormTitleGeneration({
        titleGeneration: {
          endpoint: cloneEndpoint({ endpoint: titleGeneration.endpoint }),
          model: { id: models[0] },
        },
      });
    }
  } catch (caught) {
    error.value = caught instanceof Error
      ? caught.message
      : await ensureStrings.SHARED__connection_failed_check_url_or_provider();
  } finally {
    isFetchingTitleEndpointModels.value = false;
  }
}

function clearBrowserProvidedTitleModelOverride(): void {
  const titleGeneration = currentSettingsTitleGeneration();
  if (titleGeneration !== 'disabled' && titleGeneration.model !== 'same_scope' && titleGeneration.model.id === BROWSER_PROVIDED_LM_MODEL_ID) {
    setFormTitleGeneration({ titleGeneration: { endpoint: 'same_scope', model: 'same_scope' } });
    return;
  }
}

async function copySetupUrl(): Promise<void> {
  const baseUrl = window.location.origin + window.location.pathname;
  const params = new URLSearchParams();

  if (form.value.storageType) {
    params.set('storage-type', form.value.storageType);
  }

  const endpoint = form.value.endpoint;
  const type = endpoint.type;
  switch (type) {
  case 'openai':
  case 'ollama':
    params.set('global-endpoint-type', type);
    if (endpoint.url) {
      params.set('global-endpoint-url', endpoint.url);
    }
    break;
  case 'llama_cpp_browser':
  case 'transformers_js':
    // transformers_js doesn't use global-endpoint parameters in this implementation
    break;
  case 'naidan_rpc':
  case 'browser_provided_lm':
  case 'unsupported_experimental_endpoint':
    // Experimental endpoint DTOs are intentionally not encoded in setup URLs.
    break;
  default: {
    const _ex: never = type;
    throw new Error(`Unhandled endpoint type: ${_ex}`);
  }
  }

  if (
    form.value.defaultModelId
    && endpoint.type !== 'browser_provided_lm'
    && endpoint.type !== 'unsupported_experimental_endpoint'
  ) {
    params.set('global-model', form.value.defaultModelId);
  }

  const queryString = params.toString();
  const fullUrl = queryString ? `${baseUrl}#/?${queryString}` : baseUrl;

  await navigator.clipboard.writeText(fullUrl);
  copied.value = true;
  addToast({ message: await ensureStrings.ConnectionTab__setup_url_copied(), duration: 2000 });
  setTimeout(() => {
    copied.value = false;
  }, 2000);
}

function applyPreset({ preset }: { preset: typeof ENDPOINT_PRESETS[number] }) {
  const previousEndpoint = cloneEndpoint({ endpoint: form.value.endpoint });
  form.value = {
    ...form.value,
    endpoint: {
      type: preset.type,
      url: preset.url,
    },
    defaultModelId: form.value.defaultModelId === BROWSER_PROVIDED_LM_MODEL_ID
      ? ''
      : form.value.defaultModelId,
    titleGeneration: currentSettingsTitleGeneration(),
  };
  resetModelsWhenEndpointNamespaceChanges({ previousEndpoint, nextEndpoint: form.value.endpoint });
}

async function fetchModels() {
  const requestedEndpoint = cloneEndpoint({ endpoint: form.value.endpoint });
  if (isHttpEndpoint(requestedEndpoint) && requestedEndpoint.url === '') {
    return;
  }

  error.value = null;
  try {
    // Trigger global fetch with current form values (may be unsaved)
    const models = await fetchModelsGlobal({ overrides: requestedEndpoint });
    if (!areEndpointsEqual({ left: requestedEndpoint, right: form.value.endpoint })) {
      return;
    }

    if (models.length === 0 && form.value.endpoint.type !== 'transformers_js' && form.value.endpoint.type !== 'llama_cpp_browser') {
      throw new Error(await ensureStrings.SHARED__no_models_found_at_this_endpoint());
    }

    // Validate current selection against new models
    const updatedForm = { ...form.value };
    let changed = false;
    const shouldValidateModelSelection = (() => {
      switch (updatedForm.endpoint.type) {
      case 'naidan_rpc':
      case 'openai':
      case 'ollama':
      case 'llama_cpp_browser':
      case 'transformers_js':
      case 'browser_provided_lm':
        return true;
      case 'unsupported_experimental_endpoint':
        return false;
      default: {
        const _ex: never = updatedForm.endpoint;
        throw new Error(`Unhandled endpoint: ${((_ex satisfies never) as { readonly type: string }).type}`);
      }
      }
    })();
    if (shouldValidateModelSelection) {
      if (updatedForm.defaultModelId && !models.includes(updatedForm.defaultModelId)) {
        updatedForm.defaultModelId = '';
        changed = true;
      }
      const titleGeneration = updatedForm.titleGeneration;
      if (
        titleGeneration !== 'disabled'
        && titleGeneration.endpoint === 'same_scope'
        && titleGeneration.model !== 'same_scope'
        && !models.includes(titleGeneration.model.id)
      ) {
        updatedForm.titleGeneration = { ...titleGeneration, model: 'same_scope' };
        changed = true;
      }
    }
    if (changed) {
      form.value = updatedForm;
    }

    error.value = null;
    connectionSuccess.value = true;
    setTimeout(() => {
      connectionSuccess.value = false;
    }, 3000);
  } catch (err) {
    if (!areEndpointsEqual({ left: requestedEndpoint, right: form.value.endpoint })) {
      return;
    }
    console.error(err);
    error.value = err instanceof Error ? err.message : await ensureStrings.SHARED__connection_failed_check_url_or_provider();
    connectionSuccess.value = false;
  }
}


watch([globalTitleEndpointUrl, globalTitleEndpointSelectValue], ([url, endpointType]) => {
  if (globalTitleGenerationEnabled.value && !globalTitleEndpointUsesSameScope.value) {
    if ((endpointType === 'transformers_js' || endpointType === 'llama_cpp_browser') || endpointType === 'browser_provided_lm' || (url && (url.includes('localhost') || url.includes('127.0.0.1')))) {
      void fetchTitleEndpointModels();
    }
  }
});

async function handleSave() {
  try {
    await save({
      patch: {
        endpoint: cloneEndpoint({ endpoint: form.value.endpoint }),
        defaultModelId: form.value.defaultModelId,
        titleGeneration: currentSettingsTitleGeneration(),
        systemPrompt: form.value.systemPrompt,
        lmParameters: form.value.lmParameters,
      },
      modelRefresh: 'await',
    });

    emit('save');
    saveSuccess.value = true;
    setTimeout(() => {
      saveSuccess.value = false;
    }, 2000);
  } catch (err) {
    console.error('Failed to save settings:', err);
    await showConfirm({
      title: await ensureStrings.ConnectionTab__save_failed(),
      message: await ensureStrings.ConnectionTab__failed_to_save_settings({ errorMessage: err instanceof Error ? err.message : String(err) }),
      confirmButtonText: await ensureStrings.ConnectionTab__understand(),
    });
  }
}

async function handleCreateProviderProfile() {
  const name = await showPrompt({
    title: await ensureStrings.ConnectionTab__create_new_profile(),
    message: await ensureStrings.ConnectionTab__give_configuration_a_name(),
    defaultValue: `${endpointTypeLabel({ endpointType: form.value.endpoint.type })} - ${form.value.defaultModelId || await ensureStrings.ConnectionTab__default()}`,
    confirmButtonText: await ensureStrings.ConnectionTab__create(),
    bodyComponent: h(ProviderProfilePreview, { form: form.value }),
  });

  if (!name) {
    return;
  }

  const newProviderProfile: ProviderProfile = {
    id: generateId<ProviderProfileId>(),
    name,
    endpoint: cloneEndpoint({ endpoint: form.value.endpoint }),
    defaultModelId: form.value.defaultModelId,
    titleModelId: titleModelIdFromSettingsTitleGeneration({ titleGeneration: form.value.titleGeneration }),
    systemPrompt: form.value.systemPrompt,
    lmParameters: form.value.lmParameters ? JSON.parse(JSON.stringify(form.value.lmParameters)) : undefined,
  };

  if (!form.value.providerProfiles) {
    form.value.providerProfiles = [];
  }
  form.value.providerProfiles.push(newProviderProfile);
  await updateProviderProfiles({ profiles: JSON.parse(JSON.stringify(form.value.providerProfiles)) });

  addToast({
    message: await ensureStrings.ConnectionTab__profile_created({ profileName: name }),
    actionLabel: await ensureStrings.ConnectionTab__view_profiles(),
    onAction: () => emit('goToProfiles'),
    duration: 5000,
  });
}

function handleQuickProviderProfileChange() {
  const providerProfile = form.value.providerProfiles?.find(p => idToRaw({ id: p.id }) === selectedProviderProfileId.value);
  if (providerProfile) {
    form.value.endpoint = cloneEndpoint({ endpoint: providerProfile.endpoint });
    form.value.defaultModelId = providerProfile.defaultModelId;
    setFormTitleGeneration({
      titleGeneration: providerProfile.titleModelId === undefined || providerProfile.titleModelId === ''
        ? { endpoint: 'same_scope', model: 'same_scope', lmParameters: undefined }
        : { endpoint: 'same_scope', model: { id: providerProfile.titleModelId }, lmParameters: undefined },
    });
    form.value.systemPrompt = providerProfile.systemPrompt;
    form.value.lmParameters = providerProfile.lmParameters ? JSON.parse(JSON.stringify(providerProfile.lmParameters)) : undefined;
  }
  selectedProviderProfileId.value = '';
}

// Auto-fetch for localhost or transformers_js
watch([endpointUrl, endpointType], ([url, type]) => {
  if (
    (type === 'transformers_js' || type === 'llama_cpp_browser')
    || type === 'browser_provided_lm'
    || (url && (url.includes('localhost') || url.includes('127.0.0.1')))
  ) {
    fetchModels();
  }
});

const mainReasoningDisabled = computed(() => endpointType.value === 'browser_provided_lm');

function setMainReasoningEffort({ effort }: { effort: Reasoning['effort'] }): void {
  if (mainReasoningDisabled.value || effort === form.value.lmParameters?.reasoning.effort) {
    return;
  }
  const current = form.value.lmParameters ?? EMPTY_LM_PARAMETERS;
  form.value.lmParameters = { ...current, reasoning: { ...current.reasoning, effort } };
}

const settingsId = useId();
const titleOpen = ref(false);
const titleTrigger = ref<HTMLButtonElement | null>(null);
const titleDetailsId = `${settingsId}-title-details`;

type EndpointChoice = { value: TitleEndpointTypeSelectValue, label: string | undefined, detail?: string, disabled?: boolean, source?: SettingsSourcePresentation };

function endpointChoices({ current, title }: { current: TitleEndpointTypeSelectValue, title: boolean }): EndpointChoice[] {
  const transformersUnavailable = getEndpointBuildAvailability({ type: 'transformers_js' }) !== 'available';
  const choices: EndpointChoice[] = [
    { value: 'openai', label: lazyStrings.ConnectionTab__openai_compatible(), detail: endpointTypeDescription({ endpointType: 'openai' }) },
    { value: 'ollama', label: lazyStrings.ConnectionTab__ollama(), detail: endpointTypeDescription({ endpointType: 'ollama' }) },
  ];
  if (rpcEnabled.value || current === 'naidan_rpc') {
    choices.push({ value: 'naidan_rpc', label: rpcEnabled.value ? lazyStrings.naidanRpc__title() : lazyStrings.naidanRpc__disabled(), detail: endpointTypeDescription({ endpointType: 'naidan_rpc' }), disabled: !rpcEnabled.value });
  }
  choices.push(
    { value: 'llama_cpp_browser', label: lazyStrings.llamaCppBrowser__endpoint_label(), detail: endpointTypeDescription({ endpointType: 'llama_cpp_browser' }), disabled: getEndpointBuildAvailability({ type: 'llama_cpp_browser' }) !== 'available' },
    { value: 'transformers_js', label: lazyStrings.ConnectionTab__transformers_js_experimental(), detail: !title && transformersUnavailable ? lazyStrings.ConnectionTab__unavailable_in_standalone_due_to_worker_wasm_restrictions() : endpointTypeDescription({ endpointType: 'transformers_js' }), disabled: transformersUnavailable },
    { value: 'browser_provided_lm', label: lazyStrings.SHARED__browser_provided(), detail: !title && !isPromptApiSupported.value ? lazyStrings.ConnectionTab__browser_api_not_available() : endpointTypeDescription({ endpointType: 'browser_provided_lm' }) },
  );
  switch (current) {
  case 'unsupported_experimental_endpoint': {
    const unsupported: EndpointChoice = { value: current, label: lazyStrings.SHARED__unsupported_experimental_endpoint(), disabled: true };
    if (title) {
      choices.unshift(unsupported);
    } else {
      choices.push(unsupported);
    }
    break;
  }
  case 'same_scope':
  case 'naidan_rpc':
  case 'openai':
  case 'ollama':
  case 'llama_cpp_browser':
  case 'transformers_js':
  case 'browser_provided_lm':
    break;
  default: {
    const _ex: never = current;
    throw new Error(`Unhandled endpoint choice: ${_ex}`);
  }
  }
  return choices;
}

const mainEndpointChoices = computed(() => endpointChoices({ current: endpointType.value, title: false }));
const conversationSource = computed<SettingsSourcePresentation>(() => ({ label: lazyStrings.ConnectionTab__regular_conversation(), description: lazyStrings.ConnectionTab__uses_each_conversations_settings() }));
const titleEndpointChoices = computed<EndpointChoice[]>(() => [
  { value: 'same_scope', label: lazyStrings.ConnectionTab__conversation_connection(), source: conversationSource.value },
  ...endpointChoices({ current: globalTitleEndpointSelectValue.value, title: true }),
]);
const titleModelPresentation = computed(() => globalTitleEndpointUsesSameScope.value
  ? { id: undefined, source: conversationSource.value }
  : undefined);
const profileChoices = computed(() => [
  { value: '', label: lazyStrings.ConnectionTab__load_saved_profile(), disabled: true },
  ...(form.value.providerProfiles ?? []).map(profile => ({ value: idToRaw({ id: profile.id }), label: profile.name, detail: endpointTypeLabel({ endpointType: profile.endpoint.type }) })),
]);
const titleSummary = computed(() => !globalTitleGenerationEnabled.value
  ? lazyStrings.ConnectionTab__off()
  : globalTitleModelId.value || lazyStrings.ConnectionTab__conversation_model());

function changeMainEndpoint({ value }: { value: string }): void {
  const type = titleEndpointTypeFromSelectValue({ value });
  switch (type) {
  case 'same_scope': return;
  case 'openai':
  case 'ollama':
  case 'naidan_rpc':
  case 'llama_cpp_browser':
  case 'transformers_js':
  case 'browser_provided_lm':
  case 'unsupported_experimental_endpoint':
    endpointType.value = type;
    return;
  default: {
    const _ex: never = type;
    throw new Error(`Unhandled endpoint choice: ${_ex}`);
  }
  }
}

defineExpose({
  fetchModels,
  ...((__BUILD_MODE_IS_TEST__ && {
    TEST_ONLY: {
      // Export internal state and logic used only for testing here. Do not reference these in production logic.
    },
  }) || {}),
});
</script>

<template>
  <section class="connection-settings" tw-class="flex min-h-0 min-w-0 flex-1 flex-col bg-white text-gray-700 dark:bg-gray-900 dark:text-gray-300">
    <div tw-class="min-h-0 flex-1 overflow-y-auto overscroll-contain">
      <div tw-class="mx-auto w-full max-w-4xl px-5 pb-6 pt-5 sm:px-7 sm:pt-6">
        <div class="connection-toolbar" tw-class="mb-6 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <div v-if="form.providerProfiles?.length" class="connection-profile" tw-class="min-w-0 flex-1">
            <SettingsSelect v-model="selectedProviderProfileId" :options="profileChoices" :label="lazyStrings.ConnectionTab__quick_profile_switcher()" presentation="toolbar" @update:model-value="handleQuickProviderProfileChange" data-testid="setting-quick-provider-profile-select" />
          </div>
          <button type="button" class="connection-text-button" tw-class="ml-auto inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-lg px-2" :title="lazyStrings.ConnectionTab__copy_url_with_current_settings()" @click="copySetupUrl" data-testid="setting-copy-setup-url">
            <CheckIcon v-if="copied" tw-class="h-3.5 w-3.5 shrink-0" /><LinkIcon v-else tw-class="h-3.5 w-3.5 shrink-0" />
            <span class="connection-feedback-label"><span :aria-hidden="copied" :style="{ visibility: copied ? 'hidden' : 'visible' }">{{ lazyStrings.ConnectionTab__copy_setup_url() }}</span><span :aria-hidden="!copied" :style="{ visibility: copied ? 'visible' : 'hidden' }">{{ lazyStrings.ConnectionTab__url_copied() }}</span></span>
          </button>
        </div>

        <div class="connection-setup">
          <div class="connection-provider" tw-class="min-w-0 space-y-2">
            <span class="connection-label">{{ lazyStrings.ConnectionTab__connection() }}</span>
            <SettingsSelect :model-value="endpointType" :options="mainEndpointChoices" :label="lazyStrings.ConnectionTab__api_provider()" @update:model-value="value => changeMainEndpoint({ value })" data-testid="setting-provider-select" />
          </div>
          <div class="connection-model" tw-class="min-w-0 space-y-2" data-testid="connection-model-selection">
            <span class="connection-label">{{ lazyStrings.ConnectionTab__default_model() }}</span>
            <div tw-class="flex min-w-0 items-stretch overflow-hidden rounded-xl border border-gray-200 bg-white dark:border-gray-700/60 dark:bg-gray-800/55">
              <ModelSelector surface="settings" frame="embedded" :model-value="form.defaultModelId" @update:model-value="value => { form.defaultModelId = value; }" :models="sortedModels" :loading="isFetchingModels" :disabled="endpointType === 'browser_provided_lm'" :placeholder="lazyStrings.ConnectionTab__none()" allow-clear :clear-label="lazyStrings.ConnectionTab__none()" @refresh="fetchModels" data-testid="setting-model-select" />
              <router-link v-if="endpointType === 'llama_cpp_browser' || endpointType === 'transformers_js'" :to="{ query: { ...$route?.query, settings: endpointType === 'llama_cpp_browser' ? 'llama-cpp-browser' : 'transformers-js' } }" :title="lazyStrings.ConnectionTab__model_management()" :aria-label="lazyStrings.ConnectionTab__model_management()" tw-class="flex shrink-0 items-center justify-center gap-1.5 border-l border-gray-200 px-3 text-xs font-medium text-gray-600 transition-colors hover:bg-gray-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500/30 dark:border-gray-700/60 dark:text-gray-300 dark:hover:bg-gray-800" data-testid="setting-model-management"><FolderOpenIcon tw-class="h-4 w-4 shrink-0 text-blue-500 dark:text-blue-400" /><span>{{ lazyStrings.ConnectionTab__model_management() }}</span></router-link>
            </div>
            <ReasoningSettings :selected-effort="form.lmParameters?.reasoning.effort" :disabled="mainReasoningDisabled" surface="plain" notice="inline-help" @update:effort="effort => setMainReasoningEffort({ effort })" data-testid="setting-main-reasoning-select" />
            <p tw-class="text-xs leading-5 text-gray-400 dark:text-gray-500">{{ lazyStrings.ConnectionTab__used_for_new_conversations() }}</p>
          </div>
          <div class="connection-details" tw-class="min-w-0 space-y-4">
            <RpcRegistrationSelect v-if="form.endpoint.type === 'naidan_rpc'" v-model="form.endpoint.registrationId" surface="settings" />
            <PromptApiStatus v-if="endpointType === 'browser_provided_lm'" show-ready />
            <template v-if="isHttpEndpoint(form.endpoint)">
              <EndpointPresetButtons :endpoint="form.endpoint" test-id-prefix="endpoint-preset" @apply="preset => applyPreset({ preset })" />
              <div>
                <div tw-class="mb-2 flex min-h-8 items-center justify-between gap-3">
                  <label :for="`${settingsId}-url`" class="connection-field-label">{{ lazyStrings.ConnectionTab__endpoint_url() }}</label>
                  <button type="button" class="connection-text-button" tw-class="inline-flex min-h-8 shrink-0 items-center gap-1.5 disabled:cursor-wait disabled:opacity-50" :disabled="isFetchingModels" :title="lazyStrings.ConnectionTab__check_connection()" @click="fetchModels" data-testid="setting-check-connection"><span tw-class="grid h-3.5 w-3.5 place-items-center"><Loader2Icon v-if="isFetchingModels" tw-class="h-3.5 w-3.5 animate-spin" /><CheckIcon v-else-if="connectionSuccess" tw-class="h-3.5 w-3.5 text-green-600 dark:text-green-400" /><ActivityIcon v-else tw-class="h-3.5 w-3.5" /></span>{{ lazyStrings.ConnectionTab__check_connection() }}</button>
                </div>
                <span v-if="connectionSuccess" role="status" tw-class="sr-only" data-testid="setting-connection-success">{{ lazyStrings.ConnectionTab__connected() }}</span>
                <input :id="`${settingsId}-url`" v-model="endpointUrl" class="connection-input" type="url" :placeholder="endpointUrlPlaceholder({ endpointType })" spellcheck="false" data-testid="setting-url-input" />
                <p tw-class="mt-2 text-xs leading-5 text-gray-400 dark:text-gray-500" data-testid="setting-auto-check-hint">{{ lazyStrings.ConnectionTab__connection_check_for_localhost_only() }}</p>
              </div>
              <HttpHeadersEditor :model-value="endpointHttpHeaders ?? []" @update:model-value="value => endpointHttpHeaders = value" test-id-prefix="setting-http-header" :name-placeholder="lazyStrings.ConnectionTab__header_name_example()" />
            </template>
          </div>
        </div>
        <p v-if="error" role="alert" tw-class="mt-3 text-xs leading-5 text-red-600 dark:text-red-400" data-testid="setting-connection-error">{{ error }}</p>
        <Transition tw-enter-active-class="grid transition-[grid-template-rows,opacity] duration-200 ease-out motion-reduce:transition-none" tw-enter-from-class="grid-rows-[0fr] opacity-0" tw-enter-to-class="grid-rows-[1fr] opacity-100" tw-leave-active-class="grid transition-[grid-template-rows,opacity] duration-150 ease-in motion-reduce:transition-none" tw-leave-from-class="grid-rows-[1fr] opacity-100" tw-leave-to-class="grid-rows-[0fr] opacity-0">
          <div v-if="endpointType === 'ollama'" tw-class="grid" data-testid="ollama-management-transition"><div tw-class="overflow-hidden"><OllamaManagementView presentation="settings" :endpoint-url="endpointUrl" :endpoint-http-headers="endpointHttpHeaders" :fake-lm-debug-mode-status="form.experimental?.fakeLm ?? 'disabled'" /></div></div>
        </Transition>

        <section tw-class="mt-6 border-t border-gray-200/70 pt-5 dark:border-gray-800">
          <label :for="`${settingsId}-prompt`" class="connection-label" tw-class="mb-3">{{ lazyStrings.ConnectionTab__global_system_prompt() }}</label>
          <textarea :id="`${settingsId}-prompt`" v-model="form.systemPrompt" rows="4" class="connection-input connection-prompt" :placeholder="lazyStrings.ConnectionTab__helpful_ai_assistant_placeholder()" data-testid="setting-system-prompt-textarea" />
          <p tw-class="mt-2 text-xs leading-5 text-gray-400 dark:text-gray-500">{{ lazyStrings.ConnectionTab__applied_to_all_new_chats() }}</p>
        </section>
        <div tw-class="mt-5">
          <SettingsDisclosure :title="lazyStrings.ConnectionTab__generation_parameters()" :summary="hasLmParameterOverrides({ lmParameters: form.lmParameters }) ? lazyStrings.ConnectionTab__custom_parameters() : lazyStrings.ConnectionTab__provider_defaults()" test-id="setting-parameters-disclosure"><template #icon><SlidersHorizontalIcon tw-class="h-4 w-4" /></template>
            <fieldset :disabled="endpointType === 'browser_provided_lm'" :inert="endpointType === 'browser_provided_lm'" :tw-class="['min-w-0', endpointType === 'browser_provided_lm' && 'opacity-45']"><LmParametersEditor v-model="form.lmParameters" /></fieldset>
          </SettingsDisclosure>
          <section tw-class="border-t border-gray-200/70 dark:border-gray-800">
            <div tw-class="flex min-h-14 items-center gap-3">
              <button ref="titleTrigger" type="button" :aria-expanded="titleOpen" :aria-controls="titleDetailsId" tw-class="flex min-h-14 min-w-0 flex-1 items-center gap-3 rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/30" @click="titleOpen = !titleOpen" data-testid="setting-title-disclosure"><TypeIcon aria-hidden="true" tw-class="h-4 w-4 shrink-0 text-blue-500 dark:text-blue-400" /><span class="connection-label">{{ lazyStrings.ConnectionTab__auto_title_generation() }}</span><span tw-class="ml-auto min-w-0 truncate text-xs text-gray-500 dark:text-gray-400">{{ titleSummary }}</span><ChevronDownIcon :tw-class="['h-4 w-4 shrink-0 text-gray-400 transition-transform duration-200', titleOpen && 'rotate-180']" /></button>
              <label tw-class="relative inline-flex h-9 w-11 shrink-0 cursor-pointer items-center justify-center rounded-lg focus-within:ring-2 focus-within:ring-blue-500/30"><input type="checkbox" :checked="globalTitleGenerationEnabled" :aria-label="lazyStrings.ConnectionTab__auto_title_generation()" @change="handleGlobalAutoTitleChange({ event: $event })" tw-class="sr-only" data-testid="setting-auto-title-checkbox" /><span :tw-class="['relative block h-5 w-9 rounded-full border transition-colors duration-200 motion-reduce:transition-none', globalTitleGenerationEnabled ? 'border-blue-500 bg-blue-500 hover:border-blue-400 hover:bg-blue-400' : 'border-gray-300/80 bg-gray-100 dark:border-gray-600/70 dark:bg-gray-800/80']"><span :tw-class="['absolute left-0.5 top-0.5 h-3.5 w-3.5 rounded-full transition-transform duration-200 motion-reduce:transition-none', globalTitleGenerationEnabled ? 'translate-x-4 bg-white' : 'bg-gray-400 dark:bg-gray-500']" /></span></label>
            </div>
            <SettingsCollapse :id="titleDetailsId" :open="titleOpen" :return-focus="titleTrigger ?? undefined">
              <fieldset :disabled="!globalTitleGenerationEnabled" :inert="!globalTitleGenerationEnabled" :aria-disabled="!globalTitleGenerationEnabled" :tw-class="['min-w-0 space-y-4 pb-5 pt-1', !globalTitleGenerationEnabled && 'opacity-45']">
                <div class="connection-title-grid">
                  <div tw-class="min-w-0 space-y-2"><span class="connection-field-label">{{ lazyStrings.ConnectionTab__title_endpoint() }}</span><SettingsSelect :model-value="globalTitleEndpointSelectValue" :options="titleEndpointChoices" :label="lazyStrings.ConnectionTab__title_endpoint()" :disabled="!globalTitleGenerationEnabled" @update:model-value="value => setGlobalTitleEndpointType({ endpointType: titleEndpointTypeFromSelectValue({ value }) })" data-testid="setting-title-endpoint-type-select" /></div>
                  <div tw-class="min-w-0 space-y-2"><span class="connection-field-label">{{ lazyStrings.ConnectionTab__title_generation_model() }}</span><ModelSelector surface="settings" :model-value="globalTitleModelId" :inherited-model="titleModelPresentation" @update:model-value="value => setGlobalTitleModelId({ modelId: value })" :models="globalTitleModelOptions" :loading="globalTitleModelLoading" :disabled="!globalTitleGenerationEnabled || globalEffectiveTitleEndpoint.type === 'browser_provided_lm'" :placeholder="globalTitleEndpointUsesSameScope ? lazyStrings.ConnectionTab__conversation_model() : undefined" :allow-clear="globalTitleModelAllowClear" :clear-label="lazyStrings.ConnectionTab__conversation_model()" @refresh="fetchTitleEndpointModels" data-testid="setting-title-model-select" /></div>
                </div>
                <ReasoningSettings :selected-effort="reasoningEffortFromTitleReasoningValue({ value: globalTitleReasoningSelectValue })" :selected-value="globalTitleReasoningSelectValue" :leading-options="globalTitleReasoningLeadingOptions" :heading="lazyStrings.ConnectionTab__title_reasoning()" :disabled="!globalTitleGenerationEnabled" surface="plain" notice="inline-help" @update:value="value => setGlobalTitleReasoningSelectValue({ value: value as TitleReasoningSelectValue })" data-testid="setting-title-reasoning-select" />
                <RpcRegistrationSelect v-if="globalTitleEndpoint !== 'same_scope' && globalTitleEndpoint.type === 'naidan_rpc'" :model-value="globalTitleEndpoint.registrationId" surface="settings" @update:model-value="registrationId => setFormTitleGeneration({ titleGeneration: { endpoint: { type: 'naidan_rpc', registrationId }, model: explicitSettingsTitleModel({ modelId: globalTitleModelId }) } })" />
                <template v-if="!globalTitleEndpointUsesSameScope && isHttpEndpoint(globalEffectiveTitleEndpoint)">
                  <label tw-class="block space-y-2"><span class="connection-field-label">{{ lazyStrings.ConnectionTab__endpoint_url() }}</span><input v-model="globalTitleEndpointUrl" @keyup.enter="($event.target as HTMLInputElement).blur()" type="url" class="connection-input" :placeholder="endpointUrlPlaceholder({ endpointType: globalEffectiveTitleEndpoint.type })" data-testid="setting-title-endpoint-url-input" /></label>
                  <p tw-class="text-xs leading-5 text-gray-400 dark:text-gray-500">{{ lazyStrings.ConnectionTab__connection_check_for_localhost_only() }}</p>
                  <HttpHeadersEditor :model-value="globalTitleEndpointHttpHeaders ?? []" @update:model-value="value => setGlobalTitleEndpointHttpHeaders({ httpHeaders: value })" test-id-prefix="setting-title-http-header" :name-placeholder="lazyStrings.ConnectionTab__header_name_example()" />
                </template>
              </fieldset>
            </SettingsCollapse>
          </section>
        </div>
      </div>
    </div>
    <footer tw-class="shrink-0 border-t border-gray-200/70 bg-white dark:border-gray-800 dark:bg-gray-900">
      <div tw-class="mx-auto flex w-full max-w-4xl flex-wrap items-center justify-end gap-2.5 px-5 py-3.5 sm:px-7">
        <button type="button" class="connection-footer-secondary" @click="handleCreateProviderProfile" data-testid="setting-save-provider-profile-button"><BookmarkPlusIcon tw-class="h-4 w-4 shrink-0 text-gray-400 dark:text-gray-500" /><span>{{ lazyStrings.ConnectionTab__save_as_new_profile() }}</span></button>
        <button type="button" class="connection-footer-primary" :disabled="!hasUnsavedChanges" @click="handleSave" data-testid="setting-save-button"><CheckCircle2Icon v-if="saveSuccess" tw-class="h-4 w-4 shrink-0" /><SaveIcon v-else tw-class="h-4 w-4 shrink-0" /><span class="connection-feedback-label"><span :aria-hidden="saveSuccess" :style="{ visibility: saveSuccess ? 'hidden' : 'visible' }">{{ lazyStrings.ConnectionTab__save_changes() }}</span><span :aria-hidden="!saveSuccess" :style="{ visibility: saveSuccess ? 'visible' : 'hidden' }">{{ lazyStrings.ConnectionTab__settings_saved() }}</span></span></button>
      </div>
    </footer>
  </section>
</template>

<style scoped>
.connection-settings {
  container-type: inline-size;
}
.connection-setup, .connection-title-grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 1.25rem;
}
.connection-provider {
  grid-row: 1;
}
.connection-model {
  grid-row: 2;
}
.connection-details:empty {
  display: none;
}
.connection-profile {
  max-width: 19rem;
}
.connection-label {
  display: block;
  color: #374151;
  font-size: 0.875rem;
  font-weight: 500;
  line-height: 1.25rem;
}
.connection-field-label {
  display: block;
  color: #6b7280;
  font-size: 0.75rem;
  line-height: 1rem;
}
.connection-input {
  width: 100%;
  min-width: 0;
  min-height: 2.75rem;
  border: 1px solid #e5e7eb;
  border-radius: 0.75rem;
  background: #fff;
  padding: 0.625rem 0.875rem;
  color: #1f2937;
  font-size: 0.875rem;
  line-height: 1.5rem;
  outline: none;
  transition: border-color 150ms, box-shadow 150ms;
}
.connection-input:focus-visible {
  border-color: rgb(59 130 246 / 65%);
  box-shadow: 0 0 0 3px rgb(59 130 246 / 10%);
}
.connection-prompt {
  min-height: 7.5rem;
  resize: vertical;
  line-height: 1.65;
}
.connection-text-button {
  border-radius: 0.375rem;
  color: #2563eb;
  font-size: 0.75rem;
  line-height: 1rem;
}
.connection-text-button:hover {
  color: #1d4ed8;
}
.connection-text-button:focus-visible, .connection-footer-secondary:focus-visible, .connection-footer-primary:focus-visible {
  outline: 2px solid rgb(59 130 246 / 45%);
  outline-offset: 2px;
}
.connection-feedback-label {
  display: inline-grid;
}
.connection-feedback-label > span {
  grid-area: 1 / 1;
}
.connection-footer-secondary, .connection-footer-primary {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: 2.75rem;
  gap: 0.625rem;
  border: 1px solid transparent;
  border-radius: 0.75rem;
  padding: 0.625rem 1rem;
  font-size: 0.8125rem;
  font-weight: 500;
  line-height: 1.25rem;
  transition: color 150ms, background 150ms, border-color 150ms;
}
.connection-footer-secondary {
  margin-right: auto;
  border-color: #e5e7eb;
  background: #fff;
  color: #4b5563;
}
.connection-footer-secondary:hover {
  border-color: #d1d5db;
  background: #f9fafb;
}
.connection-footer-primary {
  min-width: 9rem;
  background: #2563eb;
  color: #fff;
}
.connection-footer-primary:hover:enabled {
  background: #1d4ed8;
}
.connection-footer-primary:disabled {
  cursor: default;
  background: #e2eaf5;
  color: #526985;
}
.dark .connection-label {
  color: #e5e7eb;
}
.dark .connection-field-label {
  color: #9ca3af;
}
.dark .connection-input {
  border-color: rgb(55 65 81 / 60%);
  background: rgb(31 41 55 / 55%);
  color: #e5e7eb;
}
.dark .connection-text-button {
  color: #60a5fa;
}
.dark .connection-text-button:hover {
  color: #93c5fd;
}
.dark .connection-footer-secondary {
  border-color: rgb(55 65 81 / 60%);
  background: rgb(31 41 55 / 55%);
  color: #d1d5db;
}
.dark .connection-footer-secondary:hover {
  border-color: #4b5563;
  background: rgb(55 65 81 / 45%);
}
.dark .connection-footer-primary:hover:enabled {
  background: #3b82f6;
}
.dark .connection-footer-primary:disabled {
  background: #253750;
  color: #a5bfdf;
}
@container (min-width: 42rem) {
  .connection-setup {
    grid-template-columns: minmax(0, 5fr) minmax(0, 6fr);
    grid-template-rows: max-content minmax(0, 1fr);
    column-gap: 2rem;
    row-gap: 1rem;
  }
  .connection-provider {
    grid-column: 1;
    grid-row: 1;
  }
  .connection-model {
    grid-column: 2;
    grid-row: 1 / span 2;
  }
  .connection-details {
    grid-column: 1;
    grid-row: 2;
  }
  .connection-title-grid {
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  }
}
@container (max-width: 33rem) {
  .connection-footer-secondary, .connection-footer-primary {
    width: 100%;
    margin-right: 0;
  }
}
@container (max-width: 29rem) {
  .connection-profile {
    flex-basis: 100%;
    max-width: none;
  }
}
@media (min-width: 48rem) {
  .connection-toolbar {
    padding-right: 2.5rem;
  }
}
@media (prefers-reduced-motion: reduce) {
  .connection-input, .connection-text-button, .connection-footer-secondary, .connection-footer-primary {
    transition: none;
  }
}
</style>
