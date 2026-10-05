<script setup lang="ts">
import { computed } from 'vue';
import { SquareIcon } from 'lucide-vue-next';
import { lazyStrings } from '@/strings';
import { idToRaw } from '@/01-models/ids';
import type { ImageGenerationWorkspaceView } from '@/features/image-generation/composables/use-image-generation-workspace';
import type { ImageGenerationView } from '@/features/image-generation/use-image-generation-types';
import ImageGenerationProgress from './ImageGenerationProgress.vue';
const props = defineProps<{ workspace: ImageGenerationWorkspaceView, generation: ImageGenerationView, active: boolean, compact: boolean }>();
const destination = computed(() => {
  const run = props.workspace.runState.value?.run;
  return run && (props.workspace.sessions.value.find(session => session.id === run.sessionId)?.title ?? idToRaw({ id: run.sessionId }));
});
const dimensions = computed(() => props.generation.latestRun.value ?? props.workspace.runState.value?.run?.request.parameters ?? props.generation.parameters.value);
const image = computed(() => {
  const latest = props.generation.latestRun.value;
  if (!latest) return undefined;
  const status = latest.status;
  switch (status) {
  case 'running': return props.generation.livePreview.value;
  case 'succeeded': {
    const result = props.generation.results.value[0];
    return result && { url: result.url, width: result.parameters.width, height: result.parameters.height };
  }
  case 'cancelled': case 'failed': return undefined;
  default: { const exhaustive: never = status; throw new Error(String(exhaustive)); }
  }
});
defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>
<template>
  <!-- The owner is the active run, NOT the session currently being browsed. -->
  <section data-testid="workspace-generation-monitor" tw-class="rounded-2xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 p-3 space-y-2">
    <header tw-class="flex items-center justify-between gap-3">
      <div tw-class="min-w-0 space-y-1"><p tw-class="text-xs font-semibold truncate">{{ lazyStrings.imageGeneration__execution() }}<span v-if="workspace.runState.value?.run"> · {{ workspace.runState.value.received }} / {{ workspace.runState.value.run.seeds.length }}</span></p><p v-if="destination" tw-class="text-[11px] text-gray-500 dark:text-gray-400 truncate">{{ lazyStrings.imageGeneration__generation_session() }}: {{ destination }}</p></div>
      <button v-if="generation.busy.value" type="button" @click="generation.cancel()" :disabled="generation.stopping.value" :aria-label="lazyStrings.SHARED__cancel()" tw-class="shrink-0 rounded-xl border border-gray-200 dark:border-gray-700 p-2 text-gray-500 hover:bg-gray-50 dark:hover:bg-gray-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:opacity-40"><SquareIcon tw-class="w-4 h-4" /></button>
    </header>
    <p v-if="!generation.busy.value && !image" tw-class="flex min-h-64 items-center justify-center p-8 text-sm text-center text-gray-500 dark:text-gray-400">{{ lazyStrings.imageGeneration__preview_empty() }}</p>
    <ImageGenerationProgress :busy="generation.busy.value" :supported="generation.supported.value" :active="active" :stopping="generation.stopping.value" :progress="generation.progress.value" :width="dimensions.width" :height="dimensions.height" :image="image" :size="compact ? 'compact' : 'monitor'" />
    <img v-if="!generation.busy.value && image" :src="image.url" :width="image.width" :height="image.height" :alt="lazyStrings.stableDiffusionCppBrowser__preview_title()" tw-class="block max-h-[60vh] max-w-full mx-auto object-contain rounded-xl" />
    <div v-if="workspace.hasPendingSave.value" data-testid="workspace-pending-save" role="status" tw-class="space-y-2 text-xs text-amber-700 dark:text-amber-300"><p>{{ lazyStrings.imageGeneration__pending_save() }}</p><p v-if="workspace.runState.value?.failure" tw-class="text-xs break-words">{{ workspace.runState.value.failure }}</p><button type="button" @click="workspace.retrySave()" :disabled="generation.busy.value || workspace.runState.value?.saving" tw-class="rounded-lg px-2 py-1.5 text-blue-600 dark:text-blue-400 border border-gray-200 dark:border-gray-700 disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500">{{ lazyStrings.imageGeneration__save_retry() }}</button></div>
  </section>
</template>
