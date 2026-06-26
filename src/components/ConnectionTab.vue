<script setup lang="ts">
import { generateId } from '@/utils/id';
import { ref, watch, computed, h } from 'vue';
import { useSettings } from '@/composables/useSettings';
import { useToast } from '@/composables/useToast';
import type { ProviderProfile, Settings } from '@/models/types';
import { capitalize, naturalSort } from '@/utils/string';
import {
  Loader2Icon, Trash2Icon, GlobeIcon, BotIcon, TypeIcon, SaveIcon,
  CheckCircle2Icon, BookmarkPlusIcon,
  CheckIcon, ActivityIcon, MessageSquareQuoteIcon, PlusIcon, LinkIcon,
} from 'lucide-vue-next';
import { defineAsyncComponentAndLoadOnMounted } from '@/utils/vue';

// IMPORTANT: ModelSelector is a core part of the connection setup UI and should not flicker.
import ModelSelector from './ModelSelector.vue';

// Lazily load heavier or secondary settings components, but prefetch them when idle.
const LmParametersEditor = defineAsyncComponentAndLoadOnMounted({ loader: () => import('./LmParametersEditor.vue') });
// Lazily load previews that are only shown during specific actions
const ProviderProfilePreview = defineAsyncComponentAndLoadOnMounted({ loader: () => import('./ProviderProfilePreview.vue') });
// Lazily load upsell UI
const TransformersJsUpsell = defineAsyncComponentAndLoadOnMounted({ loader: () => import('./TransformersJsUpsell.vue') });
const OllamaManagementView = defineAsyncComponentAndLoadOnMounted({ loader: () => import('./OllamaManagementView.vue') });

import { useConfirm } from '@/composables/useConfirm';
import { usePrompt } from '@/composables/usePrompt';
import { ENDPOINT_PRESETS } from '@/models/constants';
import { idToRaw } from '@/models/ids';
import type { ProviderProfileId } from '@/models/ids';
import { lazyStrings, ensureStrings } from '@/strings';

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

const { save, fetchModels: fetchModelsGlobal, updateProviderProfiles } = useSettings();
const { showConfirm } = useConfirm();
const { showPrompt } = usePrompt();
const { addToast } = useToast();

const isStandalone = __BUILD_MODE_IS_STANDALONE__;

const form = computed({
  get: () => props.modelValue,
  set: (val) => emit('update:modelValue', val),
});

const connectionSuccess = ref(false);

const error = ref<string | null>(null);

const saveSuccess = ref(false);

const selectedProviderProfileId = ref('');

const copied = ref(false);

