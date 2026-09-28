<script setup lang="ts">
import { computed, onBeforeUnmount, watch } from 'vue';
import ImageSettingsSection from './ImageSettingsSection.vue';
import { lazyStrings } from '@/strings';
import type { ImageGenerationView } from '@/features/stable-diffusion-cpp-browser/use-image-generation-types';

const props = defineProps<{ view: ImageGenerationView, active: boolean }>();
const state = props.view.engineState;

// The pane stays mounted when the user switches tabs. Closing it stops all
// observation, including a lifecycle refresh that would otherwise run later.
watch(() => props.active, active => {
  if (!active) state.setOpened({ opened: false });
});
onBeforeUnmount(() => state.setOpened({ opened: false }));

const phase = computed(() => {
  const progress = props.view.progress.value;
  if (!progress) return lazyStrings.llamaCppBrowserDownloads__waiting();
  switch (progress.phase) {
  case 'runtime': return lazyStrings.stableDiffusionCppBrowser__loading_runtime();
  case 'model': return lazyStrings.stableDiffusionCppBrowser__loading_model();
  case 'sampling': return lazyStrings.stableDiffusionCppBrowser__sampling();
  case 'decoding': return lazyStrings.stableDiffusionCppBrowser__decoding_image();
  case 'encoding': return lazyStrings.stableDiffusionCppBrowser__encoding();
  default: { const exhaustive: never = progress.phase; throw new Error(String(exhaustive)); }
  }
});
const summary = computed(() => {
  if (state.snapshot.value) return state.snapshot.value.modelVersion || lazyStrings.ImageEngineState__unknown_model();
  switch (state.status.value) {
  case 'failed': return lazyStrings.ImageEngineState__could_not_read_state();
  case 'refreshing': return lazyStrings.ImageEngineState__refreshing();
  case 'idle': case 'unavailable': break;
  default: { const exhaustive: never = state.status.value; throw new Error(String(exhaustive)); }
  }
  switch (state.reason.value) {
  case 'unsupported': return lazyStrings.ImageEngineState__unavailable();
  case 'released': return lazyStrings.ImageEngineState__released();
  case 'not-loaded': return lazyStrings.ImageEngineState__no_model_loaded();
  case 'busy': return lazyStrings.ImageEngineState__engine_busy_until_idle();
  case undefined: break;
  default: { const exhaustive: never = state.reason.value; throw new Error(String(exhaustive)); }
  }
  if (!props.view.supported.value) return lazyStrings.ImageEngineState__unavailable();
  if (!props.view.modelResident.value) return lazyStrings.ImageEngineState__no_model_loaded();
  return lazyStrings.ImageEngineState__not_observed_yet();
});
function formatBytes({ bytes }: { bytes: string | number }): string {
  const value = BigInt(bytes);
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'];
  let scale = 1n, unit = 0;
  while (unit < units.length - 1 && value >= scale * 1024n) {
    scale *= 1024n;
    unit += 1;
  }
  const amount = Number(value / scale) + Number(value % scale) / Number(scale);
  return `${new Intl.NumberFormat(undefined, { maximumFractionDigits: unit ? 1 : 0 }).format(amount)} ${units[unit]}`;
}
const observedTime = computed(() => {
  const at = state.snapshot.value?.collectedAt;
  return at === undefined ? undefined : new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit', second: '2-digit' }).format(new Date(at));
});
const memory = computed(() => {
  const snapshot = state.snapshot.value;
  if (!snapshot) return [];
  const values = snapshot.memory;
  return [
    { measure: 'wasm' as const, bytes: formatBytes({ bytes: snapshot.wasmCapacityBytes }) },
    { measure: 'file-cache' as const, bytes: formatBytes({ bytes: snapshot.fileReadCacheBytes }) },
    { measure: 'model-tensors' as const, bytes: formatBytes({ bytes: values.registeredTensorBytes }) },
    { measure: 'host-buffers' as const, bytes: formatBytes({ bytes: values.managerHostBufferBytes }) },
    { measure: 'non-host-buffers' as const, bytes: formatBytes({ bytes: values.managerDeviceBufferBytes }) },
    { measure: 'last-cpu-buffers' as const, bytes: formatBytes({ bytes: values.trackedRuntimeCpuBytes }) },
    { measure: 'last-non-cpu-buffers' as const, bytes: formatBytes({ bytes: values.trackedRuntimeNonCpuBytes }) },
    { measure: 'last-unknown-buffers' as const, bytes: formatBytes({ bytes: values.trackedRuntimeUnknownBytes }) },
  ];
});
defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>

