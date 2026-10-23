<script setup lang="ts">
import { computed, markRaw, onScopeDispose, ref, shallowRef, watch, type Component } from 'vue';
import { createModuleLoader } from '@/utils/module-loader';
import { ArrowLeftIcon, ArrowRightIcon, ChevronDownIcon, HardDriveIcon, Loader2Icon, MessageCircleIcon } from 'lucide-vue-next';
import { lazyStrings } from '@/strings';
import { formatDownloadBytes } from '@/features/llama-cpp-browser/hugging-face/presentation';
import type { ModelLaunchEntryState } from '@/features/llama-cpp-browser/model-launch/entry-state';
import LlamaCppBrowserModelLaunchPrivacy from '@/features/llama-cpp-browser/components/LlamaCppBrowserModelLaunchPrivacy.vue';
import type { BrowserModelPresentation } from './browser-model-presentation';
import Logo from './Logo.vue';
import SettingsSelect from './SettingsSelect.vue';

const fileSelectionLoader = createModuleLoader({ importModule: () => import('./BrowserModelFileSelection.vue'), onPrefetchError: () => {} });
const FileSelection = shallowRef<Component>();
const fileSelectionStatus = ref<'loading' | 'failed' | 'ready'>('loading');
let disposed = false;
onScopeDispose(() => {
  disposed = true;
});

type SelectionState = Extract<ModelLaunchEntryState, { status: 'needs-selection' }>;
const props = defineProps<{
  model: BrowserModelPresentation,
  entry: 'home' | 'model-url' | 'discovery' | 'local',
  stage: 'preview' | 'checking' | 'needs-selection' | 'download' | 'loading' | 'ready' | 'failed',
  interaction: 'blocked' | 'ready',
  variant: string | undefined,
  quantizationOptions: readonly { value: string, label: string, detail: string | undefined }[],
  startStatus: 'idle' | 'starting',
  error: string | undefined,
  selectionState: SelectionState | undefined,
  failureAction?: 'start' | 'retry',
  fileSource?: 'hugging-face' | 'local',
  presentation?: 'preview' | 'preparation',
}>();
const emit = defineEmits<{
  start: [], back: [], retry: [],
  'select-quantization': [value: string],
  'confirm-selection': [selection: { operation: symbol, mainFilePath: string, companionFilePath: string | undefined, multimodal: 'on' | 'off' }],
}>();
defineSlots<{ progress(): unknown, details(): unknown, quantization({ disabled }: { disabled: boolean }): unknown, 'quantization-actions'(): unknown }>();
const disabled = computed(() => props.interaction !== 'ready' || props.startStatus === 'starting');
const quantizationDisabled = computed(() => {
  if (disabled.value) {
    return true;
  }
  const stage = props.stage;
  switch (stage) {
  case 'preview': case 'ready': case 'failed': return false;
  case 'checking': case 'download': case 'loading': case 'needs-selection': return true;
  default: {
    const exhaustive: never = stage;
    throw new Error(String(exhaustive));
  }
  }
});
const size = computed(() => props.model.bytes === undefined
  ? undefined : formatDownloadBytes({ bytes: props.model.bytes }));

async function loadFileSelection(): Promise<void> {
  fileSelectionStatus.value = 'loading';
  try {
    const module = await fileSelectionLoader.load();
    if (!disposed) {
      FileSelection.value = markRaw(module.default);
      fileSelectionStatus.value = 'ready';
    }
  } catch {
    if (!disposed) {
      fileSelectionStatus.value = 'failed';
    }
  }
}

watch(() => props.stage, stage => {
  switch (stage) {
  case 'needs-selection': void loadFileSelection();
    return;
  case 'preview': case 'checking': case 'download': case 'loading': case 'ready': case 'failed': return;
  default: {
    const exhaustive: never = stage;
    throw new Error(String(exhaustive));
  }
  }
}, { immediate: true });

function selectQuantization({ event }: { event: Event }): void {
  if (!quantizationDisabled.value && (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement)) {
    emit('select-quantization', event.target.value);
  }
}

function confirmSelection({ mainFilePath, companionFilePath, multimodal }: { mainFilePath: string, companionFilePath: string | undefined, multimodal: 'on' | 'off' }): void {
  const state = props.selectionState;
  if (!disabled.value && state !== undefined) {
    emit('confirm-selection', { operation: state.operation, mainFilePath, companionFilePath, multimodal });
  }
}

defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>

