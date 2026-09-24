<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue';
import { DownloadIcon, Trash2Icon, CopyIcon, CheckIcon } from 'lucide-vue-next';
import { currentLocale, lazyStrings } from '@/strings';
import { audioLanguageOptions } from '@/features/audio-generation/languages';
import type { AudioHistoryEntry } from '@/features/audio-generation/composables/useAudioHistory';

const props = defineProps<{ entry: AudioHistoryEntry }>();
const emit = defineEmits<{ remove: [id: number] }>();
const player = ref<HTMLAudioElement>();
const fullText = ref<HTMLElement>();
const copyState = ref<'idle' | 'copying' | 'copied' | 'failed'>('idle');
let disposed = false;
async function copyText(): Promise<void> {
  const status = copyState.value;
  switch (status) {
  case 'copying': return;
  case 'idle': case 'copied': case 'failed': break;
  default: { const exhaustive: never = status; throw new Error(String(exhaustive)); }
  }
  copyState.value = 'copying';
  try {
    await navigator.clipboard.writeText(props.entry.settings.text);
    if (!disposed) copyState.value = 'copied';
  } catch {
    if (disposed) return;
    copyState.value = 'failed';
    // Clipboard access can be denied (including standalone environments). Keep
    // manual copying possible without deprecated execCommand or a hidden file.
    const element = fullText.value;
    if (element) {
      element.focus();
      const range = document.createRange(); range.selectNodeContents(element);
      const selection = window.getSelection(); selection?.removeAllRanges(); selection?.addRange(range);
    }
  }
}
const language = computed(() => {
  const code = props.entry.settings.language;
  switch (code) {
  case 'default': return lazyStrings.audioGeneration__model_default();
  case 'en': case 'ja': case 'zh': case 'de': case 'it': case 'pt': case 'es': case 'ko': case 'fr': case 'ru':
    return audioLanguageOptions({ locale: currentLocale.value }).find(option => option.value === code)?.label;
  default: { const exhaustive: never = code; throw new Error(String(exhaustive)); }
  }
});
const createdAt = computed(() => new Intl.DateTimeFormat(currentLocale.value, { dateStyle: 'short', timeStyle: 'medium' }).format(props.entry.createdAt));
// Releasing the Blob URL is not sufficient to stop an already-decoded player.
// Detach its source as well when deleted or when the route is left.
onBeforeUnmount(() => {
  disposed = true;
  if (!player.value) return;
  player.value.pause(); player.value.removeAttribute('src'); player.value.load();
});
defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>

