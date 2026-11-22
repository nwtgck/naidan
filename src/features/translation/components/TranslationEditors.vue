<script setup lang="ts">
import { ref, useId } from 'vue';
import { ArrowLeftRightIcon, CopyIcon, LanguagesIcon, Loader2Icon, SquareIcon } from 'lucide-vue-next';
import { lazyStrings } from '@/strings';
import ToggleSwitch from '@/components/ToggleSwitch.vue';
import SettingsFormSelect from '@/components/SettingsFormSelect.vue';
import LlamaCppBrowserModelActionButton from '@/features/llama-cpp-browser/components/LlamaCppBrowserModelActionButton.vue';
import LlamaCppBrowserDownloadProgress from '@/features/llama-cpp-browser/components/LlamaCppBrowserDownloadProgress.vue';
import LlamaCppBrowserModelLoadProgress from '@/features/llama-cpp-browser/components/LlamaCppBrowserModelLoadProgress.vue';
import type { DownloadProgress } from '@/features/llama-cpp-browser/hugging-face/types';
import type { ErrorCode, Progress } from '@/features/llama-cpp-browser/types';
import TranslationAutomaticSettings from './TranslationAutomaticSettings.vue';
import TranslationInputProgress from './TranslationInputProgress.vue';
import TranslationOutput from './TranslationOutput.vue';

type LanguageOption = { value: string, label: string | undefined, disabled?: boolean, searchTerms: string[] };

const props = defineProps<{
  text: string,
  sourceLang: string | undefined,
  targetLang: string,
  options: { sources: LanguageOption[], targets: LanguageOption[] },
  languageSearch: { label: string | undefined, noResults: string | undefined },
  profileAvailable: boolean,
  canSwap: boolean,
  blocked: boolean,
  autoTranslate: boolean,
  debounceMs: number,
  showRun: boolean,
  canRun: boolean,
  busy: boolean,
  loadingModel: boolean,
  acquiring: boolean,
  downloadProgress: DownloadProgress | undefined,
  modelProgress: Progress | undefined,
  progress: Progress | undefined,
  prefill: boolean,
  canStop: boolean,
  stopping: boolean,
  output: string,
  previousOutput: string,
  revision: number,
  outputState: InstanceType<typeof TranslationOutput>['$props']['state'],
  copied: 'idle' | 'copied' | 'failed',
  displayedStatus: string | undefined,
  issueLabel: string | undefined,
  failure: ErrorCode | undefined,
  preparationFailure: ErrorCode | undefined,
  popupTarget?: HTMLElement,
}>();
const emit = defineEmits<{
  text: [change: { value: string }],
  compositionStart: [change: { input: HTMLTextAreaElement }],
  compositionEnd: [change: { input: HTMLTextAreaElement }],
  chooseLanguage: [selection: { side: 'source' | 'target', value: string }],
  swapLanguages: [],
  clear: [],
  copy: [request: { view: Window | null, focus: () => void }],
  changeAutomatic: [change: { enabled: boolean }],
  changeDelay: [change: { value: number }],
  retry: [],
  stop: [],
}>();
const id = useId();
const sourceInput = ref<HTMLTextAreaElement>();
const outputElement = ref<InstanceType<typeof TranslationOutput>>();

function publishText({ event }: { event: Event }): void {
  // Use the textarea value from its own document, including IME preedit.
  emit('text', { value: (event.currentTarget as HTMLTextAreaElement).value });
}

function startComposition({ event }: { event: CompositionEvent }): void {
  emit('compositionStart', { input: event.currentTarget as HTMLTextAreaElement });
}

function endComposition({ event }: { event: Event }): void {
  emit('compositionEnd', { input: event.currentTarget as HTMLTextAreaElement });
}

function changeAutomatic({ event }: { event: Event }): void {
  const input = event.currentTarget as HTMLInputElement;
  const next = input.checked;
  input.checked = props.autoTranslate;
  emit('changeAutomatic', { enabled: next });
}

function clear(): void {
  emit('clear');
  sourceInput.value?.focus();
}

function copy({ event }: { event: MouseEvent }): void {
  const view = (event.currentTarget as HTMLButtonElement).ownerDocument.defaultView;
  emit('copy', { view, focus: () => outputElement.value?.focus() });
}