<template>
  <section :inert="interaction === 'blocked' || undefined" data-testid="browser-model-preparation" :tw-class="['w-full mx-auto pointer-events-auto [container-type:inline-size]', presentation === 'preparation' ? 'max-w-xl space-y-6' : 'max-w-lg space-y-3']">
    <div v-if="presentation !== 'preparation'" :tw-class="['flex items-center gap-2', entry === 'home' ? 'justify-between' : 'justify-end']">
      <button v-if="entry === 'home'" type="button" :disabled="interaction === 'blocked'" data-testid="back-to-model-selection" tw-class="inline-flex min-h-9 shrink-0 items-center gap-1.5 rounded-lg px-1 text-xs text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 hover:text-gray-800 dark:hover:text-gray-200 transition-colors motion-reduce:transition-none focus-visible:outline-2 focus-visible:outline-blue-500 disabled:opacity-50" @click="emit('back')"><ArrowLeftIcon aria-hidden="true" tw-class="h-3.5 w-3.5" />{{ lazyStrings.BrowserModelPreparation__back_to_model_selection() }}</button>
      <LlamaCppBrowserModelLaunchPrivacy appearance="compact" :file-source="fileSource" />
    </div>
    <header :tw-class="['space-y-2 text-center', presentation === 'preparation' ? 'pt-1' : '', presentation !== 'preparation' && entry === 'model-url' ? 'pt-6' : '']">
      <div v-if="presentation !== 'preparation'" class="model-preparation-brand" data-testid="model-preparation-brand" tw-class="flex items-center justify-center gap-2.5 pb-1"><div tw-class="relative isolate"><span aria-hidden="true" tw-class="pointer-events-none absolute -inset-2 -z-10 rounded-full bg-blue-400/20 blur-xl dark:bg-blue-400/15" /><Logo :size="32" /></div><span tw-class="text-[18px] font-semibold leading-none tracking-tight text-gray-600 dark:text-gray-300">Naidan</span></div>
      <h2 data-testid="preparation-model-name" :tw-class="['tracking-tight dark:text-gray-100 [overflow-wrap:anywhere]', presentation === 'preparation' ? 'text-[clamp(22px,5.5cqw,28px)] font-semibold leading-[1.2] text-gray-800' : 'font-bold leading-[1.15] text-gray-900', presentation === 'preparation' ? '' : entry === 'model-url' ? 'text-[clamp(28px,8cqw,42px)]' : 'text-2xl sm:text-[32px]']">{{ model.name }}</h2>
      <div tw-class="flex flex-wrap items-center justify-center gap-x-2 gap-y-1 text-xs text-gray-500 dark:text-gray-400">
        <span>{{ model.developer }}</span><span aria-hidden="true" tw-class="text-gray-300 dark:text-gray-600">·</span>
        <slot name="quantization" :disabled="quantizationDisabled">
          <span v-if="presentation === 'preparation' && fileSource === 'local'">{{ variant || 'GGUF' }}</span>
          <div v-else-if="presentation === 'preparation' || entry === 'model-url'" tw-class="inline-flex max-w-full items-center gap-1">
            <div v-if="quantizationOptions.length" tw-class="relative flex min-w-0 max-w-[12rem] items-center">
              <select :value="variant ?? ''" :aria-label="lazyStrings.LlamaCppBrowserModelLaunch__quantization()" :title="variant" :disabled="quantizationDisabled" data-testid="model-preview-quantization" tw-class="block h-6 max-w-full appearance-none rounded-md border border-transparent bg-transparent py-0 pl-1.5 pr-5 text-[11px] leading-4 font-normal text-gray-500 dark:text-gray-400 enabled:hover:border-gray-200 dark:enabled:hover:border-gray-700 enabled:hover:bg-gray-100/70 dark:enabled:hover:bg-gray-800/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors" @change="selectQuantization({ event: $event })">
                <option v-for="option in quantizationOptions" :key="option.value" :value="option.value" tw-class="bg-white text-gray-700 dark:bg-gray-900 dark:text-gray-200">{{ option.label }}{{ option.detail === undefined ? '' : ' · ' + option.detail }}</option>
              </select>
              <ChevronDownIcon aria-hidden="true" tw-class="pointer-events-none absolute inset-y-0 right-1 my-auto h-2.5 w-2.5 text-gray-400 dark:text-gray-500" />
            </div>
            <input v-else type="text" :value="variant ?? ''" :disabled="quantizationDisabled" :aria-label="lazyStrings.BrowserModelPreparation__specify_a_quantization()" :placeholder="lazyStrings.BrowserModelPreparation__automatic()" data-testid="model-preview-variant-input" tw-class="block h-6 w-28 min-w-0 rounded-md border border-transparent bg-transparent px-1.5 py-0 text-center text-[11px] leading-4 text-gray-500 dark:text-gray-400 enabled:hover:border-gray-200 dark:enabled:hover:border-gray-700 enabled:hover:bg-gray-100/70 dark:enabled:hover:bg-gray-800/70 placeholder:text-gray-400 dark:placeholder:text-gray-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors" @input="selectQuantization({ event: $event })" />
            <slot name="quantization-actions" />
          </div>
          <div v-else-if="quantizationOptions.length" tw-class="inline-flex max-w-[12rem] items-center gap-1"><SettingsSelect :model-value="variant ?? ''" :options="quantizationOptions" :label="lazyStrings.LlamaCppBrowserModelLaunch__quantization()" surface="embedded" presentation="toolbar" size="compact" :disabled="quantizationDisabled" data-testid="model-preview-quantization" @update:model-value="emit('select-quantization', $event)" /><slot name="quantization-actions" /></div>
          <span v-else>{{ variant || 'GGUF' }}</span>
        </slot>
        <template v-if="size !== undefined && (presentation !== 'preparation' || fileSource === 'local')"><span aria-hidden="true" tw-class="text-gray-300 dark:text-gray-600">·</span><span tw-class="inline-flex items-center gap-1 tabular-nums"><HardDriveIcon aria-hidden="true" tw-class="h-3 w-3" />{{ size }}</span></template>
      </div>
    </header>
    <div :class="{ 'model-url-start-spacing': presentation !== 'preparation' && (stage === 'preview' || stage === 'checking' || stage === 'failed') && entry === 'model-url' }" :tw-class="['text-left', presentation === 'preparation' ? 'space-y-3' : 'space-y-1', presentation !== 'preparation' && stage === 'preview' && entry === 'home' ? 'pt-[clamp(24px,6dvh,56px)]' : '']">
      <div v-if="presentation !== 'preparation' && entry !== 'model-url' && !quantizationOptions.length && (stage === 'preview' || (stage === 'failed' && failureAction !== 'retry'))" tw-class="mx-auto max-w-sm space-y-1.5">
        <label tw-class="block text-xs text-gray-600 dark:text-gray-300"><span>{{ lazyStrings.BrowserModelPreparation__specify_a_quantization() }}</span><input type="text" :value="variant ?? ''" :disabled="disabled" :placeholder="lazyStrings.BrowserModelPreparation__automatic()" data-testid="model-preview-variant-input" tw-class="mt-1.5 block w-full rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 py-2 text-sm text-gray-800 dark:text-gray-100 focus-visible:outline-2 focus-visible:outline-blue-500 disabled:opacity-50" @input="selectQuantization({ event: $event })" /></label>
      </div>
      <div tw-class="min-h-[6.5rem]">
        <Transition mode="out-in" tw-enter-active-class="transition-[opacity,transform] duration-300 motion-reduce:transition-none" tw-leave-active-class="transition-opacity duration-150 motion-reduce:transition-none" tw-enter-from-class="opacity-0 translate-y-1" tw-leave-to-class="opacity-0">
          <div v-if="stage === 'needs-selection' && selectionState" key="files">
            <FileSelection v-if="FileSelection" :model="model" :selection="selectionState" :busy="disabled" :error="undefined" presentation="embedded" @confirm="confirmSelection" />
            <div v-else data-testid="model-files-ui-loading" tw-class="flex min-h-28 flex-col items-center justify-center gap-3 text-center text-xs text-gray-500 dark:text-gray-400">
              <template v-if="fileSelectionStatus === 'failed'"><p role="alert">{{ lazyStrings.BrowserModelPreparation__could_not_load_model_settings() }}</p><button type="button" data-testid="model-files-ui-retry" tw-class="min-h-9 rounded-lg border border-gray-200 px-3 text-gray-700 hover:bg-gray-50 focus-visible:outline-2 focus-visible:outline-blue-500 dark:border-gray-700 dark:text-gray-200 dark:hover:bg-gray-800" @click="loadFileSelection">{{ lazyStrings.LlamaCppBrowserModelLaunch__retry() }}</button></template>
              <p v-else role="status" tw-class="flex items-center gap-2"><Loader2Icon aria-hidden="true" tw-class="h-4 w-4 animate-spin motion-reduce:animate-none" />{{ lazyStrings.BrowserModelPreparation__loading_model_settings() }}</p>
            </div>
          </div>
          <div v-else-if="stage === 'preview' || stage === 'checking' || stage === 'failed'" :key="'action-' + stage" tw-class="flex min-h-[6.5rem] flex-col justify-center gap-3">
            <button type="button" class="model-start-surface" data-testid="start-preview-model" :disabled="disabled" :aria-busy="startStatus === 'starting'" tw-class="group relative mx-auto flex min-h-[72px] w-full max-w-sm items-center justify-center rounded-2xl border border-blue-400/80 dark:border-blue-500/70 bg-white dark:bg-gray-800 px-12 py-4 text-center text-[clamp(16px,4.2cqw,18px)] font-bold text-gray-900 dark:text-gray-100 hover:border-blue-500 dark:hover:border-blue-400 active:scale-[0.99] focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-blue-500 transition-[border-color,box-shadow,transform] duration-300 motion-reduce:transition-none disabled:cursor-wait" @click="stage === 'failed' && failureAction === 'retry' ? emit('retry') : emit('start')"><span>{{ stage === 'failed' && failureAction === 'retry' ? lazyStrings.LlamaCppBrowserModelLaunch__retry() : lazyStrings.LlamaCppBrowserModelLaunch__start_with_this_model() }}</span><span aria-hidden="true" tw-class="absolute right-3 grid h-9 w-9 place-items-center rounded-xl bg-blue-600 text-white group-hover:bg-blue-700 transition-colors duration-300 motion-reduce:transition-none"><Loader2Icon v-if="startStatus === 'starting'" tw-class="h-4 w-4 animate-spin motion-reduce:animate-none" /><ArrowRightIcon v-else tw-class="h-4 w-4 transition-transform duration-300 group-hover:translate-x-0.5 motion-reduce:transition-none" /></span></button>
            <p v-if="stage === 'checking'" role="status" tw-class="text-center text-xs text-gray-500 dark:text-gray-400">{{ lazyStrings.BrowserModelPreparation__checking_model() }}</p>
          </div>
          <div v-else-if="stage === 'ready'" role="status" data-testid="model-preparation-ready" :tw-class="['flex min-h-[6.5rem] items-center gap-2 text-sm font-medium text-gray-700 dark:text-gray-200', presentation === 'preparation' ? 'justify-start' : 'justify-center']"><MessageCircleIcon aria-hidden="true" tw-class="h-4 w-4 text-blue-600 dark:text-blue-400" />{{ lazyStrings.LlamaCppBrowserModelLaunch__ready_when_you_are() }}</div>
          <div v-else :key="'progress-' + stage" :tw-class="['min-h-[6.5rem]', stage === 'loading' ? 'pt-2' : '']"><slot name="progress" /></div>
        </Transition>
      </div>
      <p v-if="error" role="alert" :tw-class="['text-xs leading-relaxed text-red-600 dark:text-red-400', presentation === 'preparation' ? 'text-left' : 'text-center']">{{ error }}</p>
      <div tw-class="min-h-11"><slot name="details" /></div>
    </div>
  </section>
