<script setup lang="ts">
import { computed } from 'vue';
import { AudioLinesIcon } from 'lucide-vue-next';

const props = defineProps<{ level: number }>();
const waveform = computed(() => {
  const response = Math.min(1, Math.sqrt(Math.max(0, props.level - 0.003) * 8));
  return { '--mic-waveform-scale': 0.62 + response * 0.58 };
});
defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>

<template>
  <AudioLinesIcon aria-hidden="true" data-testid="audio-transcription-microphone-activity" :stroke-width="2.5" :style="waveform" tw-class="h-4 w-4 shrink-0 origin-center scale-x-110 scale-y-[var(--mic-waveform-scale)] text-sky-200 transition-[scale] duration-100 ease-out motion-reduce:scale-y-100 motion-reduce:transition-none dark:text-blue-700" />
</template>