defineExpose({ sourceInput, ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>

<template>
  <div tw-class="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-end gap-2 sm:gap-3">
    <div tw-class="min-w-0 space-y-2"><span tw-class="block text-xs font-medium text-gray-600 dark:text-gray-300">{{ lazyStrings.translation__source_language() }}</span><SettingsFormSelect :model-value="sourceLang ?? ''" :options="options.sources" :search="languageSearch" :label="lazyStrings.translation__source_language()" :disabled="blocked || !profileAvailable" :popup-target="popupTarget" data-testid="translation-source-language" @update:model-value="emit('chooseLanguage', { side: 'source', value: $event })" /></div>
    <button type="button" :disabled="!canSwap" :title="lazyStrings.translation__swap_languages()" :aria-label="lazyStrings.translation__swap_languages()" data-testid="translation-swap" @click="emit('swapLanguages')" tw-class="flex h-10 w-9 items-center justify-center rounded-xl text-gray-500 hover:bg-gray-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:opacity-35 dark:hover:bg-gray-800"><ArrowLeftRightIcon aria-hidden="true" tw-class="h-4 w-4" /></button>
    <div tw-class="min-w-0 space-y-2"><span tw-class="block text-xs font-medium text-gray-600 dark:text-gray-300">{{ lazyStrings.translation__target_language() }}</span><SettingsFormSelect :model-value="targetLang" :options="options.targets" :search="languageSearch" :label="lazyStrings.translation__target_language()" :disabled="blocked || !profileAvailable" :popup-target="popupTarget" data-testid="translation-target-language" @update:model-value="emit('chooseLanguage', { side: 'target', value: $event })" /></div>
  </div>
  <div class="translation-editors" data-testid="translation-editors" :tw-class="['grid min-w-0 gap-3', popupTarget ? 'min-[36rem]:grid-cols-2' : 'md:grid-cols-2']">
    <section :class="{ 'translation-editor-compact': popupTarget }" class="translation-editor" data-testid="translation-source-panel" tw-class="flex min-w-0 flex-col overflow-hidden rounded-xl border border-gray-200/80 bg-white has-[textarea:focus-visible]:border-blue-400 has-[textarea:focus-visible]:ring-2 has-[textarea:focus-visible]:ring-blue-500/20 dark:border-gray-700/70 dark:bg-gray-800/20 dark:has-[textarea:focus-visible]:border-blue-500">
      <div tw-class="flex h-9 shrink-0 items-center justify-between gap-2 border-b border-gray-100 px-4 dark:border-gray-800"><label :for="`${id}-source`" tw-class="text-xs font-medium text-gray-600 dark:text-gray-300">{{ lazyStrings.translation__source_text() }}</label><button type="button" :disabled="!text || blocked" @click="clear" data-testid="translation-clear" tw-class="rounded-lg p-2 text-xs text-gray-500 hover:text-gray-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 disabled:opacity-35 dark:hover:text-gray-100">{{ lazyStrings.translation__clear() }}</button></div>
      <textarea :id="`${id}-source`" ref="sourceInput" :value="text" @input="publishText({ event: $event })" dir="auto" :placeholder="lazyStrings.translation__enter_source_text()" data-testid="translation-source" @compositionstart="startComposition({ event: $event })" @compositionend="endComposition({ event: $event })" @blur="endComposition({ event: $event })" tw-class="block min-h-0 w-full flex-1 resize-none overflow-y-auto border-0 bg-transparent p-4 text-sm leading-7 outline-none" />
      <div data-testid="translation-source-footer" tw-class="flex h-12 shrink-0 items-center justify-between gap-2 border-t border-gray-100 px-4 dark:border-gray-800">
        <div tw-class="flex min-w-0 items-center gap-1"><label tw-class="flex min-w-0 cursor-pointer items-center gap-2 text-xs text-gray-500 dark:text-gray-400"><ToggleSwitch><input type="checkbox" role="switch" :checked="autoTranslate" :disabled="blocked" data-testid="translation-automatic" @change="changeAutomatic({ event: $event })" /></ToggleSwitch><span :title="lazyStrings.translation__automatic_translation()" tw-class="truncate">{{ lazyStrings.translation__automatic_translation() }}</span></label><TranslationAutomaticSettings v-if="!popupTarget" :debounce-ms="debounceMs" :disabled="blocked" @change="emit('changeDelay', { value: $event })" /></div>
        <button v-show="showRun" type="submit" :disabled="!canRun" data-testid="translation-run" tw-class="inline-flex h-9 min-w-24 shrink-0 items-center justify-center gap-2 rounded-lg bg-blue-600 px-3 text-xs font-medium text-white transition-colors hover:bg-blue-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 disabled:cursor-not-allowed disabled:opacity-40 dark:bg-blue-500 dark:hover:bg-blue-600 motion-reduce:transition-none"><LanguagesIcon aria-hidden="true" tw-class="h-3.5 w-3.5" />{{ lazyStrings.translation__translate() }}</button>
      </div>
    </section>
    <section :aria-busy="busy || loadingModel || acquiring" :class="{ 'translation-editor-compact': popupTarget }" class="translation-editor" data-testid="translation-output-panel" tw-class="flex min-w-0 flex-col overflow-hidden rounded-xl border border-gray-200/80 bg-gray-50/50 has-[pre:focus-visible]:border-blue-400 has-[pre:focus-visible]:ring-2 has-[pre:focus-visible]:ring-blue-500/20 dark:border-gray-700/70 dark:bg-gray-800/40 dark:has-[pre:focus-visible]:border-blue-500">
      <div tw-class="flex h-9 shrink-0 items-center justify-between gap-2 border-b border-gray-100 px-4 dark:border-gray-800"><h2 tw-class="text-xs font-medium text-gray-600 dark:text-gray-300">{{ lazyStrings.translation__translated_text() }}</h2><button type="button" :disabled="busy || !output" @click="copy({ event: $event })" data-testid="translation-copy" tw-class="flex items-center gap-1 rounded-lg p-2 text-xs text-gray-500 hover:text-gray-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 disabled:opacity-35 dark:hover:text-gray-100"><CopyIcon aria-hidden="true" tw-class="h-3.5 w-3.5" />{{ copied === 'copied' ? lazyStrings.translation__copied() : lazyStrings.translation__copy() }}</button></div>
      <div tw-class="relative min-h-0 flex-1 overflow-hidden">
        <TranslationOutput :id="`${id}-output`" ref="outputElement" :text="output" :previous-text="previousOutput" :revision="revision" :state="outputState" :compact="popupTarget !== undefined" :label="lazyStrings.translation__translated_text()" :placeholder="lazyStrings.translation__translation_appears_here()" data-testid="translation-output" />
        <div v-if="issueLabel || failure || preparationFailure" role="alert" data-testid="translation-error" tw-class="absolute inset-x-0 bottom-0 max-h-[50%] overflow-y-auto bg-gray-50 p-4 text-sm text-red-600 dark:bg-gray-900 dark:text-red-400">
          <p v-if="issueLabel">{{ issueLabel }}</p><p v-if="failure">{{ failure === 'context-full' ? lazyStrings.translation__source_too_long() : lazyStrings.translation__translation_failed() }} <code tw-class="text-xs">{{ failure }}</code></p><p v-if="preparationFailure">{{ lazyStrings.translation__translation_failed() }} <code tw-class="text-xs">{{ preparationFailure }}</code> <button type="button" @click="emit('retry')" tw-class="underline">{{ lazyStrings.translation__check_again() }}</button></p>
        </div>
      </div>
      <div data-testid="translation-output-footer" tw-class="flex h-12 shrink-0 items-center justify-between gap-2 border-t border-gray-100 px-4 dark:border-gray-800">
        <div role="status" aria-live="polite" data-testid="translation-status" tw-class="min-w-0 flex-1 text-xs text-gray-500 dark:text-gray-400">
          <LlamaCppBrowserDownloadProgress v-if="acquiring && downloadProgress" :progress="downloadProgress" appearance="welcome" activity="active" compact />
          <p v-else-if="acquiring" tw-class="truncate">{{ lazyStrings.LlamaCppBrowserHuggingFaceManager__downloading_model() }}</p>
          <LlamaCppBrowserModelLoadProgress v-else-if="loadingModel" :progress="modelProgress" appearance="compact" />
          <TranslationInputProgress v-else-if="prefill" :progress="progress" />
          <div v-else tw-class="flex min-w-0 items-center gap-2"><Loader2Icon v-if="busy" aria-hidden="true" tw-class="h-3.5 w-3.5 shrink-0 animate-spin motion-reduce:animate-none" /><span tw-class="truncate" :title="copied === 'failed' ? lazyStrings.translation__copy_failed_select_text() : displayedStatus">{{ copied === 'failed' ? lazyStrings.translation__copy_failed_select_text() : displayedStatus }}</span><span v-if="previousOutput && !output" tw-class="truncate">{{ lazyStrings.translation__previous_translation() }}</span></div>
        </div>
        <LlamaCppBrowserModelActionButton :disabled="!canStop || stopping" :tw-class="['h-9 min-w-20 shrink-0 justify-center', { invisible: !canStop }]" data-testid="translation-stop" @click="emit('stop')"><SquareIcon aria-hidden="true" tw-class="h-3.5 w-3.5" />{{ lazyStrings.translation__stop() }}</LlamaCppBrowserModelActionButton>
      </div>
    </section>
  </div>
</template>

<style scoped>
.translation-editor {
  height: clamp(18rem, calc(100dvh - 19rem), 34rem);
}
.translation-editor-compact {
  height: max(10rem, calc((100dvh - 9rem) / 2));
}
@media (min-width: 36rem) {
  .translation-editor-compact {
    height: max(11rem, calc(100dvh - 9rem));
  }
}
@media (max-width: 767px) {
  .translation-editor:not(.translation-editor-compact) {
    height: 19rem;
  }
}
@media (forced-colors: active) {
  .translation-editor:has(textarea:focus-visible, pre:focus-visible) {
    outline: 2px solid Highlight;
    outline-offset: 2px;
  }
}
</style>
