<script setup lang="ts">
import { idToRaw } from '@/01-models/ids';
import type { LmOperationProgress } from '@/01-models/lm';
import { computed, nextTick, onScopeDispose, ref, useId, watch } from 'vue';
import { LanguagesIcon, XIcon, ChevronDownIcon } from 'lucide-vue-next';
import { useSettings } from '@/composables/useSettings';
import { useLayout, type FocusArea } from '@/composables/useLayout';
import { currentLocale, ensureStrings, lazyStrings } from '@/strings';
import { parseUiLocale } from '@/01-models/ui-locale';
import { cloneLmParameters } from '@/utils/lm-parameters';
import type { ImageGenerationWorkspaceView } from '@/features/image-generation/composables/use-image-generation-workspace';
import { trapImageDialogFocus } from '@/features/image-generation/dialog-keyboard';
import { translateImagePrompt } from '@/features/image-generation/translation/request';
import { imagePromptTranslationEndpointLabel, imagePromptTranslationLanguages, resolveImagePromptTranslation } from '@/features/image-generation/translation/settings';
import ImageGenerationCopyButton from './ImageGenerationCopyButton.vue';
import ImageGenerationTranslationSettings from './ImageGenerationTranslationSettings.vue';
import ImageSettingsSection from './ImageSettingsSection.vue';
const props = defineProps<{ workspace: ImageGenerationWorkspaceView, text: string, field: 'prompt' | 'negativePrompt', active: boolean }>();
const { settings } = useSettings();
const { activeFocusArea, activeFocusAreaVersion, setActiveFocusArea } = useLayout();
const open = ref(false), language = ref(currentLocale.value), translating = ref(false), result = ref(''), failure = ref('');
const dialog = ref<HTMLElement>(), id = useId();
const progress = ref<LmOperationProgress>();
const resultComplete = ref(false);
const translationKey = computed(() => ({ storeId: props.workspace.store.value ? idToRaw({ id: props.workspace.store.value.storeId }) : undefined, sessionId: props.workspace.selectedSessionId.value ? idToRaw({ id: props.workspace.selectedSessionId.value }) : undefined, field: props.field, language: language.value }));
const previousResult = computed(() => props.workspace.translationMemory.read({ key: translationKey.value }));
const stale = computed(() => previousResult.value !== undefined && previousResult.value.sourceText !== props.text);
const progressLabel = computed(() => {
  const phase = progress.value?.phase;
  switch (phase) {
  case 'queued': return lazyStrings.imageGeneration__translation_waiting();
  case 'initializing': case 'loading': return lazyStrings.imageGeneration__translation_loading_model();
  case 'prefill': return lazyStrings.imageGeneration__translation_processing_input();
  case 'generating': case undefined: return lazyStrings.imageGeneration__translation_running();
  default: { const exhaustive: never = phase; throw new Error(String(exhaustive)); }
  }
});
const progressFraction = computed(() => {
  const value = progress.value;
  if (!value || value.phase === 'generating' || value.phase === 'queued' || !Number.isFinite(value.total) || value.total <= 0 || !Number.isFinite(value.completed)) return undefined;
  return Math.max(0, Math.min(100, Math.floor(value.completed / value.total * 100)));
});
let controller: AbortController | undefined, epoch = 0, disposed = false;
let previousFocus: HTMLElement | undefined, previousArea: FocusArea | undefined, focusVersion: number | undefined;
const target = computed(() => resolveImagePromptTranslation({
  session: props.workspace.currentSession.value?.translation,
  workspace: props.workspace.catalog.value?.preferences.translation,
  global: { endpoint: settings.value.endpoint, modelId: settings.value.defaultModelId, lmParameters: settings.value.lmParameters },
}));
const endpointLabel = computed(() => imagePromptTranslationEndpointLabel({ endpoint: target.value.endpoint }));
const fieldLabel = computed(() => {
  switch (props.field) {
  case 'prompt': return lazyStrings.stableDiffusionCppBrowser__prompt();
  case 'negativePrompt': return lazyStrings.stableDiffusionCppBrowser__negative_prompt();
  default: { const exhaustive: never = props.field; throw new Error(String(exhaustive)); }
  }
});
function retire(): void {
  epoch++; controller?.abort(); controller = undefined; translating.value = false; progress.value = undefined;
}
function restoreFocus(): void {
  if (activeFocusAreaVersion.value === focusVersion && previousArea) setActiveFocusArea({ area: previousArea });
  previousArea = undefined; focusVersion = undefined;
  if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
  previousFocus = undefined;
}
async function show(): Promise<void> {
  if ((!props.text.trim() && !previousResult.value) || !props.active || open.value) return;
  previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
  previousArea = activeFocusArea.value; setActiveFocusArea({ area: 'dialog' }); focusVersion = activeFocusAreaVersion.value;
  result.value = ''; resultComplete.value = false; failure.value = ''; open.value = true;
  await nextTick(); if (!disposed && open.value) dialog.value?.focus({ preventScroll: true });
}
function close(): void {
  retire(); open.value = false; result.value = ''; failure.value = ''; restoreFocus();
}
function keyboard({ event }: { event: KeyboardEvent }): void {
  if (event.defaultPrevented || event.isComposing) return;
  trapImageDialogFocus({ root: dialog.value, event });
  if (event.key === 'Escape') {
    event.preventDefault(); close();
  }
}
function changeLanguage({ event }: { event: Event }): void {
  if (!(event.target instanceof HTMLSelectElement)) return;
  const value = parseUiLocale({ value: event.target.value }); if (value) language.value = value;
}
// A result is valid only for this exact source, destination and live session.
// Never translate again automatically after settings or the source change.
watch(() => JSON.stringify([props.text, props.field, props.workspace.store.value?.storeId, props.workspace.selectedSessionId.value,
  target.value, language.value, settings.value.lmParameters, settings.value.experimental?.fakeLm]), () => {
  retire(); result.value = ''; failure.value = '';
}, { flush: 'sync' });
watch(() => props.active, active => {
  if (!active && open.value) close();
});
async function translate(): Promise<void> {
  if (translating.value || !open.value || !props.active || !props.text.trim()) return;
  retire(); const token = epoch, abort = new AbortController(); controller = abort;
  const destination = target.value, sourceText = props.text, key = { ...translationKey.value };
  translating.value = true; result.value = ''; resultComplete.value = false; failure.value = '';
  try {
    const translated = await translateImagePrompt({
      prompt: sourceText,
      language: key.language,
      endpoint: destination.endpoint,
      modelId: destination.modelId,
      parameters: cloneLmParameters({ lmParameters: destination.lmParameters }),
      signal: abort.signal,
      onText: ({ text }) => {
        if (!disposed && open.value && token === epoch) result.value = text;
      },
      onProgress: ({ progress: value }) => {
        if (!disposed && open.value && token === epoch) progress.value = value;
      },
      fakeLmDebugModeStatus: settings.value.experimental?.fakeLm ?? 'disabled',
    });
    if (!disposed && open.value && token === epoch) {
      const retained = props.workspace.translationMemory.save({ key, entry: { sourceText, text: translated, createdAt: Date.now() } });
      // A cache admission limit must not discard the successful response. Keep
      // oversized text in the open dialog, without evicting the previous success.
      resultComplete.value = true; result.value = retained ? '' : translated;
    }
  } catch (error) {
    if (!disposed && open.value && token === epoch && !abort.signal.aborted) failure.value = error instanceof Error ? error.message : String(error);
  } finally {
    if (!disposed && token === epoch) {
      translating.value = false; controller = undefined;
    }
  }
}
async function cancel(): Promise<void> {
  retire(); const token = epoch;
  const message = await ensureStrings.imageGeneration__translation_cancelled();
  if (!disposed && open.value && token === epoch) failure.value = message;
}
onScopeDispose(() => {
  disposed = true; retire(); if (open.value) restoreFocus();
});
defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>
<template>
  <button type="button" @click="show" :disabled="(!text.trim() && !previousResult) || !active" :aria-label="lazyStrings.imageGeneration__view_translation()" :title="lazyStrings.imageGeneration__view_translation()" :aria-expanded="open" :aria-controls="id" data-testid="view-prompt-translation" tw-class="inline-flex min-w-8 min-h-8 shrink-0 items-center justify-center rounded-lg px-2 py-1.5 text-xs text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"><LanguagesIcon aria-hidden="true" tw-class="w-3.5 h-3.5" /></button>
  <Teleport to="body">
    <div v-if="open" tw-class="fixed inset-0 z-[110] flex items-center justify-center p-3 sm:p-6 bg-black/40" @click.self="close">
      <section :id="id" ref="dialog" role="dialog" aria-modal="true" :aria-label="lazyStrings.imageGeneration__view_translation()" tabindex="-1" @keydown="keyboard({ event: $event })" data-testid="prompt-translation-dialog" tw-class="flex flex-col w-full max-w-2xl max-h-[90dvh] rounded-2xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-800 dark:text-gray-100 shadow-2xl outline-none">
        <header tw-class="shrink-0 flex items-center justify-between gap-2 border-b border-gray-100 dark:border-gray-800 px-4 py-3"><h2 tw-class="text-sm font-semibold">{{ fieldLabel }} · {{ lazyStrings.imageGeneration__view_translation() }}</h2><button type="button" @click="close" :aria-label="lazyStrings.imageGeneration__translation_close()" data-testid="translation-close" tw-class="rounded-lg p-2 text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800"><XIcon tw-class="w-4 h-4" /></button></header>
        <div tw-class="min-h-0 overflow-y-auto overscroll-contain p-4 space-y-3">
          <p tw-class="text-xs leading-relaxed text-gray-500 dark:text-gray-400">{{ lazyStrings.imageGeneration__translation_read_only() }}</p>
          <ImageSettingsSection compact :title="lazyStrings.imageGeneration__translation_source_text()" :summary="undefined"><p tw-class="text-xs whitespace-pre-wrap break-words">{{ text }}</p></ImageSettingsSection>
          <div tw-class="flex flex-wrap items-end gap-2">
            <label tw-class="min-w-40 flex-1 space-y-1 text-xs"><span>{{ lazyStrings.imageGeneration__translation_language() }}</span><span tw-class="relative block"><select :value="language" @change="changeLanguage({ event: $event })" data-testid="translation-language" tw-class="appearance-none w-full rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 pl-3 pr-9 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"><option v-for="choice in imagePromptTranslationLanguages" :key="choice.locale" :value="choice.locale">{{ choice.name }}</option></select><ChevronDownIcon tw-class="pointer-events-none absolute right-3 top-2 w-4 h-4 text-gray-400" /></span></label>
            <button v-if="!translating" type="button" @click="translate" :disabled="!target.modelId?.trim() || !text.trim()" data-testid="translation-start" tw-class="rounded-xl px-4 py-2 text-xs font-semibold bg-blue-600 hover:bg-blue-700 text-white disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500">{{ lazyStrings.imageGeneration__translation_start() }}</button>
            <button v-else type="button" @click="cancel" data-testid="translation-cancel" tw-class="rounded-xl border border-gray-200 dark:border-gray-700 px-3 py-2 text-xs">{{ lazyStrings.SHARED__cancel() }}</button>
          </div>
          <p tw-class="text-xs break-words text-gray-500 dark:text-gray-400">{{ lazyStrings.imageGeneration__translation_effective() }}: {{ endpointLabel }} · {{ target.modelId || '—' }}</p>
          <p v-if="!target.modelId?.trim()" tw-class="text-xs text-amber-700 dark:text-amber-300">{{ lazyStrings.imageGeneration__translation_choose_model() }}</p>
          <div v-if="result" tw-class="rounded-xl border border-gray-200 dark:border-gray-700 p-3 space-y-2" :data-testid="resultComplete ? 'translation-completed-uncached' : 'translation-partial'">
            <div tw-class="flex items-center justify-between gap-2"><h3 tw-class="text-xs font-semibold">{{ resultComplete ? lazyStrings.imageGeneration__translation_result() : lazyStrings.imageGeneration__translation_partial() }}</h3><ImageGenerationCopyButton :text="result" :label="lazyStrings.imageGeneration__translation_copy()" /></div>
            <p tw-class="text-sm leading-relaxed whitespace-pre-wrap break-words select-text">{{ result }}</p>
          </div>
          <div v-if="previousResult" tw-class="rounded-xl border border-gray-200 dark:border-gray-700 p-3 space-y-2" data-testid="translation-result">
            <div tw-class="flex items-center justify-between gap-2"><h3 tw-class="text-xs font-semibold">{{ lazyStrings.imageGeneration__translation_result() }}</h3><ImageGenerationCopyButton :text="previousResult.text" :label="lazyStrings.imageGeneration__translation_copy()" /></div>
            <p v-if="stale" data-testid="translation-stale" tw-class="text-xs text-gray-500 dark:text-gray-400">{{ lazyStrings.imageGeneration__translation_previous_source() }}</p>
            <p tw-class="text-sm leading-relaxed whitespace-pre-wrap break-words select-text">{{ previousResult.text }}</p>
          </div>
          <p v-if="translating" role="status" tw-class="text-xs text-gray-500 dark:text-gray-400">{{ progressLabel }}<span v-if="progressFraction !== undefined"> · {{ progressFraction }}%</span></p>
          <p v-if="failure" role="alert" tw-class="text-xs text-red-600 dark:text-red-400 break-words">{{ failure }}</p>
          <ImageSettingsSection compact :title="lazyStrings.imageGeneration__translation_session_settings()" :summary="undefined"><ImageGenerationTranslationSettings :workspace="workspace" scope="session" /></ImageSettingsSection>
        </div>
      </section>
    </div>
  </Teleport>
</template>
