<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, useId } from 'vue';
import SettingsFormSelect from '@/components/SettingsFormSelect.vue';
import type { LiveSpeechInputLevel } from '@/features/live-conversation/logic/speech-controller';
import type { LiveAudioStatistics } from '@/features/live-conversation/logic/audio-file';
import { currentLocale, lazyStrings } from '@/strings';

const props = defineProps<{ level: LiveSpeechInputLevel, muted: boolean, blocked: boolean }>();
const emit = defineEmits<{ gain: [value: number], observe: [value: 'on' | 'off'] }>();
const id = useId();
const expanded = ref(false);
const multipliers = [0.5, 1, 2, 4, 8] as const;
const options = computed(() => multipliers.map(value => ({ value, label: `${value}×` })));
const processing = computed(() => [
  { key: 'agc', label: lazyStrings.liveConversation__live_input_auto_gain_control(), value: props.level.captureSettings?.autoGainControl },
  { key: 'aec', label: lazyStrings.liveConversation__live_input_echo_cancellation(), value: props.level.captureSettings?.echoCancellation },
  { key: 'ns', label: lazyStrings.liveConversation__live_input_noise_suppression(), value: props.level.captureSettings?.noiseSuppression },
]);

onMounted(() => emit('observe', 'off'));
onBeforeUnmount(() => emit('observe', 'off'));

function toggle({ event }: { event: Event }): void {
  if (!(event.target instanceof HTMLDetailsElement) || expanded.value === event.target.open) {
    return;
  }
  expanded.value = event.target.open;
  emit('observe', expanded.value ? 'on' : 'off');
}

function choose({ gain }: { gain: number }): void {
  if (!props.blocked && multipliers.some(value => value === gain) && gain !== props.level.gain) {
    emit('gain', gain);
  }
}

function statistics({ value }: { value: LiveAudioStatistics }): string | undefined {
  const format = new Intl.NumberFormat(currentLocale.value, { maximumSignificantDigits: 4 });
  return lazyStrings.liveConversation__audio_statistics({ seconds: format.format(value.seconds), sampleRate: value.sampleRate, peak: format.format(value.peak), rms: format.format(value.rms), clipped: value.clippedSamples });
}

function processingValue({ value }: { value: boolean | undefined }): string | undefined {
  switch (value) {
  case true: return lazyStrings.liveConversation__live_input_processing_on();
  case false: return lazyStrings.liveConversation__live_input_processing_off();
  case undefined: return lazyStrings.liveConversation__setting_unknown();
  default: {
    const exhaustive: never = value;
    throw new Error(String(exhaustive));
  }
  }
}

defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>

<template>
  <details tw-class="rounded-xl border border-gray-200/70 px-4 py-3 text-xs dark:border-gray-800" @toggle="toggle({ event: $event })" data-testid="live-speech-input-level">
    <summary tw-class="cursor-pointer font-medium text-gray-600 dark:text-gray-300">{{ lazyStrings.liveConversation__input_volume() }}<span tw-class="ml-2 tabular-nums text-gray-400 dark:text-gray-500">{{ level.gain }}×</span></summary>
    <div v-if="expanded" tw-class="mt-4 space-y-4">
      <div tw-class="space-y-2"><label :for="`${id}-gain`" tw-class="block font-medium text-gray-600 dark:text-gray-300">{{ lazyStrings.liveConversation__set_volume_multiplier() }}</label><span tw-class="block w-36"><SettingsFormSelect :id="`${id}-gain`" :model-value="level.gain" :options="options" :label="lazyStrings.liveConversation__set_volume_multiplier()" :disabled="blocked" @update:model-value="choose({ gain: $event })" data-testid="live-speech-input-gain" /></span><p tw-class="text-[11px] leading-5 text-gray-500 dark:text-gray-400">{{ lazyStrings.liveConversation__live_input_level_help() }}</p></div>
      <p v-if="muted" role="status" tw-class="text-xs text-gray-500 dark:text-gray-400" data-testid="live-speech-input-muted">{{ lazyStrings.liveConversation__microphone_muted() }}</p>
      <div v-if="level.window" tw-class="space-y-3" data-testid="live-speech-input-level-window">
        <div><h3 tw-class="mb-1 font-medium text-gray-600 dark:text-gray-300">{{ lazyStrings.liveConversation__input_before_volume_adjustment() }}</h3><p tw-class="break-words font-mono text-[11px] leading-5 tabular-nums text-gray-500 dark:text-gray-400" data-testid="live-speech-input-before">{{ statistics({ value: level.window.before }) }}</p></div>
        <div><h3 tw-class="mb-1 font-medium text-gray-600 dark:text-gray-300">{{ lazyStrings.liveConversation__submitted_input_audio() }}</h3><p tw-class="break-words font-mono text-[11px] leading-5 tabular-nums text-gray-500 dark:text-gray-400" data-testid="live-speech-input-after">{{ statistics({ value: level.window.after }) }}</p></div>
        <p v-if="level.window.clippedSamples > 0" role="status" tw-class="text-xs leading-6 text-amber-700 dark:text-amber-300" data-testid="live-speech-input-clipped">{{ lazyStrings.liveConversation__live_input_clipped() }}</p>
      </div>
      <p v-else role="status" tw-class="text-xs text-gray-500 dark:text-gray-400" data-testid="live-speech-input-level-pending">{{ lazyStrings.liveConversation__input_level_not_observed() }}</p>
      <div tw-class="space-y-2 border-t border-gray-200/70 pt-3 dark:border-gray-800"><h3 tw-class="font-medium text-gray-600 dark:text-gray-300">{{ lazyStrings.liveConversation__capture_processing() }}</h3><dl tw-class="space-y-1 text-[11px] text-gray-500 dark:text-gray-400"><div v-for="setting in processing" :key="setting.key" tw-class="flex flex-wrap justify-between gap-2"><dt>{{ setting.label }}</dt><dd :data-testid="`live-speech-input-${setting.key}`">{{ processingValue({ value: setting.value }) }}</dd></div></dl></div>
    </div>
  </details>
</template>
