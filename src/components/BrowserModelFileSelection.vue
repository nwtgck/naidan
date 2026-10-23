<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { lazyStrings } from '@/strings';
import { ArrowLeftIcon, ArrowRightIcon, HardDriveIcon, Loader2Icon, ShieldCheckIcon } from 'lucide-vue-next';
import LlamaCppBrowserModelConfiguration from '@/features/llama-cpp-browser/components/LlamaCppBrowserModelConfiguration.vue';
import { formatDownloadBytes, preferredProjector } from '@/features/llama-cpp-browser/hugging-face/presentation';
import type { ModelLaunchEntryState } from '@/features/llama-cpp-browser/model-launch/entry-state';
import type { BrowserModelPresentation } from './browser-model-presentation';

// Selection controls consume presentation choices, never a download manifest.
const props = defineProps<{
  model: BrowserModelPresentation,
  selection: Extract<ModelLaunchEntryState, { status: 'needs-selection' }>,
  busy: boolean,
  error: string | undefined,
  presentation?: 'dialog' | 'embedded',
  action?: 'confirm' | 'retry',
}>();
const emit = defineEmits<{
  back: [],
  retry: [],
  confirm: [selection: { mainFilePath: string, companionFilePath: string | undefined, multimodal: 'on' | 'off' }],
}>();
const mainPath = ref('');
const companionPath = ref('');
const multimodal = ref<'on' | 'off'>('on');
const projectors = computed(() => props.selection.companionChoices.map(choice => ({ path: choice.path, size: choice.size })));
const choices = computed(() => props.selection.mainChoices.map(choice => ({
  primaryRelativePath: choice.path,
  displayLabel: choice.label,
  size: choice.size,
})));

watch(() => props.selection, selection => {
  mainPath.value = selection.selectedMainPath ?? (selection.mainChoices.length === 1 ? selection.mainChoices[0]!.path : '');
  companionPath.value = selection.selectedCompanionPath ?? preferredProjector({ files: projectors.value })?.path ?? '';
  multimodal.value = selection.companionChoices.length ? 'on' : 'off';
}, { immediate: true });
const valid = computed(() => props.selection.mainChoices.some(choice => choice.path === mainPath.value)
  && (multimodal.value === 'off' || props.selection.companionChoices.some(choice => choice.path === companionPath.value)));
const selectedCompanion = computed(() => {
  const mode = multimodal.value;
  switch (mode) {
  case 'off': return undefined;
  case 'on': return props.selection.companionChoices.find(choice => choice.path === companionPath.value);
  default: {
    const exhaustive: never = mode;
    throw new Error(String(exhaustive));
  }
  }
});
const size = computed(() => {
  const main = props.selection.mainChoices.find(choice => choice.path === mainPath.value);
  if (main === undefined) {
    return undefined;
  }
  return formatDownloadBytes({ bytes: main.size + (selectedCompanion.value?.size ?? 0) });
});

function confirm(): void {
  if (props.busy) {
    return;
  }
  const action = props.action;
  switch (action) {
  case 'retry': emit('retry');
    return;
  case 'confirm': case undefined: break;
  default: {
    const exhaustive: never = action;
    throw new Error(String(exhaustive));
  }
  }
  if (!valid.value) {
    return;
  }
  emit('confirm', { mainFilePath: mainPath.value, companionFilePath: selectedCompanion.value?.path, multimodal: multimodal.value });
}

defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>

