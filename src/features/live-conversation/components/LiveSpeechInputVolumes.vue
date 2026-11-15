<script setup lang="ts">
import { computed, useId } from 'vue';
import SettingsChoiceControl from '@/components/SettingsChoiceControl.vue';
import { lazyStrings } from '@/strings';
import type { SpeechInputLevelSettings } from '@/features/live-conversation/logic/audio-level';

const props = defineProps<{ settings: readonly SpeechInputLevelSettings[], blocked: boolean }>();
const emit = defineEmits<{ change: [value: SpeechInputLevelSettings[]] }>();
const id = useId();
const presets: SpeechInputLevelSettings[] = [
  { kind: 'gain', gain: 0.5 },
  { kind: 'gain', gain: 1 },
  { kind: 'gain', gain: 2 },
  { kind: 'gain', gain: 4 },
  { kind: 'gain', gain: 8 },
  { kind: 'peak', targetPeak: 0.8 },
];
const selected = computed(() => new Set(props.settings.map(value => choiceKey({ value }))));
const choices = computed(() => presets.map(value => ({ key: choiceKey({ value }), value, label: choiceLabel({ value }) })));

function choiceKey({ value }: { value: SpeechInputLevelSettings }): string {
  switch (value.kind) {
  case 'gain': {
    const { kind, gain, ...unhandled } = value;
    unhandled satisfies Record<PropertyKey, never>;
    return `${kind}-${gain}`;
  }
  case 'peak': {
    const { kind, targetPeak, ...unhandled } = value;
    unhandled satisfies Record<PropertyKey, never>;
    return `${kind}-${targetPeak}`;
  }
  default: {
    const exhaustive: never = value;
    throw new Error(String(exhaustive));
  }
  }
}

function choiceLabel({ value }: { value: SpeechInputLevelSettings }): string | undefined {
  switch (value.kind) {
  case 'gain': return `${value.gain}×`;
  case 'peak': return lazyStrings.liveConversation__match_peak_to_percent({ percent: String(value.targetPeak * 100) });
  default: {
    const exhaustive: never = value;
    throw new Error(String(exhaustive));
  }
  }
}

function toggle({ value, event }: { value: SpeechInputLevelSettings, event: Event }): void {
  if (props.blocked || !(event.target instanceof HTMLInputElement)) {
    return;
  }
  const next = new Set(selected.value);
  const key = choiceKey({ value });
  if (event.target.checked) {
    next.add(key);
  } else {
    next.delete(key);
  }
  emit('change', presets.filter(preset => next.has(choiceKey({ value: preset }))));
}

defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>

<template>
  <fieldset :disabled="blocked" :aria-describedby="`${id}-help`" tw-class="space-y-3" data-testid="live-diagnostics-input-levels">
    <legend tw-class="mb-2 text-xs font-medium text-gray-600 dark:text-gray-300">{{ lazyStrings.liveConversation__input_volume() }}</legend>
    <div tw-class="flex flex-wrap gap-2"><label v-for="choice in choices" :key="choice.key" :tw-class="['flex min-h-10 cursor-pointer items-center gap-2 rounded-xl border px-3 py-2 text-xs transition-colors', selected.has(choice.key) ? 'border-blue-200 bg-blue-50 text-blue-600 dark:border-blue-800 dark:bg-blue-900/20 dark:text-blue-400' : 'border-gray-200 text-gray-600 dark:border-gray-700 dark:text-gray-300', blocked ? 'cursor-not-allowed opacity-45' : 'hover:bg-gray-50 dark:hover:bg-gray-800']"><SettingsChoiceControl presentation="checkbox"><input type="checkbox" :checked="selected.has(choice.key)" :disabled="blocked" @change="toggle({ value: choice.value, event: $event })" :data-testid="`live-diagnostics-input-level-${choice.key}`" /></SettingsChoiceControl>{{ choice.label }}</label></div>
    <p :id="`${id}-help`" tw-class="text-[11px] leading-5 text-gray-500 dark:text-gray-400" data-testid="live-diagnostics-input-levels-help">{{ lazyStrings.liveConversation__input_volume_comparison_help() }}</p>
    <p v-if="selected.has('peak-0.8')" tw-class="text-[11px] leading-5 text-gray-500 dark:text-gray-400" data-testid="live-diagnostics-peak-help">{{ lazyStrings.liveConversation__peak_volume_help() }}</p>
  </fieldset>
</template>