<template>
  <ImageSettingsSection :title="lazyStrings.ImageEngineState__engine_state()" :summary="summary" :open="state.opened.value" @update:open="state.setOpened({ opened: $event && active })" data-testid="image-engine-state">
    <div tw-class="flex flex-wrap items-center justify-between gap-3">
      <p v-if="state.snapshot.value && observedTime" data-testid="image-engine-observed-at" tw-class="text-xs text-gray-500 dark:text-gray-400">{{ lazyStrings.ImageEngineState__observed_at({ time: observedTime }) }}</p>
      <button type="button" :disabled="!state.canRefresh.value" @click="state.refresh()" data-testid="image-engine-refresh" tw-class="ml-auto min-h-10 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-xs font-bold text-blue-600 dark:text-blue-400 shadow-sm transition-colors hover:bg-blue-50 dark:hover:bg-blue-900/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:opacity-40 disabled:cursor-not-allowed">{{ state.status.value === 'refreshing' ? lazyStrings.ImageEngineState__refreshing() : lazyStrings.ImageEngineState__refresh_state() }}</button>
    </div>
    <p v-if="view.busy.value" role="status" data-testid="image-engine-busy" tw-class="text-xs leading-relaxed text-amber-700 dark:text-amber-300">{{ lazyStrings.ImageEngineState__busy_during_generation({ phase: phase ?? '' }) }}</p>
    <p v-else-if="state.reason.value === 'busy'" role="status" data-testid="image-engine-busy" tw-class="text-xs leading-relaxed text-amber-700 dark:text-amber-300">{{ lazyStrings.ImageEngineState__engine_busy_until_idle() }}</p>
    <p v-else-if="state.reason.value === 'unsupported' || !view.supported.value" role="status" tw-class="text-xs text-gray-500 dark:text-gray-400">{{ lazyStrings.ImageEngineState__unavailable() }}</p>
    <p v-else-if="state.reason.value === 'released'" role="status" tw-class="text-xs text-gray-500 dark:text-gray-400">{{ lazyStrings.ImageEngineState__released() }}</p>
    <p v-else-if="state.reason.value === 'not-loaded' || !view.modelResident.value" role="status" tw-class="text-xs text-gray-500 dark:text-gray-400">{{ lazyStrings.ImageEngineState__no_model_loaded() }}</p>
    <p v-else-if="!state.snapshot.value && state.status.value === 'idle'" role="status" tw-class="text-xs text-gray-500 dark:text-gray-400">{{ lazyStrings.ImageEngineState__not_observed_yet() }}</p>
    <p v-if="state.status.value === 'failed'" role="alert" data-testid="image-engine-error" tw-class="text-xs text-red-600 dark:text-red-400 break-words">{{ lazyStrings.ImageEngineState__could_not_read_state() }} {{ state.error.value }}</p>
    <template v-if="state.snapshot.value">
      <div tw-class="space-y-2">
        <h3 tw-class="text-xs font-bold text-gray-800 dark:text-gray-100">{{ lazyStrings.ImageEngineState__runtime_and_model() }}</h3>
        <dl tw-class="grid gap-x-4 gap-y-2 text-xs sm:grid-cols-2">
          <div tw-class="min-w-0"><dt tw-class="text-gray-500 dark:text-gray-400">{{ lazyStrings.ImageEngineState__detail_label({ detail: 'model' }) }}</dt><dd tw-class="font-medium break-words">{{ state.snapshot.value.modelVersion || lazyStrings.ImageEngineState__unknown_model() }}</dd></div>
          <div tw-class="min-w-0"><dt tw-class="text-gray-500 dark:text-gray-400">{{ lazyStrings.ImageEngineState__detail_label({ detail: 'profile' }) }}</dt><dd tw-class="font-medium break-words">{{ state.snapshot.value.profile }}</dd></div>
          <div tw-class="min-w-0"><dt tw-class="text-gray-500 dark:text-gray-400">{{ lazyStrings.ImageEngineState__detail_label({ detail: 'source' }) }}</dt><dd tw-class="font-mono break-all">{{ state.snapshot.value.source }}</dd></div>
          <div tw-class="min-w-0"><dt tw-class="text-gray-500 dark:text-gray-400">{{ lazyStrings.ImageEngineState__detail_label({ detail: 'threads' }) }}</dt><dd tw-class="font-medium tabular-nums">{{ state.snapshot.value.runtime.nThreads }}</dd></div>
        </dl>
      </div>
      <div tw-class="space-y-2">
        <h3 tw-class="text-xs font-bold text-gray-800 dark:text-gray-100">{{ lazyStrings.ImageEngineState__memory_observations() }}</h3>
        <dl tw-class="grid gap-2 text-xs sm:grid-cols-2">
          <div v-for="item in memory" :key="item.measure" tw-class="min-w-0 rounded-lg border border-gray-100 dark:border-gray-700 bg-white/60 dark:bg-gray-900/30 px-3 py-2">
            <dt tw-class="text-gray-500 dark:text-gray-400 leading-relaxed">{{ lazyStrings.ImageEngineState__memory_label({ measure: item.measure }) }}</dt>
            <dd :data-testid="'image-engine-memory-' + item.measure" tw-class="font-mono font-semibold tabular-nums text-gray-800 dark:text-gray-100">{{ item.bytes }}</dd>
          </div>
        </dl>
        <p tw-class="text-xs leading-relaxed text-gray-500 dark:text-gray-400">{{ lazyStrings.ImageEngineState__runtime_buffer_reports_may_be_missing() }}</p>
        <p tw-class="text-xs leading-relaxed text-gray-500 dark:text-gray-400">{{ lazyStrings.ImageEngineState__memory_values_are_not_total_gpu_memory() }}</p>
        <p v-if="state.snapshot.value.memory.saturated" role="status" tw-class="text-xs text-amber-700 dark:text-amber-300">{{ lazyStrings.ImageEngineState__some_counters_saturated() }}</p>
      </div>
    </template>
  </ImageSettingsSection>
</template>