<template>
  <section class="browser-model-files" :class="{ 'browser-model-files-embedded': presentation === 'embedded' }" data-testid="browser-model-files" tw-class="flex min-h-full flex-col px-6 pb-8 pt-20 sm:px-12">
    <div v-if="presentation !== 'embedded'" tw-class="mx-auto flex w-full max-w-2xl items-center justify-between gap-4">
      <button type="button" :disabled="busy" data-testid="browser-model-files-back" tw-class="inline-flex min-h-9 items-center gap-1.5 rounded-lg px-2 text-xs text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-800 focus-visible:outline-2 focus-visible:outline-blue-500 disabled:opacity-40 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-gray-200" @click="emit('back')"><ArrowLeftIcon aria-hidden="true" tw-class="h-3.5 w-3.5" />{{ lazyStrings.BrowserModelPreparation__back_to_model_selection() }}</button>
      <span tw-class="inline-flex items-center gap-1.5 text-[11px] text-gray-500 dark:text-gray-400"><ShieldCheckIcon aria-hidden="true" tw-class="h-3.5 w-3.5 text-blue-500 dark:text-blue-400" />{{ lazyStrings.llamaCppBrowser__runs_in_your_browser() }}</span>
    </div>
    <div class="browser-model-files-body" tw-class="mx-auto flex w-full max-w-lg flex-1 flex-col justify-center gap-8 py-8">
      <header v-if="presentation !== 'embedded'" tw-class="space-y-2 text-center">
        <p tw-class="text-xs text-gray-500 dark:text-gray-400">{{ model.developer }}</p>
        <h2 tw-class="text-balance text-[clamp(24px,4vw,34px)] font-bold leading-tight tracking-tight text-gray-800 dark:text-gray-100">{{ model.name }}</h2>
        <p tw-class="break-all text-[11px] text-gray-400 dark:text-gray-500">{{ model.repository }}</p>
      </header>
      <div tw-class="rounded-2xl border border-gray-200/80 bg-white/50 p-5 text-left dark:border-gray-700/60 dark:bg-gray-800/35 sm:p-6">
        <h3 tw-class="mb-5 text-xs font-medium text-gray-600 dark:text-gray-300">{{ lazyStrings.BrowserModelFileSelection__model_settings() }}</h3>
        <LlamaCppBrowserModelConfiguration v-model:quantization="mainPath" v-model:multimodal="multimodal" v-model:projector="companionPath" :choices="choices" :projectors="projectors" :disabled="busy || action === 'retry'" :multimodal-description-id="undefined" />
        <div tw-class="mt-5 flex min-h-5 items-center gap-1.5 border-t border-gray-100 pt-4 text-xs text-gray-500 dark:border-gray-700/50 dark:text-gray-400" aria-live="polite"><HardDriveIcon aria-hidden="true" tw-class="h-3.5 w-3.5 shrink-0" /><span v-if="size" tw-class="tabular-nums">{{ size }}</span><span v-else>{{ lazyStrings.LlamaCppBrowserHuggingFaceManager__choose_model_files() }}</span></div>
      </div>
      <div tw-class="space-y-3">
        <button type="button" data-testid="browser-model-files-confirm" :disabled="busy || !valid" :aria-busy="busy" tw-class="group relative flex min-h-16 w-full items-center justify-center rounded-2xl border border-blue-400/80 bg-white px-12 py-4 text-center text-base font-bold text-gray-900 shadow-sm transition-[border-color,box-shadow,transform] duration-200 hover:border-blue-500 hover:shadow-lg active:scale-[0.99] focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-blue-500 disabled:cursor-default disabled:opacity-45 dark:border-blue-500/60 dark:bg-gray-800 dark:text-gray-100 dark:hover:border-blue-400 motion-reduce:transition-none" @click="confirm"><span>{{ action === 'retry' ? lazyStrings.LlamaCppBrowserModelLaunch__retry() : lazyStrings.LlamaCppBrowserModelLaunch__start_with_this_model() }}</span><span aria-hidden="true" tw-class="absolute right-3 grid h-9 w-9 place-items-center rounded-xl bg-blue-600 text-white transition-colors group-hover:bg-blue-700"><Loader2Icon v-if="busy" tw-class="h-4 w-4 animate-spin motion-reduce:animate-none" /><ArrowRightIcon v-else tw-class="h-4 w-4 transition-transform group-hover:translate-x-0.5 motion-reduce:transition-none" /></span></button>
        <p v-if="error" role="alert" tw-class="text-center text-xs leading-relaxed text-red-600 dark:text-red-400">{{ error }}</p>
      </div>
    </div>
  </section>
</template>

<style scoped>
.browser-model-files-embedded {
  min-height: 0;
  padding: 0;
}
.browser-model-files-embedded .browser-model-files-body {
  padding: 0;
  gap: 1.25rem;
}
.browser-model-files-body {
  padding-bottom: clamp(2rem, 8dvh, 5rem);
}
@media (max-height: 640px) {
  .browser-model-files {
    padding-top: 3.5rem;
  }
  .browser-model-files-body {
    gap: 1.25rem;
    padding-block: 1.5rem;
  }
}
</style>
