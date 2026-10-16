<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, shallowRef, useId, watch } from 'vue';
import { ChevronDownIcon, PowerOffIcon, SlidersHorizontalIcon } from 'lucide-vue-next';
import { lazyStrings } from '@/strings';
import { useSettings } from '@/composables/useSettings';
import { llamaCppBrowserService } from '@/features/llama-cpp-browser';
import { selectableProfiles } from '@/features/llama-cpp-browser/runtime/profile-policy';
import { chatContextTokensSchema, defaultChatContextTokens, minimumChatContextTokens, maximumChatContextTokens, errorCode, runtimeOptionsSchema } from '@/features/llama-cpp-browser/types';
import { resolveProfilePreference, type ProfileCapabilities, type ProfileState, type ProfileUnavailableReason } from '@/features/llama-cpp-browser/runtime/profile-capabilities';

const props = defineProps<{ disabled: boolean, releaseDisabled: boolean }>();
const emit = defineEmits<{ runtimeReady: [ready: boolean] }>();
const id = useId();
const profileState = shallowRef<ProfileState>(llamaCppBrowserService.getProfileState());
const options = ref(llamaCppBrowserService.getOptions());
const { settings, initialized, captureExperimentalStorage, updateExperimentalForStorage } = useSettings();
const storedContextTokens = computed(() => settings.value.experimental?.llamaCppBrowser?.contextTokens);
const contextTokensDraft = ref<number | string>(storedContextTokens.value ?? defaultChatContextTokens);
const contextSaving = ref(false);
const contextSaveFailed = ref(false);
const contextTokensValid = computed(() => chatContextTokensSchema.safeParse(contextTokensDraft.value).success);
const contextDisabled = computed(() => props.disabled || contextSaving.value || !initialized.value);
watch([storedContextTokens, () => settings.value.storageType], () => {
  contextTokensDraft.value = storedContextTokens.value ?? defaultChatContextTokens;
  contextSaveFailed.value = false;
});
let disposed = false;
const profileLabels = {
  'webgpu-wasm64-jspi': 'WebGPU / wasm64',
  'webgpu-wasm32-jspi': 'WebGPU / wasm32 / JSPI',
  'webgpu-wasm32-asyncify': 'WebGPU / wasm32 / Asyncify',
  'cpu-wasm64': 'CPU / wasm64',
  'cpu-wasm32': 'CPU / wasm32',
} satisfies Record<Exclude<typeof options.value.profile, 'auto'>, string>;
const profileFeatures = {
  wasm: 'WebAssembly',
  memory64: 'WebAssembly memory64',
  jspi: 'WebAssembly JSPI',
  webgpu: 'WebGPU',
  'shader-f16': 'WebGPU shader-f16',
  brotli: 'Brotli',
  storage: 'OPFS',
  worker: 'Worker',
} satisfies Record<ProfileUnavailableReason, string>;
const capabilities = computed(() => {
  const current = profileState.value;
  switch (current.status) {
  case 'ready': return current.capabilities;
  case 'idle': case 'checking': case 'error': return undefined;
  default: {
    const exhaustive: never = current;
    throw new Error(`Unhandled profile state: ${exhaustive}`);
  }
  }
});
const selectedProfile = computed(() => resolveProfilePreference({ preference: options.value.profile, capabilities: capabilities.value }));
const runtimeReady = computed(() => capabilities.value?.profiles.some(entry => entry.profile === selectedProfile.value && entry.status === 'available') === true);

function failureReason({ entry }: { entry: ProfileCapabilities['profiles'][number] | undefined }): ProfileUnavailableReason | undefined {
  if (!entry) {
    return undefined;
  }
  switch (entry.status) {
  case 'unavailable': return entry.reason;
  case 'available': return undefined;
  default: {
    const exhaustive: never = entry;
    throw new Error(`Unhandled profile availability: ${exhaustive}`);
  }
  }
}

const selectedFailure = computed(() => failureReason({ entry: capabilities.value?.profiles.find(entry => entry.profile === selectedProfile.value) }));
watch(runtimeReady, ready => emit('runtimeReady', ready), { immediate: true });

function profileDisabled({ profile }: { profile: typeof options.value.profile }): boolean {
  const resolved = resolveProfilePreference({ preference: profile, capabilities: capabilities.value });
  return !capabilities.value?.profiles.some(entry => entry.profile === resolved && entry.status === 'available');
}

