<script setup lang="ts">
import { computed } from 'vue';
import { Loader2Icon } from 'lucide-vue-next';
import type { LazyVolumeState } from '@/01-models/volume-access';
import { idToRaw } from '@/01-models/ids';
import { lazyStrings } from '@/strings';

const props = defineProps<{ state: LazyVolumeState }>();
const emit = defineEmits<{
  pause: [],
  resume: [],
}>();

const title = computed(() => {
  const { phase, volume } = props.state;
  switch (phase) {
  case 'copying': return lazyStrings.VolumeCopyProgress__copying_name_to_browser({ name: volume.name });
  case 'paused': return lazyStrings.VolumeCopyProgress__copy_paused_name({ name: volume.name });
  case 'failed': return lazyStrings.VolumeCopyProgress__could_not_copy_name({ name: volume.name });
  case 'saved': return undefined;
  default: {
    const exhaustive: never = phase;
    throw new Error(`Unhandled copy phase: ${exhaustive}`);
  }
  }
});
const percentage = computed(() => props.state.progress.total > 0
  ? Math.min(100, props.state.progress.processed / props.state.progress.total * 100)
  : 0);


defineExpose({
  ...((__BUILD_MODE_IS_TEST__ && {
    TEST_ONLY: {
      // Export internal state and logic used only for testing here. Do not reference these in production logic.
      // ESLint-required for defineExpose.
    },
  }) || {}),
});
</script>

<template>
  <div
    v-if="state.phase !== 'saved'"
    :data-volume-id="idToRaw({ id: state.volume.id })"
    data-testid="copy-progress"
    :tw-class="['rounded-xl border px-3 py-2.5', state.phase === 'failed' ? 'border-amber-200/70 bg-amber-50/70 dark:border-amber-800/50 dark:bg-amber-950/15' : 'border-blue-200/70 bg-blue-50/70 dark:border-blue-800/50 dark:bg-blue-950/20']"
  >
    <div tw-class="flex items-start justify-between gap-3">
      <div tw-class="min-w-0 flex-1">
        <p role="status" tw-class="flex items-start gap-1.5 text-xs font-semibold text-gray-700 dark:text-gray-300">
          <Loader2Icon v-if="state.phase === 'copying'" aria-hidden="true" tw-class="mt-0.5 h-3.5 w-3.5 shrink-0 animate-spin text-blue-500 dark:text-blue-400" />
          <span tw-class="break-words">{{ title }}</span>
        </p>
        <p v-if="state.error" tw-class="mt-1 break-words text-xs text-amber-700 dark:text-amber-300">{{ state.error }}</p>
      </div>
      <div tw-class="flex shrink-0 items-center gap-2">
        <span v-if="state.progress.total > 0" tw-class="text-[11px] tabular-nums text-gray-500 dark:text-gray-400">
          {{ state.progress.processed }} / {{ state.progress.total }}
        </span>
        <button
          v-if="state.phase === 'copying'"
          type="button"
          @click="emit('pause')"
          tw-class="min-h-8 rounded-lg border border-blue-200/70 bg-white/60 px-2.5 text-xs font-medium text-blue-600 transition-colors hover:bg-blue-100/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/30 dark:border-blue-800/50 dark:bg-blue-950/20 dark:text-blue-400 dark:hover:bg-blue-900/30"
          data-testid="copy-pause-btn"
        >{{ lazyStrings.VolumeCopyProgress__pause() }}</button>
        <button
          v-else
          type="button"
          @click="emit('resume')"
          tw-class="min-h-8 rounded-lg border border-blue-200/70 bg-white/60 px-2.5 text-xs font-medium text-blue-600 transition-colors hover:bg-blue-100/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/30 dark:border-blue-800/50 dark:bg-blue-950/20 dark:text-blue-400 dark:hover:bg-blue-900/30"
          :data-testid="state.phase === 'failed' ? 'copy-retry-btn' : 'copy-resume-btn'"
        >{{ state.phase === 'failed' ? lazyStrings.VolumeCopyProgress__retry() : lazyStrings.VolumeCopyProgress__resume() }}</button>
      </div>
    </div>
    <div
      role="progressbar"
      :aria-label="title"
      :aria-valuenow="state.progress.processed"
      :aria-valuemin="0"
      :aria-valuemax="Math.max(1, state.progress.total)"
      tw-class="mt-2 h-1 overflow-hidden rounded-full bg-blue-200/60 dark:bg-blue-800/40"
    >
      <div tw-class="h-full rounded-full bg-blue-500 transition-[width] duration-200 dark:bg-blue-400 motion-reduce:transition-none" :style="{ width: `${percentage}%` }"></div>
    </div>
    <p tw-class="mt-2 text-[11px] leading-relaxed text-gray-500 dark:text-gray-400">{{ lazyStrings.VolumeCopyProgress__use_now_copy_is_not_finished() }}</p>
    <p v-if="state.phase === 'paused'" tw-class="mt-0.5 text-[11px] leading-relaxed text-gray-500 dark:text-gray-400">{{ lazyStrings.VolumeCopyProgress__current_file_finishes_before_pausing() }}</p>
  </div>
</template>