</template>

<style scoped>
.model-url-start-spacing {
  padding-top: clamp(48px, 12dvh, 104px);
}
@media (max-height: 640px) {
  .model-url-start-spacing {
    padding-top: clamp(28px, 7dvh, 44px);
  }
}
.model-start-surface {
  box-shadow: 0 2px 4px rgb(15 23 42 / 0.04), 0 14px 28px -12px rgb(15 23 42 / 0.24), 0 28px 44px -30px rgb(37 99 235 / 0.3);
}
.model-start-surface:hover, .model-start-surface:focus-visible {
  box-shadow: 0 3px 6px rgb(15 23 42 / 0.05), 0 18px 34px -12px rgb(15 23 42 / 0.28), 0 30px 48px -28px rgb(37 99 235 / 0.35);
}
:global(.dark) .model-start-surface {
  box-shadow: 0 4px 8px rgb(0 0 0 / 0.2), 0 18px 34px -12px rgb(0 0 0 / 0.55);
}
:global(.dark) .model-start-surface:hover, :global(.dark) .model-start-surface:focus-visible {
  box-shadow: 0 4px 8px rgb(0 0 0 / 0.25), 0 22px 40px -12px rgb(0 0 0 / 0.65);
}
.model-preparation-brand {
  animation: model-preparation-brand-appear 600ms cubic-bezier(0.22, 1, 0.36, 1);
}
@keyframes model-preparation-brand-appear {
  from {
    opacity: 0;
    transform: translateY(4px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}
@media (prefers-reduced-motion: reduce) {
  .model-preparation-brand {
    animation: none;
  }
}
</style>