const profileChoices = computed(() => {
  const labels = {
    ...profileLabels,
    auto: lazyStrings.llamaCppBrowser__automatic_profile({ profile: capabilities.value?.recommended === undefined ? undefined : profileLabels[capabilities.value.recommended] }),
  };
  return selectableProfiles.map(profile => {
    const reason = failureReason({ entry: capabilities.value?.profiles.find(entry => entry.profile === profile) });
    return {
      profile,
      label: labels[profile],
      disabled: profileDisabled({ profile }),
      reason: reason === undefined ? undefined : lazyStrings.llamaCppBrowser__unavailable_feature({ feature: profileFeatures[reason] }),
    };
  });
});
let profileController: AbortController | undefined;
let unsubscribeProfiles: (() => void) | undefined;

async function probeProfiles(): Promise<void> {
  profileController?.abort();
  const controller = new AbortController();
  profileController = controller;
  try {
    await llamaCppBrowserService.probeProfiles({ signal: controller.signal });
  } catch (error) {
    if (!disposed && !controller.signal.aborted) {
      profileState.value = { status: 'error', code: errorCode({ error }) };
    }
  }
}

function applyOptions(): void {
  const parsed = runtimeOptionsSchema.safeParse(options.value);
  if (parsed.success && !profileDisabled({ profile: parsed.data.profile })) {
    llamaCppBrowserService.setOptions({ options: parsed.data });
  }
}

async function saveContextTokens({ value }: { value: number | string | undefined }): Promise<void> {
  if (contextDisabled.value) {
    return;
  }
  const parsed = chatContextTokensSchema.safeParse(value ?? defaultChatContextTokens);
  if (!parsed.success) {
    return;
  }
  const contextTokens = value === undefined ? undefined : parsed.data;
  contextSaving.value = true;
  contextSaveFailed.value = false;
  try {
    const isCurrent = captureExperimentalStorage();
    const outcome = await updateExperimentalForStorage({
      isCurrent,
      updater: ({ experimental }) => ({
        ...experimental,
        llamaCppBrowser: { ...experimental?.llamaCppBrowser, contextTokens },
      }),
    });
    switch (outcome) {
    case 'saved': case 'changed':
      contextTokensDraft.value = storedContextTokens.value ?? defaultChatContextTokens;
      break;
    default: {
      const exhaustive: never = outcome;
      throw new Error(String(exhaustive));
    }
    }
  } catch {
    contextSaveFailed.value = true;
  } finally {
    contextSaving.value = false;
  }
}

function releaseRuntime(): void {
  if (!props.releaseDisabled) {
    llamaCppBrowserService.release();
  }
}

