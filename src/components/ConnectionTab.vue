<script setup lang="ts">
import { generateId } from '@/01-models/id';
import { ref, watch, computed, h } from 'vue';
import { useSettings } from '@/composables/useSettings';
import { useToast } from '@/composables/useToast';
import type { Endpoint, EndpointType, LmParameters, ProviderProfile, Reasoning, Settings, SettingsTitleGeneration } from '@/01-models/types';
import { EMPTY_LM_PARAMETERS } from '@/01-models/types';
import { areEndpointModelNamespacesEqual, areEndpointsEqual, cloneEndpoint, isHttpEndpoint, selectHttpEndpointSeed } from '@/01-models/endpoint';
import { naturalSort } from '@/utils/string';
import { cloneLmParameters as clonePlainLmParameters } from '@/utils/lm-parameters';
import {
  Loader2Icon, Trash2Icon, GlobeIcon, BotIcon, TypeIcon, SaveIcon,
  CheckCircle2Icon, BookmarkPlusIcon,
  CheckIcon, ActivityIcon, MessageSquareQuoteIcon, PlusIcon, LinkIcon,
} from 'lucide-vue-next';
import { defineAsyncComponentAndLoadOnMounted } from '@/utils/vue';

// IMPORTANT: ModelSelector is a core part of the connection setup UI and should not flicker.
import ModelSelector from './ModelSelector.vue';
import ReasoningSettings from './ReasoningSettings.vue';
import { endpointTypeLabel } from './endpoint-type-label';

// Lazily load heavier or secondary settings components, but prefetch them when idle.
const LmParametersEditor = defineAsyncComponentAndLoadOnMounted({ loader: () => import('./LmParametersEditor.vue') });
// Lazily load previews that are only shown during specific actions
const ProviderProfilePreview = defineAsyncComponentAndLoadOnMounted({ loader: () => import('./ProviderProfilePreview.vue') });
// Lazily load upsell UI
const TransformersJsUpsell = defineAsyncComponentAndLoadOnMounted({ loader: () => import('@/features/transformers-js/components/TransformersJsUpsell.vue') });
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

const isStandalone = __BUILD_MODE_IS_STANDALONE__;

const form = computed({
  get: () => props.modelValue,
  set: (val) => emit('update:modelValue', val),
});

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
    case 'transformers_js':
      clearBrowserProvidedLmModelIds();
      form.value.endpoint = { type };
      resetModelsWhenEndpointNamespaceChanges({ previousEndpoint, nextEndpoint: form.value.endpoint });
      return;
    case 'browser_provided_lm':
      form.value.endpoint = { type };
      form.value.defaultModelId = BROWSER_PROVIDED_LM_MODEL_ID;
      setFormTitleGeneration({ titleGeneration: { endpoint: 'same_scope', model: 'same_scope', lmParameters: emptyLmParameters() } });
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
    if (!isHttpEndpoint(endpoint)) return;
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
    if (!isHttpEndpoint(endpoint)) return;
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
  if (lmParameters === undefined) return undefined;
  if (lmParameters === 'same_scope') return 'same_scope';
  return clonePlainLmParameters({ lmParameters }) ?? emptyLmParameters();
}

function titleLmParametersForEndpoint({
  endpoint,
  lmParameters,
}: {
  endpoint: Endpoint | 'same_scope',
  lmParameters: 'same_scope' | LmParameters | undefined,
}): 'same_scope' | LmParameters {
  if (endpoint === 'same_scope' && lmParameters === 'same_scope') return 'same_scope';
  return cloneTitleLmParameters({ lmParameters }) as LmParameters | undefined ?? emptyLmParameters();
}

function titleGenerationWithLmParameters({
  titleGeneration,
}: {
  titleGeneration: SettingsTitleGenerationDraft,
}): SettingsTitleGeneration {
  if (titleGeneration === 'disabled') return 'disabled';

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
  if (endpoint === 'same_scope' && lmParameters === 'same_scope') return 'same_scope';
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
    ? lazyStrings.ConnectionTab__use_current_chat_reasoning()
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
  if (titleGeneration === 'disabled' || titleGeneration.endpoint !== 'same_scope' || titleGeneration.model === 'same_scope') return;
  setFormTitleGeneration({ titleGeneration: { endpoint: 'same_scope', model: 'same_scope', lmParameters: emptyLmParameters() } });
}

function resetModelsWhenEndpointNamespaceChanges({
  previousEndpoint,
  nextEndpoint,
}: {
  previousEndpoint: Endpoint,
  nextEndpoint: Endpoint,
}): void {
  if (areEndpointModelNamespacesEqual({ left: previousEndpoint, right: nextEndpoint })) return;
  form.value.defaultModelId = '';
  resetSameScopeTitleModel();
}


function titleModelIdFromSettingsTitleGeneration({
  titleGeneration,
}: {
  titleGeneration: SettingsTitleGeneration,
}): string | undefined {
  if (titleGeneration === 'disabled' || titleGeneration.model === 'same_scope') return undefined;
  return titleGeneration.model.id;
}
const globalTitleGenerationEnabled = computed(() => currentSettingsTitleGeneration() !== 'disabled');

const titleEndpointTypeSelectValueRecord: Readonly<Record<EndpointType, true>> = {
  openai: true,
  ollama: true,
  transformers_js: true,
  browser_provided_lm: true,
};

