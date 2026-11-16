<script setup lang="ts">
import { AudioLinesIcon, FolderOpenIcon, HeadphonesIcon } from 'lucide-vue-next';
import { RouterLink, useRoute } from 'vue-router';
import { lazyStrings } from '@/strings';
import { revealAudioGenerationSection } from '@/features/audio-generation/navigation';

defineProps<{ expanded: boolean }>();
const route = useRoute();
const entries = [
  { hash: '#audio-generation-input', icon: AudioLinesIcon, title: () => lazyStrings.audioGeneration__audio_generation() },
  { hash: '#audio-generation-models', icon: FolderOpenIcon, title: () => lazyStrings.audioGeneration__manage_models_and_runtime() },
  { hash: '#audio-generation-results', icon: HeadphonesIcon, title: () => lazyStrings.audioGeneration__generated_audio() },
] as const;

function reopen({ event, hash }: { event: MouseEvent, hash: string }): void {
  if (!event.defaultPrevented && event.button === 0 && !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey && route.hash === hash) {
    revealAudioGenerationSection({ hash, root: document });
  }
}

defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>

<template>
  <nav data-testid="audio-generation-sidebar" :aria-label="lazyStrings.audioGeneration__audio_generation()" :tw-class="['min-h-0 flex-1 space-y-1 overflow-y-auto overscroll-y-contain py-3', expanded ? 'px-3' : 'px-1']">
    <RouterLink v-for="entry in entries" :key="entry.hash" :to="{ path: '/audio-generation', query: route.query, hash: entry.hash }" :aria-current="route.hash === entry.hash || (!route.hash && entry.hash === '#audio-generation-input') ? 'location' : undefined" :aria-label="entry.title()" :title="entry.title()" :data-testid="`audio-nav-${entry.hash.slice('#audio-generation-'.length)}`" :tw-class="['flex min-h-9 items-center gap-2 rounded-xl p-2 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500', route.hash === entry.hash || (!route.hash && entry.hash === '#audio-generation-input') ? 'bg-gray-100 text-gray-900 dark:bg-gray-800 dark:text-white' : 'text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-800']" @click.capture="reopen({ event: $event, hash: entry.hash })">
      <component :is="entry.icon" aria-hidden="true" tw-class="h-4 w-4 shrink-0" /><span v-if="expanded">{{ entry.title() }}</span>
    </RouterLink>
  </nav>
</template>