onMounted(() => {
  unsubscribeProfiles = llamaCppBrowserService.subscribeProfiles({
    listener: ({ state: next }) => {
      profileState.value = next;
    },
  });
  void probeProfiles();
});
onUnmounted(() => {
  disposed = true;
  profileController?.abort();
  unsubscribeProfiles?.();
  emit('runtimeReady', false);
});
defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>
<template>
  <section tw-class="rounded-2xl border border-gray-100 dark:border-gray-800 bg-gray-50/50 dark:bg-gray-800/20 p-5 space-y-4">
    <h3 tw-class="flex items-center gap-2 text-sm font-bold text-gray-800 dark:text-white"><SlidersHorizontalIcon tw-class="w-4 h-4 text-blue-500" />{{ lazyStrings.llamaCppBrowser__inference_settings() }}</h3>
    <fieldset :disabled="disabled" tw-class="grid grid-cols-1 sm:grid-cols-2 gap-4 disabled:opacity-50">
      <div tw-class="space-y-2">
        <label :for="`${id}-profile`" tw-class="block text-xs font-bold text-gray-500 dark:text-gray-400">{{ lazyStrings.llamaCppBrowser__profile() }}</label>
        <div tw-class="relative"><select :id="`${id}-profile`" v-model="options.profile" :disabled="profileState.status === 'checking'" data-testid="llama-cpp-browser-profile" tw-class="appearance-none block w-full pl-3 pr-9 py-3 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-sm font-medium text-gray-800 dark:text-gray-100 focus:ring-4 focus:ring-blue-500/10 outline-none transition-all" @change="applyOptions">
          <option v-for="choice in profileChoices" :key="choice.profile" :value="choice.profile" :disabled="choice.disabled">{{ choice.label }}<template v-if="choice.reason"> — {{ choice.reason }}</template></option>
        </select><ChevronDownIcon tw-class="w-4 h-4 absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none" /></div>
      </div>
      <div tw-class="space-y-2">
        <label :for="`${id}-context-tokens`" tw-class="block text-xs font-bold text-gray-500 dark:text-gray-400">{{ lazyStrings.LlamaCppBrowserRuntimeSettings__context_size_tokens() }}</label>
        <input :id="`${id}-context-tokens`" v-model.number="contextTokensDraft" type="number" :min="minimumChatContextTokens" :max="maximumChatContextTokens" step="1" required :disabled="contextDisabled" :aria-invalid="!contextTokensValid || undefined" :aria-describedby="`${id}-context-description${contextTokensValid ? '' : ` ${id}-context-invalid`}${contextSaveFailed ? ` ${id}-context-save-failed` : ''}`" data-testid="llama-cpp-browser-context-tokens" tw-class="block w-full px-3 py-3 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-sm font-medium text-gray-800 dark:text-gray-100 focus:ring-4 focus:ring-blue-500/10 outline-none transition-all disabled:opacity-50" @input="contextSaveFailed = false" />
        <div tw-class="flex flex-wrap items-center gap-3">
          <button type="button" :disabled="contextDisabled || !contextTokensValid" data-testid="llama-cpp-browser-context-save" tw-class="px-3 py-2 rounded-xl bg-blue-600 text-xs font-bold text-white hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed" @click="saveContextTokens({ value: contextTokensDraft })">{{ lazyStrings.LlamaCppBrowserRuntimeSettings__save() }}</button>
          <button type="button" :disabled="contextDisabled" data-testid="llama-cpp-browser-context-reset" tw-class="text-xs text-blue-600 dark:text-blue-400 disabled:opacity-50 disabled:cursor-not-allowed" @click="saveContextTokens({ value: undefined })">{{ lazyStrings.LlamaCppBrowserRuntimeSettings__reset_to_default() }}</button>
        </div>
        <p :id="`${id}-context-description`" tw-class="text-xs leading-relaxed text-gray-500 dark:text-gray-400">{{ lazyStrings.LlamaCppBrowserRuntimeSettings__context_size_applies_to_all_chats() }}</p>
        <p v-if="!contextTokensValid" :id="`${id}-context-invalid`" role="alert" data-testid="llama-cpp-browser-context-invalid" tw-class="text-xs text-red-600 dark:text-red-400">{{ lazyStrings.LlamaCppBrowserRuntimeSettings__enter_a_whole_number_from_minimum_to_maximum({ minimum: minimumChatContextTokens, maximum: maximumChatContextTokens }) }}</p>
        <p v-if="contextSaveFailed" :id="`${id}-context-save-failed`" role="alert" data-testid="llama-cpp-browser-context-save-failed" tw-class="text-xs text-red-600 dark:text-red-400">{{ lazyStrings.LlamaCppBrowserRuntimeSettings__could_not_save_context_size() }}</p>
      </div>
    </fieldset>
    <p v-if="profileState.status === 'checking'" role="status" data-testid="llama-cpp-browser-profile-checking" tw-class="text-xs text-gray-500 dark:text-gray-400">{{ lazyStrings.llamaCppBrowser__checking_browser_support() }}</p>
    <p v-else-if="profileState.status === 'ready' && selectedProfile === undefined" role="status" tw-class="text-xs text-amber-600 dark:text-amber-400">{{ lazyStrings.llamaCppBrowser__no_compatible_runtime() }}</p>
    <p v-else-if="selectedFailure" role="status" data-testid="llama-cpp-browser-profile-unavailable" tw-class="text-xs text-amber-600 dark:text-amber-400">{{ lazyStrings.llamaCppBrowser__unavailable_feature({ feature: profileFeatures[selectedFailure] }) }}</p>
    <p v-else-if="profileState.status === 'error'" role="alert" tw-class="text-xs text-red-500">{{ lazyStrings.llamaCppBrowser__operation_failed() }}</p>
    <button v-if="profileState.status !== 'checking' && !runtimeReady" type="button" data-testid="llama-cpp-browser-probe-profiles" tw-class="text-xs text-blue-600 dark:text-blue-400" @click="probeProfiles">{{ lazyStrings.llamaCppBrowser__check_browser_support() }}</button>
    <div tw-class="flex flex-col sm:flex-row sm:items-center gap-3 pt-3 border-t border-gray-100 dark:border-gray-800"><p tw-class="text-xs text-gray-500 dark:text-gray-400 flex-1">{{ lazyStrings.llamaCppBrowser__image_chat_requires_matching_projector() }}</p><button type="button" :disabled="releaseDisabled" data-testid="llama-cpp-browser-release" tw-class="inline-flex items-center justify-center gap-2 px-3 py-2 text-xs font-bold rounded-xl text-gray-500 hover:text-blue-600 dark:hover:text-blue-400 hover:bg-white dark:hover:bg-gray-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors" @click="releaseRuntime"><PowerOffIcon tw-class="w-4 h-4" />{{ lazyStrings.llamaCppBrowser__release_runtime() }}</button></div>
  </section>
</template>