type TitleEndpointTypeSelectValue = 'same_scope' | Endpoint['type'];

function titleEndpointTypeFromSelectValue({ value }: { value: string }): TitleEndpointTypeSelectValue {
  if (value === 'same_scope') return 'same_scope';
  if (value === 'unsupported_experimental_endpoint') return 'unsupported_experimental_endpoint';
  if (Object.hasOwn(titleEndpointTypeSelectValueRecord, value)) return value as EndpointType;
  throw new Error(`Unhandled title endpoint type value: ${value}`);
}

const globalTitleEndpoint = computed(() => {
  const titleGeneration = currentSettingsTitleGeneration();
  if (titleGeneration === 'disabled') return 'same_scope';
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
    if (titleGeneration === 'disabled' || endpoint === 'same_scope' || !isHttpEndpoint(endpoint)) return;
    setFormTitleGeneration({
      titleGeneration: {
        endpoint: {
          type: endpoint.type,
          url,
          httpHeaders: endpoint.httpHeaders?.map(([name, value]) => [name, value]),
        },
        model: titleGeneration.model === 'same_scope' ? explicitSettingsTitleModel({ modelId: undefined }) : titleGeneration.model
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
  if (titleGeneration === 'disabled' || endpoint === 'same_scope' || !isHttpEndpoint(endpoint)) return;
  setFormTitleGeneration({
    titleGeneration: {
      endpoint: {
        type: endpoint.type,
        url: endpoint.url,
        httpHeaders,
      },
      model: titleGeneration.model === 'same_scope' ? explicitSettingsTitleModel({ modelId: undefined }) : titleGeneration.model
      },
  });
}

function addGlobalTitleHeader(): void {
  const headers = globalTitleEndpointHttpHeaders.value;
  if (headers === undefined) return;
  setGlobalTitleEndpointHttpHeaders({ httpHeaders: [...headers, ['', '']] });
}

function updateGlobalTitleHeader({
  index,
  field,
  value,
}: {
  index: number,
  field: 0 | 1,
  value: string,
}): void {
  const headers = globalTitleEndpointHttpHeaders.value;
  if (headers === undefined) return;
  setGlobalTitleEndpointHttpHeaders({
    httpHeaders: headers.map((header, headerIndex) => headerIndex === index
      ? ([field === 0 ? value : header[0], field === 1 ? value : header[1]] as [string, string])
      : header),
  });
}

function removeGlobalTitleHeader({ index }: { index: number }): void {
  const headers = globalTitleEndpointHttpHeaders.value;
  if (headers === undefined) return;
  setGlobalTitleEndpointHttpHeaders({ httpHeaders: headers.filter((_, headerIndex) => headerIndex !== index) });
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
  if (titleGeneration === 'disabled' || titleGeneration.model === 'same_scope') return undefined;
  return titleGeneration.model.id;
});

const globalTitleReasoningSelectValue = computed<TitleReasoningSelectValue>(() => {
  const titleGeneration = currentSettingsTitleGeneration();
  if (titleGeneration === 'disabled') return undefined;
  return titleReasoningSelectValueFromLmParameters({
    endpoint: titleGeneration.endpoint,
    lmParameters: titleGeneration.lmParameters,
  });
});

function setGlobalTitleReasoningSelectValue({ value }: { value: TitleReasoningSelectValue }): void {
  const titleGeneration = currentSettingsTitleGeneration();
  if (titleGeneration === 'disabled') return;
  if (value === 'same_scope' && titleGeneration.endpoint !== 'same_scope') return;
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
        model: sameScopeSettingsTitleModel({ modelId })
      },
    });
    return;
  case 'browser_provided_lm':
    setFormTitleGeneration({
      titleGeneration: {
        endpoint: { type: 'browser_provided_lm' },
        model: { id: BROWSER_PROVIDED_LM_MODEL_ID }
      },
    });
    return;
  case 'transformers_js':
    setFormTitleGeneration({
      titleGeneration: {
        endpoint: { type: 'transformers_js' },
        model: explicitSettingsTitleModel({ modelId })
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
        model: explicitSettingsTitleModel({ modelId })
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

function handleGlobalTitleEndpointTypeChange({ event }: { event: Event }): void {
  setGlobalTitleEndpointType({ endpointType: titleEndpointTypeFromSelectValue({ value: (event.target as HTMLSelectElement).value }) });
}

function setGlobalTitleModelId({ modelId }: { modelId: string | undefined }): void {
  const titleGeneration = currentSettingsTitleGeneration();
  const endpoint = titleGeneration === 'disabled' ? 'same_scope' : titleGeneration.endpoint;
  if (endpoint === 'same_scope') {
    setFormTitleGeneration({
      titleGeneration: {
        endpoint: 'same_scope',
        model: sameScopeSettingsTitleModel({ modelId })
      },
    });
    return;
  }
  setFormTitleGeneration({
    titleGeneration: {
      endpoint: cloneEndpoint({ endpoint }),
      model: explicitSettingsTitleModel({ modelId })
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
    if (!areEndpointsEqual({ left: endpoint, right: globalEffectiveTitleEndpoint.value })) return;
    if (models.length === 0 && endpoint.type !== 'transformers_js') {
      throw new Error(await ensureStrings.SHARED__no_models_found_at_this_endpoint());
    }
    titleEndpointModels.value = models;
    const titleGeneration = currentSettingsTitleGeneration();
    if (titleGeneration === 'disabled' || titleGeneration.endpoint === 'same_scope') return;
    if (!models.includes(titleGeneration.model.id) && models[0] !== undefined) {
      setFormTitleGeneration({
        titleGeneration: {
          endpoint: cloneEndpoint({ endpoint: titleGeneration.endpoint }),
          model: { id: models[0] }
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
    setFormTitleGeneration({ titleGeneration: { endpoint: 'same_scope', model: 'same_scope', lmParameters: emptyLmParameters() } });
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
  case 'transformers_js':
    // transformers_js doesn't use global-endpoint parameters in this implementation
    break;
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
    defaultModelId:
      form.value.defaultModelId === BROWSER_PROVIDED_LM_MODEL_ID
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
    if (!areEndpointsEqual({ left: requestedEndpoint, right: form.value.endpoint })) return;

    if (models.length === 0 && form.value.endpoint.type !== 'transformers_js') {
      throw new Error(await ensureStrings.SHARED__no_models_found_at_this_endpoint());
    }

    // Validate current selection against new models
    const updatedForm = { ...form.value };
    let changed = false;
    const shouldValidateModelSelection = (() => {
      switch (updatedForm.endpoint.type) {
      case 'openai':
      case 'ollama':
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
        updatedForm.titleGeneration = { endpoint: 'same_scope', model: 'same_scope', lmParameters: emptyLmParameters() };
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
    if (!areEndpointsEqual({ left: requestedEndpoint, right: form.value.endpoint })) return;
    console.error(err);
    error.value = err instanceof Error ? err.message : await ensureStrings.SHARED__connection_failed_check_url_or_provider();
    connectionSuccess.value = false;
  }
}


watch([globalTitleEndpointUrl, globalTitleEndpointSelectValue], ([url, endpointType]) => {
  if (globalTitleGenerationEnabled.value && !globalTitleEndpointUsesSameScope.value) {
    if (endpointType === 'transformers_js' || endpointType === 'browser_provided_lm' || (url && (url.includes('localhost') || url.includes('127.0.0.1')))) {
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

  if (!name) return;

  const newProviderProfile: ProviderProfile = {
    id: generateId<ProviderProfileId>(),
    name,
    endpoint: cloneEndpoint({ endpoint: form.value.endpoint }),
    defaultModelId: form.value.defaultModelId,
    titleModelId: titleModelIdFromSettingsTitleGeneration({ titleGeneration: form.value.titleGeneration }),
    systemPrompt: form.value.systemPrompt,
    lmParameters: form.value.lmParameters ? JSON.parse(JSON.stringify(form.value.lmParameters)) : undefined,
  };

  if (!form.value.providerProfiles) form.value.providerProfiles = [];
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
        ? { endpoint: 'same_scope', model: 'same_scope', lmParameters: emptyLmParameters() }
        : { endpoint: 'same_scope', model: { id: providerProfile.titleModelId }, lmParameters: emptyLmParameters() },
    });
    form.value.systemPrompt = providerProfile.systemPrompt;
    form.value.lmParameters = providerProfile.lmParameters ? JSON.parse(JSON.stringify(providerProfile.lmParameters)) : undefined;
  }
  selectedProviderProfileId.value = '';
}

function addHeader() {
  const endpoint = form.value.endpoint;
  if (!isHttpEndpoint(endpoint)) return;
  endpointHttpHeaders.value = [
    ...(endpoint.httpHeaders ?? []),
    ['', ''],
  ];
}

function removeHeader({ index }: { index: number }) {
  const headers = endpointHttpHeaders.value;
  if (headers === undefined) return;
  endpointHttpHeaders.value = headers.filter((_, headerIndex) => headerIndex !== index);
}

// Auto-fetch for localhost or transformers_js
watch([endpointUrl, endpointType], ([url, type]) => {
  if (
    type === 'transformers_js'
    || type === 'browser_provided_lm'
    || (url && (url.includes('localhost') || url.includes('127.0.0.1')))
  ) {
    fetchModels();
  }
});

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
  <div tw-class="flex-1 flex flex-col min-h-0">
    <div tw-class="flex-1 overflow-y-auto min-h-0 overscroll-contain">
      <div tw-class="p-6 md:p-12 space-y-12 max-w-4xl mx-auto">
        <div class="animate-in fade-in slide-in-from-bottom-2" tw-class="space-y-10 duration-400">

          <!-- Quick Switcher (If profiles exist) -->
          <div v-if="form.providerProfiles && form.providerProfiles.length > 0" tw-class="bg-blue-50/50 dark:bg-blue-900/10 border border-blue-100 dark:border-blue-900/30 p-5 rounded-2xl space-y-3 shadow-sm">
            <label tw-class="block text-[10px] font-bold text-blue-600 dark:text-blue-400 uppercase tracking-widest ml-1">{{ lazyStrings.ConnectionTab__quick_profile_switcher() }}</label>
            <div tw-class="flex gap-2">
              <select
                v-model="selectedProviderProfileId"
                @change="handleQuickProviderProfileChange"
                tw-class="flex-1 bg-white dark:bg-gray-800 border border-blue-200 dark:border-blue-800 rounded-xl px-4 py-2.5 text-xs font-bold text-gray-800 focus:ring-4 focus:ring-blue-500/10 outline-none transition-all dark:text-white appearance-none shadow-sm"
                style="background-image: url('data:image/svg+xml;charset=US-ASCII,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%2224%22%20height%3D%2224%22%20viewBox%3D%220%200%2024%2024%20fill%3D%22none%22%20stroke%3D%22currentColor%22%20stroke-width%3D%222%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%3E%3Cpolyline%20points%3D%226%209%2012%2015%2018%209%22%3E%3C%2Fpolyline%3E%3C%2Fsvg%3E'); background-repeat: no-repeat; background-position: right 1rem center; background-size: 1.2em;"
                data-testid="setting-quick-provider-profile-select"
              >
                <option value="" disabled>{{ lazyStrings.ConnectionTab__load_saved_profile() }}</option>
                <option v-for="p in form.providerProfiles" :key="idToRaw({ id: p.id })" :value="idToRaw({ id: p.id })">{{ p.name }} ({{ endpointTypeLabel({ endpointType: p.endpoint.type }) }})</option>
              </select>
            </div>
          </div>

          <section tw-class="space-y-6">
            <div tw-class="flex items-center justify-between pb-3 border-b border-gray-100 dark:border-gray-800">
              <div tw-class="flex items-center gap-2">
                <GlobeIcon tw-class="w-5 h-5 text-blue-500" />
                <h2 tw-class="text-lg font-bold text-gray-800 dark:text-white tracking-tight">{{ lazyStrings.ConnectionTab__endpoint_configuration() }}</h2>
              </div>
              <button
                @click="copySetupUrl"
                tw-class="flex items-center gap-1.5 px-3 py-1.5 text-[10px] font-bold text-blue-600 hover:text-blue-700 bg-blue-50/50 dark:bg-blue-900/10 hover:bg-blue-100 dark:hover:bg-blue-900/20 rounded-lg transition-all border border-blue-100/50 dark:border-blue-900/30"
                :title="lazyStrings.ConnectionTab__copy_url_with_current_settings()"
                data-testid="setting-copy-setup-url"
              >
                <CheckIcon v-if="copied" tw-class="w-3 h-3" />
                <LinkIcon v-else tw-class="w-3 h-3" />
                <span>{{ copied ? lazyStrings.ConnectionTab__url_copied() : lazyStrings.ConnectionTab__copy_setup_url() }}</span>
              </button>
            </div>

            <div tw-class="grid grid-cols-1 gap-8">
              <div tw-class="space-y-2">
                <label tw-class="block text-xs font-bold text-gray-400 uppercase tracking-widest ml-1">{{ lazyStrings.ConnectionTab__api_provider() }}</label>
                <select
                  v-model="endpointType"
                  tw-class="w-full bg-gray-50 dark:bg-gray-800 border border-gray-100 dark:border-gray-700 rounded-xl px-4 py-3.5 text-sm font-bold text-gray-800 focus:ring-4 focus:ring-blue-500/10 outline-none transition-all dark:text-white appearance-none shadow-sm"
                  style="background-image: url('data:image/svg+xml;charset=US-ASCII,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%2224%22%20height%3D%2224%22%20viewBox%3D%220%200%2024%2024%20fill%3D%22none%22%20stroke%3D%22currentColor%22%20stroke-width%3D%222%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%3E%3Cpolyline%20points%3D%226%209%2012%2015%2018%209%22%3E%3C%2Fpolyline%3E%3C%2Fsvg%3E'); background-repeat: no-repeat; background-position: right 1rem center; background-size: 1.2em;"
                  data-testid="setting-provider-select"
                >
                  <option value="openai">{{ lazyStrings.ConnectionTab__openai_compatible() }}</option>
                  <option value="ollama">{{ lazyStrings.ConnectionTab__ollama() }}</option>
                  <option :disabled="isStandalone" value="transformers_js">
                    {{ lazyStrings.ConnectionTab__transformers_js_experimental() }} {{ isStandalone ? lazyStrings.ConnectionTab__unavailable_in_standalone_due_to_worker_wasm_restrictions() : '' }}
                  </option>
                  <option value="browser_provided_lm" :tw-class="{ 'text-gray-400': !isPromptApiSupported }">
                    {{ lazyStrings.SHARED__browser_provided() }}
                  </option>
                  <option
                    v-if="endpointType === 'unsupported_experimental_endpoint'"
                    value="unsupported_experimental_endpoint"
                    disabled
                  >{{ lazyStrings.SHARED__unsupported_experimental_endpoint() }}</option>
                </select>
                <PromptApiStatus v-if="endpointType === 'browser_provided_lm'" show-ready tw-class="mt-3" />
              </div>

              <!-- Endpoint URL -->
              <div tw-class="space-y-4" v-if="isHttpEndpoint(form.endpoint)">
                <div tw-class="flex items-center justify-between ml-1">
                  <label tw-class="block text-xs font-bold text-gray-400 uppercase tracking-widest">{{ lazyStrings.ConnectionTab__endpoint_url() }}</label>
                  <div tw-class="flex flex-wrap gap-1.5">
                    <button
                      v-for="preset in ENDPOINT_PRESETS"
                      :key="preset.name"
                      @click="applyPreset({ preset })"
                      type="button"
                      :tw-class="['px-3 py-1 text-[10px] font-bold rounded-lg border transition-all', endpointUrl === preset.url && endpointType === preset.type ? 'bg-blue-600 border-blue-600 text-white shadow-lg shadow-blue-500/20' : 'bg-white dark:bg-gray-800 border-gray-100 dark:border-gray-700 text-gray-500 hover:border-blue-200 dark:hover:border-gray-600']"
                      :data-testid="`endpoint-preset-${preset.name.toLowerCase().replace(/[^a-z0-9]/g, '-')}`"
                    >
                      {{ preset.name }}
                    </button>
                  </div>
                </div>
                <div tw-class="flex gap-2">
                  <input
                    v-model="endpointUrl"
                    type="text"
                    tw-class="flex-1 bg-gray-50 dark:bg-gray-800 border border-gray-100 dark:border-gray-700 rounded-xl px-4 py-3.5 text-sm font-bold text-gray-800 focus:ring-4 focus:ring-blue-500/10 outline-none transition-all dark:text-white shadow-sm"
                    placeholder="http://localhost:11434"
                    data-testid="setting-url-input"
                  />
                  <button
                    @click="fetchModels"
                    :tw-class="['px-6 py-2 rounded-xl transition-all flex items-center justify-center gap-2 min-w-[180px] disabled:opacity-70 shadow-sm',
                                connectionSuccess
                                  ? 'bg-green-50 dark:bg-green-900/30 text-green-600 dark:text-green-400 border border-green-100 dark:border-green-800'
                                  : 'bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700 text-gray-600 dark:text-gray-300 border border-gray-200 dark:border-gray-700'
                    ]"
                    :title="lazyStrings.ConnectionTab__check_connection()"
                    :disabled="isFetchingModels"
                    data-testid="setting-check-connection"
                  >
                    <span tw-class="relative w-4 h-4 flex items-center justify-center">
                      <Loader2Icon v-if="isFetchingModels" tw-class="w-4 h-4 animate-spin absolute" />
                      <CheckIcon v-else-if="connectionSuccess" class="animate-in zoom-in" tw-class="w-4 h-4 text-green-600 dark:text-green-400 duration-300" />
                      <ActivityIcon v-else tw-class="w-4 h-4" />
                    </span>
                    <span tw-class="text-xs font-bold">{{ connectionSuccess ? lazyStrings.ConnectionTab__connected() : lazyStrings.ConnectionTab__check_connection() }}</span>
                  </button>
                </div>
                <!-- Info message about auto-connection check -->
                <div tw-class="flex items-start gap-3 p-4 bg-blue-50/50 dark:bg-blue-900/10 text-blue-700/80 dark:text-blue-300/80 rounded-2xl text-[11px] font-medium border border-blue-100 dark:border-blue-900/20 ml-1">
                  <GlobeIcon tw-class="w-4 h-4 shrink-0 mt-0.5" />
                  <p>{{ lazyStrings.ConnectionTab__connection_check_for_localhost_only() }}</p>
                </div>
                <!-- Error message container -->
                <div v-if="error" tw-class="mt-2">
                  <p class="animate-in fade-in slide-in-from-top-1" tw-class="text-xs text-red-500 font-bold ml-1 duration-200 leading-relaxed">{{ error }}</p>
                </div>
              </div>

              <!-- Custom HTTP Headers -->
              <div v-if="isHttpEndpoint(form.endpoint)" tw-class="space-y-4">
                <div tw-class="flex items-center justify-between ml-1">
                  <label tw-class="block text-xs font-bold text-gray-400 uppercase tracking-widest">{{ lazyStrings.ConnectionTab__custom_http_headers() }}</label>
                  <button
                    @click="addHeader"
                    type="button"
                    tw-class="text-[10px] font-bold text-blue-600 hover:text-blue-700 transition-colors flex items-center gap-1"
                  >
                    <PlusIcon tw-class="w-3 h-3" />
                    {{ lazyStrings.ConnectionTab__add_header() }}
                  </button>
                </div>

                <div v-if="endpointHttpHeaders && endpointHttpHeaders.length > 0" tw-class="space-y-2">
                  <div
                    v-for="(header, index) in endpointHttpHeaders"
                    :key="index"
                    class="animate-in fade-in slide-in-from-left-1" tw-class="flex gap-2 duration-200"
                  >
                    <input
                      v-model="header[0]"
                      type="text"
                      tw-class="flex-1 bg-gray-50 dark:bg-gray-800 border border-gray-100 dark:border-gray-700 rounded-xl px-4 py-2 text-xs font-bold text-gray-800 focus:ring-4 focus:ring-blue-500/10 outline-none transition-all dark:text-white shadow-sm"
                      :placeholder="lazyStrings.ConnectionTab__header_name_example()"
                    />
                    <input
                      v-model="header[1]"
                      type="text"
                      tw-class="flex-1 bg-gray-50 dark:bg-gray-800 border border-gray-100 dark:border-gray-700 rounded-xl px-4 py-2 text-xs font-bold text-gray-800 focus:ring-4 focus:ring-blue-500/10 outline-none transition-all dark:text-white shadow-sm"
                      :placeholder="lazyStrings.ConnectionTab__value()"
                    />
                    <button
                      @click="removeHeader({ index })"
                      tw-class="p-2 text-gray-400 hover:text-red-500 transition-colors"
                    >
                      <Trash2Icon tw-class="w-4 h-4" />
                    </button>
                  </div>
                </div>
                <div v-else tw-class="text-[11px] text-gray-400 italic ml-1">{{ lazyStrings.ConnectionTab__no_custom_headers() }}</div>
              </div>
            </div>

            <Transition
              tw-enter-active-class="grid transition-[grid-template-rows,opacity] duration-200 ease-out motion-reduce:transition-none"
              tw-enter-from-class="grid-rows-[0fr] opacity-0"
              tw-enter-to-class="grid-rows-[1fr] opacity-100"
              tw-leave-active-class="grid transition-[grid-template-rows,opacity] duration-150 ease-in motion-reduce:transition-none"
              tw-leave-from-class="grid-rows-[1fr] opacity-100"
              tw-leave-to-class="grid-rows-[0fr] opacity-0"
            >
              <div v-if="endpointType === 'ollama'" tw-class="grid" data-testid="ollama-management-transition">
                <div tw-class="overflow-hidden">
                  <OllamaManagementView
                    :endpoint-url="endpointUrl"
                    :endpoint-http-headers="endpointHttpHeaders"
                    :fake-lm-debug-mode-status="form.experimental?.fakeLm ?? 'disabled'"
                  />
                </div>
              </div>
            </Transition>
          </section>

          <section data-testid="connection-model-selection" tw-class="space-y-6 pt-6 border-t border-gray-100 dark:border-gray-800">
            <div tw-class="flex items-center gap-2 pb-3 border-b border-gray-100 dark:border-gray-800">
              <BotIcon tw-class="w-5 h-5 text-blue-500" />
              <h2 tw-class="text-lg font-bold text-gray-800 dark:text-white tracking-tight">{{ lazyStrings.ConnectionTab__model_selection() }}</h2>
            </div>

            <div tw-class="space-y-8">
              <div tw-class="space-y-2">
                <label tw-class="block text-xs font-bold text-gray-400 uppercase tracking-widest ml-1">{{ lazyStrings.ConnectionTab__default_model() }}</label>
                <ModelSelector
                  :model-value="form.defaultModelId"
                  @update:model-value="value => { form.defaultModelId = value; }"
                  :models="sortedModels"
                  :loading="isFetchingModels"
                  :disabled="endpointType === 'browser_provided_lm'"
                  :placeholder="lazyStrings.ConnectionTab__none()"
                  allow-clear
                  :clear-label="lazyStrings.ConnectionTab__none()"
                  @refresh="fetchModels"
                  data-testid="setting-model-select"
                />
                <TransformersJsUpsell :show="endpointType === 'transformers_js'" />
                <p tw-class="text-[11px] font-medium text-gray-400 ml-1">{{ lazyStrings.ConnectionTab__used_for_new_conversations() }}</p>
              </div>

              <div tw-class="bg-gray-50/50 dark:bg-gray-800/30 p-6 rounded-3xl border border-gray-100 dark:border-gray-800 space-y-5 shadow-sm">
                <div tw-class="flex items-center justify-between">
                  <div tw-class="flex items-center gap-3">
                    <div tw-class="p-2 bg-white dark:bg-gray-800 rounded-lg shadow-sm border border-gray-100 dark:border-gray-700">
                      <TypeIcon tw-class="w-4 h-4 text-blue-500" />
                    </div>
                    <span tw-class="text-sm font-bold text-gray-700 dark:text-gray-300">{{ lazyStrings.ConnectionTab__auto_title_generation() }}</span>
                  </div>
                  <label tw-class="relative inline-flex items-center cursor-pointer">
                    <input
                      type="checkbox"
                      :checked="globalTitleGenerationEnabled"
                      @change="handleGlobalAutoTitleChange({ event: $event })"
                      tw-class="sr-only peer"
                      data-testid="setting-auto-title-checkbox"
                    >
                    <div tw-class="w-10 h-6 bg-gray-200 peer-focus:outline-none rounded-full peer dark:bg-gray-700 peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[4px] after:start-[4px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all dark:border-gray-600 peer-checked:bg-blue-600"></div>
                  </label>
                </div>

                <div :tw-class="['grid grid-cols-1 md:grid-cols-2 gap-4 opacity-50 transition-all duration-300', { 'opacity-100': globalTitleGenerationEnabled }]">
                  <div tw-class="space-y-2">
                    <label tw-class="block text-xs font-bold text-gray-400 uppercase tracking-widest ml-1">{{ lazyStrings.ConnectionTab__title_endpoint() }}</label>
                    <select
                      :value="globalTitleEndpointSelectValue"
                      @change="handleGlobalTitleEndpointTypeChange({ event: $event })"
                      :disabled="!globalTitleGenerationEnabled"
                      tw-class="w-full text-sm font-bold bg-white dark:bg-gray-800 border border-gray-100 dark:border-gray-700 rounded-xl px-4 py-3 text-gray-800 focus:ring-4 focus:ring-blue-500/10 outline-none transition-all dark:text-white appearance-none shadow-sm"
                      data-testid="setting-title-endpoint-type-select"
                    >
                      <option value="same_scope">{{ lazyStrings.ConnectionTab__use_current_chat_endpoint() }}</option>
                      <option
                        v-if="globalTitleEndpointSelectValue === 'unsupported_experimental_endpoint'"
                        value="unsupported_experimental_endpoint"
                        disabled
                      >{{ lazyStrings.SHARED__unsupported_experimental_endpoint() }}</option>
                      <option value="openai">{{ lazyStrings.ConnectionTab__openai_compatible() }}</option>
                      <option value="ollama">{{ lazyStrings.ConnectionTab__ollama() }}</option>
                      <option value="transformers_js">{{ lazyStrings.ConnectionTab__transformers_js_experimental() }}</option>
                      <option value="browser_provided_lm">{{ lazyStrings.SHARED__browser_provided() }}</option>
                    </select>
                  </div>

                  <div v-if="!globalTitleEndpointUsesSameScope && isHttpEndpoint(globalEffectiveTitleEndpoint)" tw-class="space-y-2">
                    <label tw-class="block text-xs font-bold text-gray-400 uppercase tracking-widest ml-1">{{ lazyStrings.ConnectionTab__endpoint_url() }}</label>
                    <input
                      v-model="globalTitleEndpointUrl"
                      @keyup.enter="(e) => (e.target as HTMLInputElement).blur()"
                      type="text"
                      tw-class="w-full text-sm font-bold bg-white dark:bg-gray-800 border border-gray-100 dark:border-gray-700 rounded-xl px-4 py-3 text-gray-800 focus:ring-4 focus:ring-blue-500/10 outline-none transition-all dark:text-white shadow-sm"
                      placeholder="http://localhost:11434"
                      data-testid="setting-title-endpoint-url-input"
                    />
                  </div>

                  <div v-if="!globalTitleEndpointUsesSameScope && isHttpEndpoint(globalEffectiveTitleEndpoint)" tw-class="space-y-3 md:col-span-2">
                    <div tw-class="flex items-center justify-between ml-1">
                      <label tw-class="block text-xs font-bold text-gray-400 uppercase tracking-widest">{{ lazyStrings.ConnectionTab__custom_http_headers() }}</label>
                      <button
                        @click="addGlobalTitleHeader"
                        type="button"
                        :disabled="!globalTitleGenerationEnabled"
                        tw-class="text-[10px] font-bold text-blue-600 hover:text-blue-700 disabled:text-gray-400 transition-colors flex items-center gap-1"
                      >
                        <PlusIcon tw-class="w-3 h-3" />
                        {{ lazyStrings.ConnectionTab__add_header() }}
                      </button>
                    </div>

                    <div v-if="globalTitleEndpointHttpHeaders && globalTitleEndpointHttpHeaders.length > 0" tw-class="space-y-2">
                      <div
                        v-for="(header, index) in globalTitleEndpointHttpHeaders"
                        :key="index"
                        class="animate-in fade-in slide-in-from-left-1" tw-class="flex gap-2 duration-200"
                      >
                        <input
                          :value="header[0]"
                          @input="updateGlobalTitleHeader({ index, field: 0, value: ($event.target as HTMLInputElement).value })"
                          type="text"
                          tw-class="flex-1 bg-white dark:bg-gray-800 border border-gray-100 dark:border-gray-700 rounded-xl px-4 py-2 text-xs font-bold text-gray-800 focus:ring-4 focus:ring-blue-500/10 outline-none transition-all dark:text-white shadow-sm disabled:opacity-50"
                          :placeholder="lazyStrings.ConnectionTab__header_name_example()"
                          :disabled="!globalTitleGenerationEnabled"
                          data-testid="setting-title-http-header-name-input"
                        />
                        <input
                          :value="header[1]"
                          @input="updateGlobalTitleHeader({ index, field: 1, value: ($event.target as HTMLInputElement).value })"
                          type="text"
                          tw-class="flex-1 bg-white dark:bg-gray-800 border border-gray-100 dark:border-gray-700 rounded-xl px-4 py-2 text-xs font-bold text-gray-800 focus:ring-4 focus:ring-blue-500/10 outline-none transition-all dark:text-white shadow-sm disabled:opacity-50"
                          :placeholder="lazyStrings.ConnectionTab__value()"
                          :disabled="!globalTitleGenerationEnabled"
                          data-testid="setting-title-http-header-value-input"
                        />
                        <button
                          @click="removeGlobalTitleHeader({ index })"
                          :disabled="!globalTitleGenerationEnabled"
                          tw-class="p-2 text-gray-400 hover:text-red-500 disabled:hover:text-gray-400 transition-colors"
                          data-testid="setting-title-http-header-remove-button"
                        >
                          <Trash2Icon tw-class="w-4 h-4" />
                        </button>
                      </div>
                    </div>
                    <div v-else tw-class="text-[11px] text-gray-400 italic ml-1">{{ lazyStrings.ConnectionTab__no_custom_headers() }}</div>
                  </div>

                  <div tw-class="space-y-2 md:col-span-2">
                    <label tw-class="block text-xs font-bold text-gray-400 uppercase tracking-widest ml-1">{{ lazyStrings.ConnectionTab__title_generation_model() }}</label>
                    <ModelSelector
                      :model-value="globalTitleModelId"
                      @update:model-value="value => setGlobalTitleModelId({ modelId: value })"
                      :models="globalTitleModelOptions"
                      :loading="globalTitleModelLoading"
                      :disabled="!globalTitleGenerationEnabled || globalEffectiveTitleEndpoint.type === 'browser_provided_lm'"
                      :placeholder="globalTitleEndpointUsesSameScope ? lazyStrings.ConnectionTab__use_current_chat_model() : undefined"
                      :allow-clear="globalTitleModelAllowClear"
                      :clear-label="lazyStrings.ConnectionTab__use_current_chat_model()"
                      @refresh="fetchTitleEndpointModels"
                      data-testid="setting-title-model-select"
                    />
                  </div>


                  <div tw-class="md:col-span-2">
                    <ReasoningSettings
                      :selected-effort="reasoningEffortFromTitleReasoningValue({ value: globalTitleReasoningSelectValue })"
                      :selected-value="globalTitleReasoningSelectValue"
                      :leading-options="globalTitleReasoningLeadingOptions"
                      :heading="lazyStrings.ConnectionTab__title_reasoning()"
                      :disabled="!globalTitleGenerationEnabled"
                      surface="card"
                      @update:value="value => setGlobalTitleReasoningSelectValue({ value: value as TitleReasoningSelectValue })"
                      data-testid="setting-title-reasoning-select"
                    />
                  </div>
                </div>
              </div>
            </div>
          </section>

          <section tw-class="space-y-6 pt-6 border-t border-gray-100 dark:border-gray-800">
            <div tw-class="flex items-center gap-2 pb-3">
              <MessageSquareQuoteIcon tw-class="w-5 h-5 text-blue-500" />
              <h2 tw-class="text-lg font-bold text-gray-800 dark:text-white tracking-tight">{{ lazyStrings.ConnectionTab__global_context_and_parameters() }}</h2>
            </div>

            <div tw-class="space-y-8">
              <!-- System Prompt -->
              <div tw-class="space-y-2">
                <label tw-class="block text-xs font-bold text-gray-400 uppercase tracking-widest ml-1">{{ lazyStrings.ConnectionTab__global_system_prompt() }}</label>
                <textarea
                  v-model="form.systemPrompt"
                  rows="4"
                  tw-class="w-full bg-gray-50 dark:bg-gray-800 border border-gray-100 dark:border-gray-700 rounded-xl px-4 py-3 text-sm font-medium text-gray-800 focus:ring-4 focus:ring-blue-500/10 outline-none transition-all dark:text-white shadow-sm resize-none"
                  :placeholder="lazyStrings.ConnectionTab__helpful_ai_assistant_placeholder()"
                  data-testid="setting-system-prompt-textarea"
                ></textarea>
                <p tw-class="text-[10px] font-medium text-gray-400 ml-1 leading-relaxed">{{ lazyStrings.ConnectionTab__applied_to_all_new_chats() }}</p>
              </div>

              <!-- LM Parameters -->
              <fieldset
                :disabled="endpointType === 'browser_provided_lm'"
                :tw-class="['bg-gray-50/30 dark:bg-gray-800/20 p-6 rounded-3xl border border-gray-100 dark:border-gray-800', { 'opacity-50': endpointType === 'browser_provided_lm' }]"
              >
                <LmParametersEditor v-model="form.lmParameters" />
              </fieldset>
            </div>
          </section>
        </div>
      </div>
    </div>

    <!-- Footer Actions -->
    <div tw-class="p-4 md:p-8 border-t border-gray-100 dark:border-gray-800 flex flex-col sm:flex-row justify-end gap-3 md:gap-4 bg-gray-50/50 dark:bg-gray-900/50 backdrop-blur-sm shrink-0">
      <button
        @click="handleCreateProviderProfile"
        tw-class="flex items-center justify-center gap-2 py-2.5 px-4 md:py-3 md:px-6 bg-white dark:bg-gray-800 hover:bg-gray-50 dark:hover:bg-gray-700 border border-gray-200 dark:border-gray-700 text-gray-700 dark:text-gray-200 rounded-xl md:rounded-2xl text-xs md:text-sm font-bold transition-all shadow-sm active:scale-95"
        data-testid="setting-save-provider-profile-button"
      >
        <BookmarkPlusIcon tw-class="w-4 h-4" />
        <span>{{ lazyStrings.ConnectionTab__save_as_new_profile() }}</span>
      </button>

      <button
        @click="handleSave"
        :disabled="!hasUnsavedChanges"
        tw-class="flex items-center justify-center gap-2 py-2.5 px-4 md:py-3 md:px-10 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed text-white text-xs md:text-sm font-bold rounded-xl md:rounded-2xl shadow-lg shadow-blue-500/30 transition-all active:scale-95"
        data-testid="setting-save-button"
      >
        <CheckCircle2Icon v-if="saveSuccess" tw-class="w-4 h-4" />
        <SaveIcon v-else tw-class="w-4 h-4" />
        <span>{{ saveSuccess ? lazyStrings.ConnectionTab__settings_saved() : lazyStrings.ConnectionTab__save_changes() }}</span>
      </button>
    </div>
  </div>
</template>
