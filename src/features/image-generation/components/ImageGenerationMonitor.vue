<script setup lang="ts">
import { computed } from 'vue';
import { ImageIcon, SquareIcon } from 'lucide-vue-next';
import { lazyStrings } from '@/strings';
import { idToRaw } from '@/01-models/ids';
import type { ImageGenerationWorkspaceView } from '@/features/image-generation/composables/use-image-generation-workspace';
import type { ImageGenerationView } from '@/features/image-generation/use-image-generation-types';
import ImageGenerationProgress from './ImageGenerationProgress.vue';
const props = defineProps<{ workspace: ImageGenerationWorkspaceView, generation: ImageGenerationView, active: boolean, compact: boolean }>();
const display = computed(() => props.workspace.sessionPresentation.view);
const mode = computed(() => props.workspace.monitorPresentation.value);
const compositionProgress = computed(() => props.workspace.compositionProgress.value);
const requestPosition = computed(() => {
  const state = compositionProgress.value;
  if (!state || state.status !== 'active' || state.phase !== 'running' || !state.request) {
    return undefined;
  }
  const generating = display.value.progress.value !== undefined || state.request.received === 0;
  return { current: state.index + 1, total: state.total, image: Math.min(state.request.received + (generating ? 1 : 0), state.request.total), images: state.request.total };
});
const compositionPhase = computed(() => {
  const state = compositionProgress.value;
  if (!state || state.status !== 'active') {
    return undefined;
  }
  switch (state.phase) {
  case 'preparing': case 'accepting': return lazyStrings.ImageGenerationMonitor__preparing_generation();
  case 'running': return state.request && (state.request.saving || state.request.received === state.request.total)
    ? lazyStrings.ImageGenerationMonitor__saving_results() : lazyStrings.ImageGenerationMonitor__preparing_generation();
  case 'finishing': return lazyStrings.ImageGenerationMonitor__saving_results();
  default: {
    const exhaustive: never = state.phase;
    throw new Error(String(exhaustive));
  }
  }
});
const compositionResult = computed(() => {
  const status = compositionProgress.value?.status;
  switch (status) {
  case 'completed': return lazyStrings.imageGeneration__completed();
  case 'cancelled': return lazyStrings.stableDiffusionCppBrowser__cancelled();
  case 'failed': return lazyStrings.imageGeneration__failed();
  case 'active': case undefined: return undefined;
  default: {
    const exhaustive: never = status;
    throw new Error(String(exhaustive));
  }
  }
});

function cancel(): void {
  if (props.workspace.compositionRunning.value) {
    props.workspace.cancelComposition();
  } else {
    props.generation.cancel();
  }
}

function togglePresentation(): void {
  const current = mode.value;
  switch (current) {
  case 'visual': void props.workspace.setMonitorPresentation({ presentation: 'compact-progress' });
    break;
  case 'compact-progress': void props.workspace.setMonitorPresentation({ presentation: 'visual' });
    break;
  default: {
    const exhaustive: never = current;
    throw new Error(String(exhaustive));
  }
  }
}

