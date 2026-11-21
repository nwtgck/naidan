<script setup lang="ts">
import { computed } from 'vue';
import { FileAudioIcon, MicIcon } from 'lucide-vue-next';
import { RouterLink, useRoute } from 'vue-router';
import { lazyStrings } from '@/strings';

defineProps<{ expanded: boolean }>();
const route = useRoute();
const inputs = computed(() => [
  { path: '/audio-transcription', icon: MicIcon, title: lazyStrings.AudioTranscriptionSidebar__voice_input() },
  { path: '/audio-transcription/files', icon: FileAudioIcon, title: lazyStrings.AudioTranscriptionSidebar__transcribe_a_file() },
] as const);

defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>

<template>
  <nav :aria-label="lazyStrings.launcher__audio_transcription()" data-testid="audio-transcription-sidebar" :tw-class="['min-h-0 flex-1 space-y-1 overflow-y-auto overscroll-y-contain py-3', expanded ? 'px-3' : 'px-1']">
    <RouterLink v-for="input in inputs" :key="input.path" :to="{ path: input.path, query: route.query }" :aria-current="route.path.replace(/\/+$/, '') === input.path ? 'page' : undefined" :aria-label="input.title" :title="input.title" :tw-class="['flex min-h-9 items-center gap-2 rounded-xl p-2 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500', route.path.replace(/\/+$/, '') === input.path ? 'bg-gray-100 text-gray-900 dark:bg-gray-800 dark:text-white' : 'text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-800', { 'justify-center': !expanded }]">
      <component :is="input.icon" aria-hidden="true" tw-class="h-4 w-4 shrink-0" /><span v-if="expanded">{{ input.title }}</span>
    </RouterLink>
  </nav>
</template>
