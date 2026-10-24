<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, shallowRef, useId, watch } from 'vue';
import { CheckIcon, InfoIcon, Loader2Icon, PowerOffIcon, RefreshCcwIcon, RotateCcwIcon, SlidersHorizontalIcon } from 'lucide-vue-next';
import SettingsSelect from '@/components/SettingsSelect.vue';
import LlamaCppBrowserModelActionButton from './LlamaCppBrowserModelActionButton.vue';
import { lazyStrings } from '@/strings';
import { useSettings } from '@/composables/useSettings';
import { llamaCppBrowserService } from '@/features/llama-cpp-browser';
import { selectableProfiles } from '@/features/llama-cpp-browser/runtime/profile-policy';
import { chatContextTokensSchema, defaultChatContextTokens, minimumChatContextTokens, maximumChatContextTokens, errorCode, runtimeOptionsSchema } from '@/features/llama-cpp-browser/types';
import { resolveProfilePreference, profileFeatures, type ProfileCapabilities, type ProfileState, type ProfileUnavailableReason } from '@/features/llama-cpp-browser/runtime/profile-capabilities';

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
  'webgpu-wasm64-jspi-gpu-profile': 'WebGPU / wasm64 / GPU profile',
  'cpu-wasm32': 'CPU / wasm32',
} satisfies Record<Exclude<typeof options.value.profile, 'auto'>, string>;

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
const profileOptions = computed(() => profileChoices.value.map(choice => ({ value: choice.profile, label: choice.label, detail: choice.reason, disabled: choice.disabled })));
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