async function copySetupUrl() {
  const baseUrl = window.location.origin + window.location.pathname;
  const params = new URLSearchParams();

  if (form.value.storageType) {
    params.set('storage-type', form.value.storageType);
  }

  const type = form.value.endpointType;
  switch (type) {
  case 'openai':
  case 'ollama':
    params.set('global-endpoint-type', type);
    if (form.value.endpointUrl) {
      params.set('global-endpoint-url', form.value.endpointUrl);
    }
    break;
  case 'transformers_js':
    // transformers_js doesn't use global-endpoint parameters in this implementation
    break;
  default: {
    const _ex: never = type;
    throw new Error(`Unhandled endpoint type: ${_ex}`);
  }
  }

  if (form.value.defaultModelId) {
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
  form.value = {
    ...form.value,
    endpointType: preset.type,
    endpointUrl: preset.url,
  };
}

async function fetchModels() {
  if (!form.value.endpointUrl && form.value.endpointType !== 'transformers_js') {
    return;
  }

  error.value = null;
  try {
    const url = form.value.endpointUrl || '';
    // Trigger global fetch with current form values (may be unsaved)
    const models = await fetchModelsGlobal({ overrides: {
      url,
      type: form.value.endpointType,
      headers: form.value.endpointHttpHeaders,
    } });

    if (models.length === 0 && form.value.endpointType !== 'transformers_js') {
      throw new Error(await ensureStrings.SHARED__no_models_found_at_this_endpoint());
    }

    // Validate current selection against new models
    const updatedForm = { ...form.value };
    let changed = false;
    if (updatedForm.defaultModelId && !models.includes(updatedForm.defaultModelId)) {
      updatedForm.defaultModelId = '';
      changed = true;
    }
    if (updatedForm.titleModelId && !models.includes(updatedForm.titleModelId)) {
      updatedForm.titleModelId = '';
      changed = true;
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
    console.error(err);
    error.value = err instanceof Error ? err.message : await ensureStrings.SHARED__connection_failed_check_url_or_provider();
    connectionSuccess.value = false;
  }
}

async function handleSave() {
  try {
    await save({ patch: {
      endpointType: form.value.endpointType,
      endpointUrl: form.value.endpointUrl,
      endpointHttpHeaders: form.value.endpointHttpHeaders,
      defaultModelId: form.value.defaultModelId,
      titleModelId: form.value.titleModelId,
      autoTitleEnabled: form.value.autoTitleEnabled,
      systemPrompt: form.value.systemPrompt,
      lmParameters: form.value.lmParameters,
    } });

    emit('save');
    saveSuccess.value = true;
    setTimeout(() => {
      saveSuccess.value = false;
    }, 2000);
  } catch (err) {
    console.error('Failed to save settings:', err);
    const [title, message, confirmButtonText] = await Promise.all([
      ensureStrings.ConnectionTab__save_failed(),
      ensureStrings.ConnectionTab__failed_to_save_settings({ errorMessage: err instanceof Error ? err.message : String(err) }),
      ensureStrings.ConnectionTab__understand(),
    ]);
    await showConfirm({ title, message, confirmButtonText });
  }
}

async function handleCreateProviderProfile() {
  const [title, message, defaultLabel, confirmButtonText] = await Promise.all([
    ensureStrings.ConnectionTab__create_new_profile(),
    ensureStrings.ConnectionTab__give_configuration_a_name(),
    ensureStrings.ConnectionTab__default(),
    ensureStrings.ConnectionTab__create(),
  ]);
  const name = await showPrompt({
    title,
    message,
    defaultValue: `${capitalize({ value: form.value.endpointType })} - ${form.value.defaultModelId || defaultLabel}`,
    confirmButtonText,
    bodyComponent: h(ProviderProfilePreview, { form: form.value }),
  });

  if (!name) return;

  const newProviderProfile: ProviderProfile = {
    id: generateId<ProviderProfileId>(),
    name,
    endpointType: form.value.endpointType,
    endpointUrl: form.value.endpointUrl,
    endpointHttpHeaders: form.value.endpointHttpHeaders ? JSON.parse(JSON.stringify(form.value.endpointHttpHeaders)) : undefined,
    defaultModelId: form.value.defaultModelId,
    titleModelId: form.value.titleModelId,
    systemPrompt: form.value.systemPrompt,
    lmParameters: form.value.lmParameters ? JSON.parse(JSON.stringify(form.value.lmParameters)) : undefined,
  };

  if (!form.value.providerProfiles) form.value.providerProfiles = [];
  form.value.providerProfiles.push(newProviderProfile);
  await updateProviderProfiles({ profiles: JSON.parse(JSON.stringify(form.value.providerProfiles)) });

  const [profileCreatedMessage, actionLabel] = await Promise.all([
    ensureStrings.ConnectionTab__profile_created({ profileName: name }),
    ensureStrings.ConnectionTab__view_profiles(),
  ]);
  addToast({
    message: profileCreatedMessage,
    actionLabel,
    onAction: () => emit('goToProfiles'),
    duration: 5000,
  });
}

function handleQuickProviderProfileChange() {
  const providerProfile = form.value.providerProfiles?.find(p => idToRaw({ id: p.id }) === selectedProviderProfileId.value);
  if (providerProfile) {
    form.value.endpointType = providerProfile.endpointType;
    form.value.endpointUrl = providerProfile.endpointUrl;
    form.value.endpointHttpHeaders = providerProfile.endpointHttpHeaders ? JSON.parse(JSON.stringify(providerProfile.endpointHttpHeaders)) : undefined;
    form.value.defaultModelId = providerProfile.defaultModelId;
    form.value.titleModelId = providerProfile.titleModelId;
    form.value.systemPrompt = providerProfile.systemPrompt;
    form.value.lmParameters = providerProfile.lmParameters ? JSON.parse(JSON.stringify(providerProfile.lmParameters)) : undefined;
  }
  selectedProviderProfileId.value = '';
}

function addHeader() {
  if (!form.value.endpointHttpHeaders) form.value.endpointHttpHeaders = [];
  form.value.endpointHttpHeaders.push(['', '']);
}

function removeHeader({ index }: { index: number }) {
  if (form.value.endpointHttpHeaders) {
    form.value.endpointHttpHeaders.splice(index, 1);
  }
}

// Auto-fetch for localhost or transformers_js
watch([() => form.value.endpointUrl, () => form.value.endpointType], ([url, type]) => {
  if (type === 'transformers_js' || (url && (url.includes('localhost') || url.includes('127.0.0.1')))) {
    fetchModels();
  }
});

defineExpose({
  fetchModels,
  TEST_ONLY: {
    // Export internal state and logic used only for testing here. Do not reference these in production logic.
  },
});
</script>

<template>
  <div class="flex-1 flex flex-col min-h-0">
    <div class="flex-1 overflow-y-auto min-h-0 overscroll-contain">
      <div class="p-6 md:p-12 space-y-12 max-w-4xl mx-auto">
        <div class="space-y-10 animate-in fade-in slide-in-from-bottom-2 duration-400">

          <!-- Quick Switcher (If profiles exist) -->
          <div v-if="form.providerProfiles && form.providerProfiles.length > 0" class="bg-blue-50/50 dark:bg-blue-900/10 border border-blue-100 dark:border-blue-900/30 p-5 rounded-2xl space-y-3 shadow-sm">
            <label class="block text-[10px] font-bold text-blue-600 dark:text-blue-400 uppercase tracking-widest ml-1">{{ lazyStrings.ConnectionTab__quick_profile_switcher() }}</label>
            <div class="flex gap-2">
              <select
                v-model="selectedProviderProfileId"
                @change="handleQuickProviderProfileChange"
                class="flex-1 bg-white dark:bg-gray-800 border border-blue-200 dark:border-blue-800 rounded-xl px-4 py-2.5 text-xs font-bold text-gray-800 focus:ring-4 focus:ring-blue-500/10 outline-none transition-all dark:text-white appearance-none shadow-sm"
                style="background-image: url('data:image/svg+xml;charset=US-ASCII,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%2224%22%20height%3D%2224%22%20viewBox%3D%220%200%2024%2024%20fill%3D%22none%22%20stroke%3D%22currentColor%22%20stroke-width%3D%222%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%3E%3Cpolyline%20points%3D%226%209%2012%2015%2018%209%22%3E%3C%2Fpolyline%3E%3C%2Fsvg%3E'); background-repeat: no-repeat; background-position: right 1rem center; background-size: 1.2em;"
                data-testid="setting-quick-provider-profile-select"
              >
                <option value="" disabled>{{ lazyStrings.ConnectionTab__load_saved_profile() }}</option>
                <option v-for="p in form.providerProfiles" :key="idToRaw({ id: p.id })" :value="idToRaw({ id: p.id })">{{ p.name }} ({{ capitalize({ value: p.endpointType }) }})</option>
              </select>
            </div>
          </div>

          <section class="space-y-6">
            <div class="flex items-center justify-between pb-3 border-b border-gray-100 dark:border-gray-800">
              <div class="flex items-center gap-2">
                <GlobeIcon class="w-5 h-5 text-blue-500" />
                <h2 class="text-lg font-bold text-gray-800 dark:text-white tracking-tight">{{ lazyStrings.ConnectionTab__endpoint_configuration() }}</h2>
              </div>
              <button
                @click="copySetupUrl"
                class="flex items-center gap-1.5 px-3 py-1.5 text-[10px] font-bold text-blue-600 hover:text-blue-700 bg-blue-50/50 dark:bg-blue-900/10 hover:bg-blue-100 dark:hover:bg-blue-900/20 rounded-lg transition-all border border-blue-100/50 dark:border-blue-900/30"
                :title="lazyStrings.ConnectionTab__copy_url_with_current_settings()"
                data-testid="setting-copy-setup-url"
              >
                <CheckIcon v-if="copied" class="w-3 h-3" />
                <LinkIcon v-else class="w-3 h-3" />
                <span>{{ copied ? lazyStrings.ConnectionTab__url_copied() : lazyStrings.ConnectionTab__copy_setup_url() }}</span>
              </button>
            </div>

            <div class="grid grid-cols-1 gap-8">
              <div class="space-y-2">
                <label class="block text-xs font-bold text-gray-400 uppercase tracking-widest ml-1">{{ lazyStrings.ConnectionTab__api_provider() }}</label>
                <select
                  v-model="form.endpointType"
                  class="w-full bg-gray-50 dark:bg-gray-800 border border-gray-100 dark:border-gray-700 rounded-xl px-4 py-3.5 text-sm font-bold text-gray-800 focus:ring-4 focus:ring-blue-500/10 outline-none transition-all dark:text-white appearance-none shadow-sm"
                  style="background-image: url('data:image/svg+xml;charset=US-ASCII,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%2224%22%20height%3D%2224%22%20viewBox%3D%220%200%2024%2024%20fill%3D%22none%22%20stroke%3D%22currentColor%22%20stroke-width%3D%222%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%3E%3Cpolyline%20points%3D%226%209%2012%2015%2018%209%22%3E%3C%2Fpolyline%3E%3C%2Fsvg%3E'); background-repeat: no-repeat; background-position: right 1rem center; background-size: 1.2em;"
                  data-testid="setting-provider-select"
                >
                  <option value="openai">{{ lazyStrings.ConnectionTab__openai_compatible() }}</option>
                  <option value="ollama">{{ lazyStrings.ConnectionTab__ollama() }}</option>
                  <option :disabled="isStandalone" value="transformers_js">
                    {{ lazyStrings.ConnectionTab__transformers_js_experimental() }} {{ isStandalone ? lazyStrings.ConnectionTab__unavailable_in_standalone_due_to_worker_wasm_restrictions() : '' }}
                  </option>
                </select>
              </div>

              <!-- Endpoint URL -->
              <div class="space-y-4" v-if="form.endpointType !== 'transformers_js'">
                <div class="flex items-center justify-between ml-1">
                  <label class="block text-xs font-bold text-gray-400 uppercase tracking-widest">{{ lazyStrings.ConnectionTab__endpoint_url() }}</label>
                  <div class="flex flex-wrap gap-1.5">
                    <button
                      v-for="preset in ENDPOINT_PRESETS"
                      :key="preset.name"
                      @click="applyPreset({ preset })"
                      type="button"
                      class="px-3 py-1 text-[10px] font-bold rounded-lg border transition-all"
                      :class="form.endpointUrl === preset.url && form.endpointType === preset.type ? 'bg-blue-600 border-blue-600 text-white shadow-lg shadow-blue-500/20' : 'bg-white dark:bg-gray-800 border-gray-100 dark:border-gray-700 text-gray-500 hover:border-blue-200 dark:hover:border-gray-600'"
                      :data-testid="`endpoint-preset-${preset.name.toLowerCase().replace(/[^a-z0-9]/g, '-')}`"
                    >
                      {{ preset.name }}
                    </button>
                  </div>
                </div>
                <div class="flex gap-2">
                  <input
                    v-model="form.endpointUrl"
                    type="text"
                    class="flex-1 bg-gray-50 dark:bg-gray-800 border border-gray-100 dark:border-gray-700 rounded-xl px-4 py-3.5 text-sm font-bold text-gray-800 focus:ring-4 focus:ring-blue-500/10 outline-none transition-all dark:text-white shadow-sm"
                    placeholder="http://localhost:11434"
                    data-testid="setting-url-input"
                  />
                  <button
                    @click="fetchModels"
                    class="px-6 py-2 rounded-xl transition-all flex items-center justify-center gap-2 min-w-[180px] disabled:opacity-70 shadow-sm"
                    :class="[
                      connectionSuccess
                        ? 'bg-green-50 dark:bg-green-900/30 text-green-600 dark:text-green-400 border border-green-100 dark:border-green-800'
                        : 'bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700 text-gray-600 dark:text-gray-300 border border-gray-200 dark:border-gray-700'
                    ]"
                    :title="lazyStrings.ConnectionTab__check_connection()"
                    :disabled="isFetchingModels"
                    data-testid="setting-check-connection"
                  >
                    <span class="relative w-4 h-4 flex items-center justify-center">
                      <Loader2Icon v-if="isFetchingModels" class="w-4 h-4 animate-spin absolute" />
                      <CheckIcon v-else-if="connectionSuccess" class="w-4 h-4 text-green-600 dark:text-green-400 animate-in zoom-in duration-300" />
                      <ActivityIcon v-else class="w-4 h-4" />
                    </span>
                    <span class="text-xs font-bold">{{ connectionSuccess ? lazyStrings.ConnectionTab__connected() : lazyStrings.ConnectionTab__check_connection() }}</span>
                  </button>
                </div>
                <!-- Info message about auto-connection check -->
                <div class="flex items-start gap-3 p-4 bg-blue-50/50 dark:bg-blue-900/10 text-blue-700/80 dark:text-blue-300/80 rounded-2xl text-[11px] font-medium border border-blue-100 dark:border-blue-900/20 ml-1">
                  <GlobeIcon class="w-4 h-4 shrink-0 mt-0.5" />
                  <p>{{ lazyStrings.ConnectionTab__connection_check_for_localhost_only() }}</p>
                </div>
                <!-- Error message container -->
                <div v-if="error" class="mt-2">
                  <p class="text-xs text-red-500 font-bold ml-1 animate-in fade-in slide-in-from-top-1 duration-200 leading-relaxed">{{ error }}</p>
                </div>
              </div>

              <!-- Custom HTTP Headers -->
              <div class="space-y-4">
                <div class="flex items-center justify-between ml-1">
                  <label class="block text-xs font-bold text-gray-400 uppercase tracking-widest">{{ lazyStrings.ConnectionTab__custom_http_headers() }}</label>
                  <button
                    @click="addHeader"
                    type="button"
                    class="text-[10px] font-bold text-blue-600 hover:text-blue-700 transition-colors flex items-center gap-1"
                  >
                    <PlusIcon class="w-3 h-3" />
                    {{ lazyStrings.ConnectionTab__add_header() }}
                  </button>
                </div>

                <div v-if="form.endpointHttpHeaders && form.endpointHttpHeaders.length > 0" class="space-y-2">
                  <div
                    v-for="(header, index) in form.endpointHttpHeaders"
                    :key="index"
                    class="flex gap-2 animate-in fade-in slide-in-from-left-1 duration-200"
                  >
                    <input
                      v-model="header[0]"
                      type="text"
                      class="flex-1 bg-gray-50 dark:bg-gray-800 border border-gray-100 dark:border-gray-700 rounded-xl px-4 py-2 text-xs font-bold text-gray-800 focus:ring-4 focus:ring-blue-500/10 outline-none transition-all dark:text-white shadow-sm"
                      :placeholder="lazyStrings.ConnectionTab__header_name_example()"
                    />
                    <input
                      v-model="header[1]"
                      type="text"
                      class="flex-1 bg-gray-50 dark:bg-gray-800 border border-gray-100 dark:border-gray-700 rounded-xl px-4 py-2 text-xs font-bold text-gray-800 focus:ring-4 focus:ring-blue-500/10 outline-none transition-all dark:text-white shadow-sm"
                      :placeholder="lazyStrings.ConnectionTab__value()"
                    />
                    <button
                      @click="removeHeader({ index })"
                      class="p-2 text-gray-400 hover:text-red-500 transition-colors"
                    >
                      <Trash2Icon class="w-4 h-4" />
                    </button>
                  </div>
                </div>
                <div v-else class="text-[11px] text-gray-400 italic ml-1">{{ lazyStrings.ConnectionTab__no_custom_headers() }}</div>
              </div>
            </div>

            <Transition
              enter-active-class="grid transition-[grid-template-rows,opacity] duration-200 ease-out motion-reduce:transition-none"
              enter-from-class="grid-rows-[0fr] opacity-0"
              enter-to-class="grid-rows-[1fr] opacity-100"
              leave-active-class="grid transition-[grid-template-rows,opacity] duration-150 ease-in motion-reduce:transition-none"
              leave-from-class="grid-rows-[1fr] opacity-100"
              leave-to-class="grid-rows-[0fr] opacity-0"
            >
              <div v-if="form.endpointType === 'ollama'" class="grid" data-testid="ollama-management-transition">
                <div class="overflow-hidden">
                  <OllamaManagementView
                    :endpoint-url="form.endpointUrl"
                    :endpoint-http-headers="form.endpointHttpHeaders"
                    :fake-lm-debug-mode-status="form.experimental?.fakeLm ?? 'disabled'"
                  />
                </div>
              </div>
            </Transition>
          </section>

          <section data-testid="connection-model-selection" class="space-y-6 pt-6 border-t border-gray-100 dark:border-gray-800">
            <div class="flex items-center gap-2 pb-3 border-b border-gray-100 dark:border-gray-800">
              <BotIcon class="w-5 h-5 text-blue-500" />
              <h2 class="text-lg font-bold text-gray-800 dark:text-white tracking-tight">{{ lazyStrings.ConnectionTab__model_selection() }}</h2>
            </div>

            <div class="space-y-8">
              <div class="space-y-2">
                <label class="block text-xs font-bold text-gray-400 uppercase tracking-widest ml-1">{{ lazyStrings.ConnectionTab__default_model() }}</label>
                <ModelSelector
                  v-model="form.defaultModelId"
                  :models="sortedModels"
                  :loading="isFetchingModels"
                  :placeholder="lazyStrings.ConnectionTab__none()"
                  allow-clear
                  :clear-label="lazyStrings.ConnectionTab__none()"
                  @refresh="fetchModels"
                  data-testid="setting-model-select"
                />
                <TransformersJsUpsell :show="form.endpointType === 'transformers_js'" />
                <p class="text-[11px] font-medium text-gray-400 ml-1">{{ lazyStrings.ConnectionTab__used_for_new_conversations() }}</p>
              </div>

              <div class="bg-gray-50/50 dark:bg-gray-800/30 p-6 rounded-3xl border border-gray-100 dark:border-gray-800 space-y-5 shadow-sm">
                <div class="flex items-center justify-between">
                  <div class="flex items-center gap-3">
                    <div class="p-2 bg-white dark:bg-gray-800 rounded-lg shadow-sm border border-gray-100 dark:border-gray-700">
                      <TypeIcon class="w-4 h-4 text-blue-500" />
                    </div>
                    <span class="text-sm font-bold text-gray-700 dark:text-gray-300">{{ lazyStrings.ConnectionTab__auto_title_generation() }}</span>
                  </div>
                  <label class="relative inline-flex items-center cursor-pointer">
                    <input
                      type="checkbox"
                      v-model="form.autoTitleEnabled"
                      class="sr-only peer"
                      data-testid="setting-auto-title-checkbox"
                    >
                    <div class="w-10 h-6 bg-gray-200 peer-focus:outline-none rounded-full peer dark:bg-gray-700 peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[4px] after:start-[4px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all dark:border-gray-600 peer-checked:bg-blue-600"></div>
                  </label>
                </div>

                <div class="space-y-2 opacity-50 transition-all duration-300" :class="{ 'opacity-100': form.autoTitleEnabled }">
                  <label class="block text-xs font-bold text-gray-400 uppercase tracking-widest ml-1">{{ lazyStrings.ConnectionTab__title_generation_model() }}</label>
                  <ModelSelector
                    v-model="form.titleModelId"
                    :models="sortedModels"
                    :loading="isFetchingModels"
                    :disabled="!form.autoTitleEnabled"
                    :placeholder="lazyStrings.ConnectionTab__use_current_chat_model()"
                    allow-clear
                    :clear-label="lazyStrings.ConnectionTab__use_current_chat_model()"
                    @refresh="fetchModels"
                    data-testid="setting-title-model-select"
                  />
                </div>
              </div>
            </div>
          </section>

          <section class="space-y-6 pt-6 border-t border-gray-100 dark:border-gray-800">
            <div class="flex items-center gap-2 pb-3">
              <MessageSquareQuoteIcon class="w-5 h-5 text-blue-500" />
              <h2 class="text-lg font-bold text-gray-800 dark:text-white tracking-tight">{{ lazyStrings.ConnectionTab__global_context_and_parameters() }}</h2>
            </div>

            <div class="space-y-8">
              <!-- System Prompt -->
              <div class="space-y-2">
                <label class="block text-xs font-bold text-gray-400 uppercase tracking-widest ml-1">{{ lazyStrings.ConnectionTab__global_system_prompt() }}</label>
                <textarea
                  v-model="form.systemPrompt"
                  rows="4"
                  class="w-full bg-gray-50 dark:bg-gray-800 border border-gray-100 dark:border-gray-700 rounded-xl px-4 py-3 text-sm font-medium text-gray-800 focus:ring-4 focus:ring-blue-500/10 outline-none transition-all dark:text-white shadow-sm resize-none"
                  :placeholder="lazyStrings.ConnectionTab__helpful_ai_assistant_placeholder()"
                  data-testid="setting-system-prompt-textarea"
                ></textarea>
                <p class="text-[10px] font-medium text-gray-400 ml-1 leading-relaxed">{{ lazyStrings.ConnectionTab__applied_to_all_new_chats() }}</p>
              </div>

              <!-- LM Parameters -->
              <div class="bg-gray-50/30 dark:bg-gray-800/20 p-6 rounded-3xl border border-gray-100 dark:border-gray-800">
                <LmParametersEditor v-model="form.lmParameters" />
              </div>
            </div>
          </section>
        </div>
      </div>
    </div>

    <!-- Footer Actions -->
    <div class="p-4 md:p-8 border-t border-gray-100 dark:border-gray-800 flex flex-col sm:flex-row justify-end gap-3 md:gap-4 bg-gray-50/50 dark:bg-gray-900/50 backdrop-blur-sm shrink-0">
      <button
        @click="handleCreateProviderProfile"
        class="flex items-center justify-center gap-2 py-2.5 px-4 md:py-3 md:px-6 bg-white dark:bg-gray-800 hover:bg-gray-50 dark:hover:bg-gray-700 border border-gray-200 dark:border-gray-700 text-gray-700 dark:text-gray-200 rounded-xl md:rounded-2xl text-xs md:text-sm font-bold transition-all shadow-sm active:scale-95"
        data-testid="setting-save-provider-profile-button"
      >
        <BookmarkPlusIcon class="w-4 h-4" />
        <span>{{ lazyStrings.ConnectionTab__save_as_new_profile() }}</span>
      </button>

      <button
        @click="handleSave"
        :disabled="!hasUnsavedChanges"
        class="flex items-center justify-center gap-2 py-2.5 px-4 md:py-3 md:px-10 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed text-white text-xs md:text-sm font-bold rounded-xl md:rounded-2xl shadow-lg shadow-blue-500/30 transition-all active:scale-95"
        data-testid="setting-save-button"
      >
        <CheckCircle2Icon v-if="saveSuccess" class="w-4 h-4" />
        <SaveIcon v-else class="w-4 h-4" />
        <span>{{ saveSuccess ? lazyStrings.ConnectionTab__settings_saved() : lazyStrings.ConnectionTab__save_changes() }}</span>
      </button>
    </div>
  </div>
</template>