const destination = computed(() => {
  const run = props.workspace.runState.value?.run;
  return run && (props.workspace.sessions.value.find(session => session.id === run.sessionId)?.title ?? idToRaw({ id: run.sessionId }));
});
const selectedRun = computed(() => props.workspace.runState.value?.run?.sessionId === props.workspace.selectedSessionId.value ? props.workspace.runState.value : undefined);
const dimensions = computed(() => display.value.latestRun.value ?? selectedRun.value?.run?.request.parameters ?? props.generation.parameters.value);
const image = computed(() => {
  const latest = display.value.latestRun.value;
  if (!latest) {
    return undefined;
  }
  const status = latest.status;
  switch (status) {
  case 'running': return display.value.livePreview.value;
  case 'succeeded': {
    const result = display.value.results.value[0];
    return result && { url: result.url, width: result.parameters.width, height: result.parameters.height };
  }
  case 'cancelled': case 'failed': return undefined;
  default: {
    const exhaustive: never = status;
    throw new Error(String(exhaustive));
  }
  }
});
defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>
<template>
  <!-- Expensive runtime is shared; the selected session owns its visible result. -->
  <section data-testid="workspace-generation-monitor" tw-class="space-y-3 rounded-2xl border border-gray-200/70 bg-white/80 p-3.5 dark:border-gray-800/80 dark:bg-gray-900/40">
    <header tw-class="flex items-center justify-between gap-3">
      <div tw-class="min-w-0 flex-1 space-y-1">
        <p v-if="compositionProgress" data-testid="operation-image-count" role="status" tw-class="text-sm font-semibold text-gray-700 dark:text-gray-300 tabular-nums">{{ lazyStrings.ImageGenerationMonitor__images_generated({ completed: compositionProgress.completedImages, total: compositionProgress.totalImages }) }}</p>
        <p v-else tw-class="text-xs font-semibold truncate">{{ lazyStrings.imageGeneration__execution() }}<span v-if="selectedRun?.run"> · {{ selectedRun.received }} / {{ selectedRun.run.seeds.length }}</span></p>
        <p v-if="selectedRun?.run && destination && !compositionProgress" tw-class="text-[11px] text-gray-500 dark:text-gray-400 truncate">{{ lazyStrings.imageGeneration__generation_session() }}: {{ destination }}</p>
      </div>
      <button type="button" @click="togglePresentation" :aria-pressed="mode === 'compact-progress'" data-testid="monitor-presentation" tw-class="shrink-0 rounded-lg border border-gray-200 dark:border-gray-700 px-2 py-1 text-xs text-gray-600 dark:text-gray-300">{{ mode === 'visual' ? lazyStrings.imageGeneration__progress_only() : lazyStrings.imageGeneration__visual_progress() }}</button>
      <button v-if="generation.busy.value || workspace.compositionRunning.value" type="button" @click="cancel" :disabled="generation.stopping.value" :aria-label="lazyStrings.SHARED__cancel()" tw-class="shrink-0 rounded-xl border border-gray-200 dark:border-gray-700 p-2 text-gray-500 hover:bg-gray-50 dark:hover:bg-gray-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:opacity-40"><SquareIcon tw-class="w-4 h-4" /></button>
    </header>
    <div v-if="compositionProgress" tw-class="space-y-2 text-xs text-gray-500 dark:text-gray-400">
      <p v-if="requestPosition" data-testid="operation-request-position">{{ lazyStrings.ImageGenerationMonitor__request_position({ current: requestPosition.current, total: requestPosition.total, image: requestPosition.image, images: requestPosition.images }) }}</p>
      <p v-else-if="compositionProgress.status === 'active'">{{ lazyStrings.imageComposition__summary({ requests: compositionProgress.total, images: compositionProgress.totalImages }) }}</p>
      <p v-if="compositionResult" role="status" data-testid="operation-result">{{ compositionResult }}</p>
      <div role="progressbar" :aria-label="lazyStrings.ImageGenerationMonitor__images_generated({ completed: compositionProgress.completedImages, total: compositionProgress.totalImages })" :aria-valuemin="0" :aria-valuemax="compositionProgress.totalImages" :aria-valuenow="compositionProgress.completedImages" data-testid="operation-image-progress" tw-class="h-1 overflow-hidden rounded-full bg-gray-200 dark:bg-gray-700"><div :style="{ width: `${compositionProgress.completedImages / compositionProgress.totalImages * 100}%` }" tw-class="h-full bg-blue-500"></div></div>
      <p v-if="workspace.hasPendingSave.value && compositionProgress.completedImages > compositionProgress.savedImages" data-testid="operation-unsaved-images" tw-class="text-amber-700 dark:text-amber-300">{{ lazyStrings.ImageGenerationMonitor__unsaved_images({ count: compositionProgress.completedImages - compositionProgress.savedImages }) }}</p>
    </div>
    <div v-if="workspace.sessionUseFailure.value" role="alert" tw-class="space-y-1 text-xs text-red-600 dark:text-red-400"><p>{{ workspace.sessionUseFailure.value }}</p><button type="button" @click="workspace.retrySessionUse()" :disabled="workspace.sessionUseSaving.value" tw-class="rounded-lg border border-gray-200 dark:border-gray-700 px-2 py-1 disabled:opacity-40">{{ lazyStrings.imageGeneration__save_retry() }}</button></div>
    <p v-if="workspace.monitorFailure.value" role="alert" tw-class="text-xs text-red-600 dark:text-red-400">{{ workspace.monitorFailure.value }}</p>
    <button v-if="workspace.sessionPresentation.otherRunning.value" type="button" @click="workspace.runState.value?.run && workspace.selectSession({ sessionId: workspace.runState.value.run.sessionId })" tw-class="text-xs text-blue-600 dark:text-blue-400">{{ lazyStrings.imageGeneration__other_session_running() }} · {{ destination }}</button>
    <p v-if="mode === 'compact-progress' && !display.busy.value && !image" tw-class="text-xs text-gray-500 dark:text-gray-400">{{ lazyStrings.imageGeneration__preview_empty() }}</p>
    <div v-if="mode === 'visual' && !display.busy.value && !image" tw-class="flex min-h-64 flex-col items-center justify-center gap-4 rounded-xl bg-gray-50/70 p-8 text-center dark:bg-gray-800/25"><span tw-class="flex h-11 w-11 items-center justify-center rounded-2xl border border-gray-200/70 bg-white text-blue-400 dark:border-gray-700/60 dark:bg-gray-900/60 dark:text-blue-500"><ImageIcon aria-hidden="true" tw-class="h-5 w-5" /></span><p tw-class="max-w-xs text-xs leading-6 text-gray-400 dark:text-gray-500">{{ lazyStrings.imageGeneration__preview_empty() }}</p></div>
    <ImageGenerationProgress :busy="display.busy.value" :supported="generation.supported.value" :active="active" :stopping="display.stopping.value" :progress="display.progress.value" :fallback-phase-label="compositionPhase" :phase-position="compositionProgress ? 'above-preview' : undefined" :width="dimensions.width" :height="dimensions.height" :image="image" :presentation="mode" :started-at="workspace.sessionPresentation.startedAt.value" :size="compact ? 'compact' : 'monitor'" />
    <img v-if="mode === 'visual' && !display.busy.value && image" :src="image.url" :width="image.width" :height="image.height" :alt="lazyStrings.stableDiffusionCppBrowser__preview_title()" tw-class="block max-h-[60vh] max-w-full mx-auto object-contain rounded-xl" />
    <p v-if="display.failure.value" role="alert" tw-class="text-xs text-red-600 dark:text-red-400 break-words">{{ display.failure.value }}</p>
    <div v-if="workspace.hasPendingSave.value" data-testid="workspace-pending-save" role="status" tw-class="space-y-2 text-xs text-amber-700 dark:text-amber-300"><p>{{ lazyStrings.imageGeneration__pending_save() }}</p><p v-if="workspace.runState.value?.failure" tw-class="text-xs break-words">{{ workspace.runState.value.failure }}</p><button type="button" @click="workspace.retrySave()" :disabled="generation.busy.value || workspace.runState.value?.saving" tw-class="rounded-lg px-2 py-1.5 text-blue-600 dark:text-blue-400 border border-gray-200 dark:border-gray-700 disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500">{{ lazyStrings.imageGeneration__save_retry() }}</button></div>
  </section>
</template>
