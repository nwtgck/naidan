<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue';
import { DownloadIcon, Trash2Icon } from 'lucide-vue-next';
import { currentLocale, lazyStrings } from '@/strings';
import { audioLanguageOptions } from '@/features/audio-generation/languages';
import type { AudioHistoryEntry } from '@/features/audio-generation/composables/useAudioHistory';

const props = defineProps<{ entry: AudioHistoryEntry }>();
const emit = defineEmits<{ remove: [id: number] }>();
const player = ref<HTMLAudioElement>();
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
    <audio ref="player" :src="entry.url" controls preload="metadata" :aria-label="lazyStrings.audioGeneration__generated_audio()" data-testid="audio-player" tw-class="w-full" />
    <p v-if="entry.result.finishReason !== 'stop'" role="status" data-testid="audio-truncated" tw-class="text-sm text-amber-700 dark:text-amber-400">{{ lazyStrings.audioGeneration__limit_reached() }}</p>
    <div tw-class="flex flex-wrap items-center gap-3">
      <a :href="entry.url" :download="`naidan-audio-${entry.id}.wav`" data-testid="audio-download" tw-class="inline-flex items-center gap-2 rounded-lg bg-gray-100 dark:bg-gray-800 px-4 py-2 text-sm font-medium"><DownloadIcon tw-class="h-4 w-4" />{{ lazyStrings.audioGeneration__save_wav() }}</a>
    </div>
    <details data-testid="audio-result-settings" tw-class="rounded-xl border border-gray-200 dark:border-gray-700 p-4">
      <summary tw-class="cursor-pointer text-sm font-medium">{{ lazyStrings.audioGeneration__generation_settings() }}</summary>
      <div tw-class="space-y-4 pt-4 text-sm">
        <p tw-class="text-xs leading-relaxed text-gray-500 dark:text-gray-400">{{ lazyStrings.audioGeneration__recorded_settings_help() }}</p>
        <dl tw-class="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-3">
          <div tw-class="space-y-1"><dt tw-class="text-gray-500 dark:text-gray-400">{{ lazyStrings.audioGeneration__audio_model() }}</dt><dd tw-class="break-all">{{ entry.settings.model }}</dd></div>
          <div tw-class="space-y-1"><dt tw-class="text-gray-500 dark:text-gray-400">{{ lazyStrings.audioGeneration__language() }}</dt><dd data-testid="audio-result-language">{{ language }}</dd></div>
          <div tw-class="space-y-1"><dt tw-class="text-gray-500 dark:text-gray-400">{{ lazyStrings.audioGeneration__context_tokens() }}</dt><dd>{{ entry.settings.contextTokens }}</dd></div>
          <div tw-class="space-y-1"><dt tw-class="text-gray-500 dark:text-gray-400">{{ lazyStrings.audioGeneration__maximum_steps() }}</dt><dd>{{ entry.settings.maxFrames }}</dd></div>
          <div tw-class="space-y-1"><dt tw-class="text-gray-500 dark:text-gray-400">{{ lazyStrings.audioGeneration__backbone_temperature() }}</dt><dd>{{ entry.settings.temperature }}</dd></div>
          <div tw-class="space-y-1"><dt tw-class="text-gray-500 dark:text-gray-400">{{ lazyStrings.audioGeneration__backbone_top_k() }}</dt><dd>{{ entry.settings.topK }}</dd></div>
          <div tw-class="space-y-1"><dt tw-class="text-gray-500 dark:text-gray-400">{{ lazyStrings.audioGeneration__backbone_top_p() }}</dt><dd>{{ entry.settings.topP }}</dd></div>
          <div tw-class="space-y-1"><dt tw-class="text-gray-500 dark:text-gray-400">{{ lazyStrings.audioGeneration__seed() }}</dt><dd>{{ entry.settings.seed === 4294967295 ? lazyStrings.audioGeneration__random_seed() : entry.settings.seed }}</dd></div>
          <div tw-class="space-y-1"><dt tw-class="text-gray-500 dark:text-gray-400">{{ lazyStrings.audioGeneration__requested_profile() }}</dt><dd>{{ entry.settings.options.profile === 'auto' ? lazyStrings.audioGeneration__automatic_profile() : entry.settings.options.profile }}</dd></div>
          <div tw-class="space-y-1"><dt tw-class="text-gray-500 dark:text-gray-400">{{ lazyStrings.audioGeneration__audio_processor() }}</dt><dd>{{ entry.settings.audioBackend === 'cpu' ? lazyStrings.audioGeneration__cpu_audio() : lazyStrings.audioGeneration__runtime_audio() }}</dd></div>
        </dl>
        <div tw-class="space-y-1"><h4 tw-class="text-gray-500 dark:text-gray-400">{{ lazyStrings.audioGeneration__input_text() }}</h4><p data-testid="audio-result-text" tw-class="max-h-56 overflow-y-auto whitespace-pre-wrap break-words rounded-lg bg-gray-50 dark:bg-gray-800 p-3">{{ entry.settings.text }}</p></div>
      </div>
    </details>
  </article>
</template>