<template>
  <article tw-class="rounded-2xl border border-gray-200 dark:border-gray-700 p-5 space-y-4" data-testid="audio-result" :data-history-id="entry.id">
    <div tw-class="flex flex-wrap items-start justify-between gap-3">
      <div tw-class="min-w-0 space-y-1">
        <h3 tw-class="break-all text-sm font-semibold">{{ entry.settings.modelName }}</h3>
        <p tw-class="text-xs text-gray-500 dark:text-gray-400"><time :datetime="new Date(entry.createdAt).toISOString()">{{ createdAt }}</time> · {{ entry.result.pipeline }} · {{ (entry.result.samples / entry.result.sampleRate).toFixed(2) }} s · {{ entry.result.sampleRate }} Hz</p>
      </div>
      <button type="button" @click="emit('remove', entry.id)" data-testid="audio-delete" tw-class="inline-flex items-center gap-2 rounded-lg border border-gray-200 dark:border-gray-700 px-3 py-2 text-sm hover:bg-gray-100 dark:hover:bg-gray-800"><Trash2Icon tw-class="h-4 w-4" />{{ lazyStrings.audioGeneration__delete_audio() }}</button>
    </div>
    <p data-testid="audio-result-preview" tw-class="line-clamp-2 whitespace-pre-line break-words text-sm text-gray-700 dark:text-gray-300">{{ entry.settings.text }}</p>
    <div tw-class="flex min-w-0 items-center gap-2" data-testid="audio-playback-actions">
      <audio ref="player" :src="entry.url" controls preload="metadata" :aria-label="lazyStrings.audioGeneration__generated_audio()" data-testid="audio-player" tw-class="min-w-0 w-0 flex-1" />
      <a :href="entry.url" :download="`naidan-audio-${entry.id}.wav`" :aria-label="lazyStrings.audioGeneration__save_wav()" :title="lazyStrings.audioGeneration__save_wav()" data-testid="audio-download" tw-class="inline-flex shrink-0 items-center gap-2 rounded-lg bg-gray-100 dark:bg-gray-800 p-3 text-sm font-medium"><DownloadIcon tw-class="h-4 w-4" /><span tw-class="sr-only sm:not-sr-only">{{ lazyStrings.audioGeneration__save_wav() }}</span></a>
    </div>
    <p v-if="entry.result.finishReason === 'preview'" role="status" data-testid="audio-preview-result" tw-class="text-sm text-purple-600 dark:text-purple-400">{{ lazyStrings.audioGeneration__preview_result() }}</p>
    <p v-else-if="entry.result.finishReason === 'user-stop'" role="status" data-testid="audio-finished-early" tw-class="text-sm text-gray-600 dark:text-gray-400">{{ lazyStrings.audioGeneration__finished_early() }}</p>
    <p v-else-if="entry.result.finishReason !== 'stop'" role="status" data-testid="audio-truncated" tw-class="text-sm text-amber-700 dark:text-amber-400">{{ lazyStrings.audioGeneration__limit_reached() }}</p>
    <details data-testid="audio-result-settings" tw-class="rounded-xl border border-gray-200 dark:border-gray-700 p-4">
      <summary tw-class="cursor-pointer text-sm font-medium">{{ lazyStrings.audioGeneration__generation_settings() }}</summary>
      <div tw-class="space-y-4 pt-4 text-sm">
        <p tw-class="text-xs leading-relaxed text-gray-500 dark:text-gray-400">{{ lazyStrings.audioGeneration__recorded_settings_help() }}</p>
        <dl tw-class="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-3">
          <div tw-class="space-y-1"><dt tw-class="text-gray-500 dark:text-gray-400">{{ lazyStrings.audioGeneration__audio_model() }}</dt><dd tw-class="break-all">{{ entry.settings.model }}</dd></div>
          <div tw-class="space-y-1"><dt tw-class="text-gray-500 dark:text-gray-400">{{ lazyStrings.audioGeneration__language() }}</dt><dd data-testid="audio-result-language">{{ language }}</dd></div>
          <div tw-class="space-y-1"><dt tw-class="text-gray-500 dark:text-gray-400">{{ lazyStrings.audioGeneration__context_tokens() }}</dt><dd>{{ entry.settings.contextTokens }}</dd></div>
          <div tw-class="space-y-1"><dt tw-class="text-gray-500 dark:text-gray-400">{{ lazyStrings.audioGeneration__captured_steps() }}</dt><dd data-testid="audio-result-steps">{{ entry.result.frames }}</dd></div>
          <div tw-class="space-y-1"><dt tw-class="text-gray-500 dark:text-gray-400">{{ lazyStrings.audioGeneration__maximum_steps() }}</dt><dd>{{ entry.settings.maxFrames }}</dd></div>
          <div tw-class="space-y-1"><dt tw-class="text-gray-500 dark:text-gray-400">{{ lazyStrings.audioGeneration__backbone_temperature() }}</dt><dd>{{ entry.settings.temperature }}</dd></div>
          <div tw-class="space-y-1"><dt tw-class="text-gray-500 dark:text-gray-400">{{ lazyStrings.audioGeneration__backbone_top_k() }}</dt><dd>{{ entry.settings.topK }}</dd></div>
          <div tw-class="space-y-1"><dt tw-class="text-gray-500 dark:text-gray-400">{{ lazyStrings.audioGeneration__backbone_top_p() }}</dt><dd>{{ entry.settings.topP }}</dd></div>
          <div tw-class="space-y-1"><dt tw-class="text-gray-500 dark:text-gray-400">{{ lazyStrings.audioGeneration__seed() }}</dt><dd>{{ entry.settings.seed === 4294967295 ? lazyStrings.audioGeneration__random_seed() : entry.settings.seed }}</dd></div>
          <div tw-class="space-y-1"><dt tw-class="text-gray-500 dark:text-gray-400">{{ lazyStrings.audioGeneration__requested_profile() }}</dt><dd>{{ entry.settings.options.profile === 'auto' ? lazyStrings.audioGeneration__automatic_profile() : entry.settings.options.profile }}</dd></div>
          <div tw-class="space-y-1"><dt tw-class="text-gray-500 dark:text-gray-400">{{ lazyStrings.audioGeneration__audio_processor() }}</dt><dd>{{ entry.settings.audioBackend === 'cpu' ? lazyStrings.audioGeneration__cpu_audio() : lazyStrings.audioGeneration__runtime_audio() }}</dd></div>
        </dl>
        <div tw-class="space-y-2">
          <div tw-class="flex items-center justify-between gap-2">
            <h4 tw-class="text-gray-500 dark:text-gray-400">{{ lazyStrings.audioGeneration__input_text() }}</h4>
            <button type="button" :disabled="copyState === 'copying'" @click="copyText" data-testid="audio-copy-text" tw-class="inline-flex items-center gap-2 rounded-lg border border-gray-200 dark:border-gray-700 px-3 py-2 text-xs disabled:opacity-50"><CheckIcon v-if="copyState === 'copied'" tw-class="h-4 w-4" /><CopyIcon v-else tw-class="h-4 w-4" />{{ copyState === 'copied' ? lazyStrings.audioGeneration__text_copied() : lazyStrings.audioGeneration__copy_text() }}</button>
          </div>
          <p ref="fullText" tabindex="0" data-testid="audio-result-text" tw-class="max-h-56 overflow-y-auto whitespace-pre-wrap break-words select-text rounded-lg bg-gray-50 dark:bg-gray-800 p-3">{{ entry.settings.text }}</p>
          <p v-if="copyState === 'failed'" role="status" data-testid="audio-copy-error" tw-class="text-xs text-amber-700 dark:text-amber-400">{{ lazyStrings.audioGeneration__copy_failed_select_text() }}</p>
        </div>
      </div>
    </details>
  </article>
</template>