function applyOptions({ profile }: { profile: string }): void {
  if (props.disabled || profileState.value.status === 'checking') {
    return;
  }
  const parsed = runtimeOptionsSchema.safeParse({ ...options.value, profile });
  if (parsed.success && !profileDisabled({ profile: parsed.data.profile })) {
    options.value = parsed.data;
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
  <section :aria-labelledby="`${id}-heading`" tw-class="space-y-4 rounded-xl border border-gray-200/70 bg-white/60 p-4 dark:border-gray-800/80 dark:bg-gray-900/20">
    <h3 :id="`${id}-heading`" tw-class="flex items-center gap-3 text-sm font-semibold text-gray-700 dark:text-gray-200"><span tw-class="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-blue-50/80 text-blue-500 dark:bg-blue-500/10 dark:text-blue-400"><SlidersHorizontalIcon aria-hidden="true" tw-class="h-4 w-4" /></span>{{ lazyStrings.llamaCppBrowser__inference_settings() }}</h3>
    <fieldset :disabled="disabled" tw-class="space-y-4 disabled:opacity-50">
      <div tw-class="grid gap-2 sm:grid-cols-[minmax(0,10rem)_minmax(0,1fr)] sm:items-center sm:gap-4">
        <label :for="`${id}-profile`" tw-class="text-[11px] font-medium text-gray-500 dark:text-gray-400">{{ lazyStrings.llamaCppBrowser__profile() }}</label>
        <div tw-class="flex h-9 min-w-0 rounded-lg border border-gray-200/80 bg-white/70 transition-colors focus-within:border-blue-300 dark:border-gray-700/70 dark:bg-gray-800/40 dark:focus-within:border-blue-500/40">
          <SettingsSelect :id="`${id}-profile`" :model-value="options.profile" :options="profileOptions" :label="lazyStrings.llamaCppBrowser__profile()" :disabled="disabled || profileState.status === 'checking'" surface="embedded" presentation="toolbar" size="compact" :menu-width-rem="23" data-testid="llama-cpp-browser-profile" @update:model-value="applyOptions({ profile: $event })">
            <template #option="{ option }"><span tw-class="block min-w-0 flex-1"><span tw-class="block break-words text-xs font-medium">{{ option.label }}</span><span v-if="option.detail" tw-class="mt-1 block break-words text-[11px] leading-5 text-gray-500 dark:text-gray-400">{{ option.detail }}</span></span></template>
          </SettingsSelect>
        </div>
      </div>
      <div tw-class="grid gap-2 border-t border-gray-100 pt-4 sm:grid-cols-[minmax(0,10rem)_minmax(0,1fr)] sm:gap-4 dark:border-gray-800/70">
        <label :for="`${id}-context-tokens`" tw-class="text-[11px] font-medium text-gray-500 sm:pt-2.5 dark:text-gray-400">{{ lazyStrings.LlamaCppBrowserRuntimeSettings__context_size_tokens() }}</label>
        <div tw-class="min-w-0 space-y-2.5">
          <div tw-class="flex flex-wrap items-center gap-2">
            <input :id="`${id}-context-tokens`" v-model.number="contextTokensDraft" type="number" :min="minimumChatContextTokens" :max="maximumChatContextTokens" step="1" required :disabled="contextDisabled" :aria-invalid="!contextTokensValid || undefined" :aria-describedby="`${id}-context-description${contextTokensValid ? '' : ` ${id}-context-invalid`}${contextSaveFailed ? ` ${id}-context-save-failed` : ''}`" data-testid="llama-cpp-browser-context-tokens" tw-class="h-9 w-32 max-w-full rounded-lg border border-gray-200/80 bg-white/70 px-2.5 text-xs font-medium tabular-nums text-gray-700 outline-none transition-colors focus:border-blue-300 focus:ring-2 focus:ring-blue-500/20 disabled:opacity-50 dark:border-gray-700/70 dark:bg-gray-800/40 dark:text-gray-200 dark:focus:border-blue-500/40" @input="contextSaveFailed = false" />
            <LlamaCppBrowserModelActionButton :disabled="contextDisabled || !contextTokensValid" data-testid="llama-cpp-browser-context-save" @click="saveContextTokens({ value: contextTokensDraft })"><CheckIcon aria-hidden="true" tw-class="h-3.5 w-3.5 shrink-0 text-blue-500 dark:text-blue-400" />{{ lazyStrings.LlamaCppBrowserRuntimeSettings__save() }}</LlamaCppBrowserModelActionButton>
            <LlamaCppBrowserModelActionButton :disabled="contextDisabled" data-testid="llama-cpp-browser-context-reset" @click="saveContextTokens({ value: undefined })"><RotateCcwIcon aria-hidden="true" tw-class="h-3.5 w-3.5 shrink-0 text-gray-400 dark:text-gray-500" />{{ lazyStrings.LlamaCppBrowserRuntimeSettings__reset_to_default() }}</LlamaCppBrowserModelActionButton>
          </div>
          <p :id="`${id}-context-description`" tw-class="text-[11px] leading-5 text-gray-500 dark:text-gray-400">{{ lazyStrings.LlamaCppBrowserRuntimeSettings__context_size_applies_to_all_chats() }}</p>
          <p v-if="!contextTokensValid" :id="`${id}-context-invalid`" role="alert" data-testid="llama-cpp-browser-context-invalid" tw-class="text-[11px] leading-5 text-red-600 dark:text-red-400">{{ lazyStrings.LlamaCppBrowserRuntimeSettings__enter_a_whole_number_from_minimum_to_maximum({ minimum: minimumChatContextTokens, maximum: maximumChatContextTokens }) }}</p>
          <p v-if="contextSaveFailed" :id="`${id}-context-save-failed`" role="alert" data-testid="llama-cpp-browser-context-save-failed" tw-class="text-[11px] leading-5 text-red-600 dark:text-red-400">{{ lazyStrings.LlamaCppBrowserRuntimeSettings__could_not_save_context_size() }}</p>
        </div>
      </div>
    </fieldset>
    <p v-if="profileState.status === 'checking'" role="status" data-testid="llama-cpp-browser-profile-checking" tw-class="flex items-center gap-2 text-[11px] leading-5 text-gray-500 dark:text-gray-400"><Loader2Icon aria-hidden="true" tw-class="h-3.5 w-3.5 shrink-0 animate-spin motion-reduce:animate-none" />{{ lazyStrings.llamaCppBrowser__checking_browser_support() }}</p>
    <p v-else-if="profileState.status === 'ready' && selectedProfile === undefined" role="status" tw-class="text-xs text-amber-600 dark:text-amber-400">{{ lazyStrings.llamaCppBrowser__no_compatible_runtime() }}</p>
    <p v-else-if="selectedFailure" role="status" data-testid="llama-cpp-browser-profile-unavailable" tw-class="text-xs text-amber-600 dark:text-amber-400">{{ lazyStrings.llamaCppBrowser__unavailable_feature({ feature: profileFeatures[selectedFailure] }) }}</p>
    <p v-else-if="profileState.status === 'error'" role="alert" tw-class="text-xs text-red-500">{{ lazyStrings.llamaCppBrowser__operation_failed() }}</p>
    <LlamaCppBrowserModelActionButton v-if="profileState.status !== 'checking' && !runtimeReady" :disabled="false" data-testid="llama-cpp-browser-probe-profiles" @click="probeProfiles"><RefreshCcwIcon aria-hidden="true" tw-class="h-3.5 w-3.5 shrink-0 text-gray-400 dark:text-gray-500" />{{ lazyStrings.llamaCppBrowser__check_browser_support() }}</LlamaCppBrowserModelActionButton>
    <div tw-class="flex flex-wrap items-start gap-3 rounded-lg border border-blue-100/70 bg-blue-50/40 p-3 dark:border-blue-500/10 dark:bg-blue-500/5"><p tw-class="flex min-w-0 flex-[1_1_16rem] items-start gap-2 text-[11px] leading-5 text-gray-500 dark:text-gray-400"><InfoIcon aria-hidden="true" tw-class="mt-0.5 h-3.5 w-3.5 shrink-0 text-blue-500 dark:text-blue-400" /><span>{{ lazyStrings.llamaCppBrowser__image_chat_requires_matching_projector() }}</span></p><LlamaCppBrowserModelActionButton :disabled="releaseDisabled" data-testid="llama-cpp-browser-release" tw-class="ml-auto" @click="releaseRuntime"><PowerOffIcon aria-hidden="true" tw-class="h-3.5 w-3.5 shrink-0 text-gray-400 dark:text-gray-500" />{{ lazyStrings.llamaCppBrowser__release_runtime() }}</LlamaCppBrowserModelActionButton></div>
  </section>
</template>
