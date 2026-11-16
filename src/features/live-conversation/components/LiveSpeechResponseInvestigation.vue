<script setup lang="ts">
import { computed, onBeforeUnmount, ref, useId } from 'vue';
import { Loader2Icon, PlayIcon, SquareIcon } from 'lucide-vue-next';
import { lazyStrings } from '@/strings';
import type { SpeechInputLevelSettings } from '@/features/live-conversation/logic/audio-level';
import type { SpeechFileRunState, SpeechInputPacing } from '@/features/live-conversation/logic/speech-file-run';
import { speechSampleRate } from '@/features/speech-cpp-browser/types';
import SettingsFormSelect from '@/components/SettingsFormSelect.vue';
import LiveSpeechResponseResult from './LiveSpeechResponseResult.vue';
import LiveSpeechInputVolumes from './LiveSpeechInputVolumes.vue';
import type { SpeechResponseResultView } from '@/features/live-conversation/logic/response-result-views';
import type { SpeechInvestigationCollectionSnapshot } from '@/features/speech-cpp-browser/investigation/types';

const props = defineProps<{
  file: File | undefined,
  run: SpeechFileRunState | undefined,
  text: string,
  busy: boolean,
  blocked: boolean,
  canGenerate: boolean,
  unavailable: string | undefined,
  selectionFailure: string | undefined,
  tailSeconds: number,
  seed: number,
  inputPacing: SpeechInputPacing,
  inputLevels: readonly SpeechInputLevelSettings[],
  results: readonly SpeechResponseResultView[],
  comparison: SpeechInvestigationCollectionSnapshot | undefined,
  queuedSamples: number,
  modelLoadMilliseconds: number | undefined,
}>();
const emit = defineEmits<{ generate: [], cancel: [], settings: [], seed: [value: number], inputPacing: [value: SpeechInputPacing], inputLevels: [value: SpeechInputLevelSettings[]], replayStart: [element: HTMLAudioElement], replayEnd: [element: HTMLAudioElement] }>();
const id = useId();
const pacingOptions = computed<{ value: SpeechInputPacing, label: string | undefined }[]>(() => [
  { value: 'fast', label: lazyStrings.liveConversation__as_fast_as_possible() },
  { value: 'real_time', label: lazyStrings.liveConversation__real_time_pace() },
]);
const completedRunIds = computed(() => new Set(props.results.map(result => result.run.id)));
const comparisonCounts = computed(() => {
  let completed = 0;
  let notRun = 0;
  for (const trial of props.comparison?.trials ?? []) {
    switch (trial.status) {
    case 'not_run': notRun++;
      break;
    case 'in_progress': break;
    case 'completed': case 'partial': case 'cancelled': case 'failed': completed++;
      break;
    default: {
      const exhaustive: never = trial;
      throw new Error(String(exhaustive));
    }
    }
  }
  return { completed, notRun };
});
const pacingHelp = computed(() => {
  switch (props.inputPacing) {
  case 'fast': return lazyStrings.liveConversation__fast_input_pacing_help();
  case 'real_time': return lazyStrings.liveConversation__real_time_input_pacing_help();
  default: {
    const exhaustive: never = props.inputPacing;
    throw new Error(String(exhaustive));
  }
  }
});
const root = ref<HTMLElement>();
const failure = computed(() => props.selectionFailure);
const stage = computed(() => {
  const value = props.run?.stage;
  switch (value) {
  case 'preparing_input': return lazyStrings.liveConversation__preparing_audio();
  case 'starting_dialogue': return lazyStrings.liveConversation__starting_dialogue();
  case 'feeding_input': return lazyStrings.liveConversation__sending_input_audio();
  case 'draining_input': return lazyStrings.liveConversation__processing_remaining_input();
  case 'saving_output': return lazyStrings.liveConversation__preparing_output_audio();
  case 'finished': return lazyStrings.liveConversation__generation_complete();
  case undefined: return undefined;
  default: {
    const exhaustive: never = value;
    throw new Error(String(exhaustive));
  }
  }
});
const status = computed(() => {
  if (props.busy && props.run) {
    return stage.value;
  }
  const phase = props.run?.status;
  switch (phase) {
  case 'decoding': case 'running': return stage.value;
  case 'complete': return lazyStrings.liveConversation__generation_complete();
  case 'partial': return lazyStrings.liveConversation__generation_stopped();
  case 'failed': return lazyStrings.liveConversation__failed();
  case undefined: return undefined;
  default: {
    const exhaustive: never = phase;
    throw new Error(String(exhaustive));
  }
  }
});

function editSeed({ event }: { event: Event }): void {
  if (event.target instanceof HTMLInputElement && !props.busy && !props.blocked) {
    emit('seed', event.target.valueAsNumber);
  }
}

onBeforeUnmount(pauseAudio);

function replayStarted({ element }: { element: HTMLAudioElement }): void {
  for (const audio of root.value?.querySelectorAll('audio') ?? []) {
    if (audio !== element) {
      audio.pause();
    }
  }
  emit('replayStart', element);
}

function pauseAudio(): void {
  for (const audio of root.value?.querySelectorAll('audio') ?? []) {
    audio.pause();
  }
}

defineExpose({ pauseAudio, ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>

<template>
  <section ref="root" tw-class="space-y-5" data-testid="live-response-investigation">
    <div tw-class="space-y-2 border-t border-gray-100 pt-4 dark:border-gray-700/60"><label :for="`${id}-pacing`" tw-class="block text-xs font-medium text-gray-600 dark:text-gray-300">{{ lazyStrings.liveConversation__input_pacing() }}</label><span tw-class="block w-full sm:max-w-xs"><SettingsFormSelect :id="`${id}-pacing`" :model-value="inputPacing" :options="pacingOptions" :label="lazyStrings.liveConversation__input_pacing()" :disabled="busy || blocked" :aria-describedby="`${id}-pacing-help`" @update:model-value="emit('inputPacing', $event)" data-testid="live-diagnostics-pacing" /></span><p :id="`${id}-pacing-help`" tw-class="text-[11px] leading-5 text-gray-500 dark:text-gray-400" data-testid="live-diagnostics-pacing-help">{{ pacingHelp }}</p></div>
    <LiveSpeechInputVolumes :settings="inputLevels" :blocked="busy || blocked" @change="emit('inputLevels', $event)" />
    <div tw-class="flex flex-wrap items-center gap-3"><button v-if="!busy" type="button" :disabled="!file || !canGenerate || !inputLevels.length" @click="emit('generate')" tw-class="inline-flex min-h-10 items-center gap-2 rounded-xl bg-blue-600 px-4 py-2.5 text-xs font-medium text-white shadow-sm shadow-blue-500/20 hover:bg-blue-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:cursor-not-allowed disabled:bg-gray-200 disabled:text-gray-400 disabled:shadow-none dark:disabled:bg-gray-700 dark:disabled:text-gray-500" data-testid="live-diagnostics-generate"><PlayIcon aria-hidden="true" tw-class="h-4 w-4" />{{ run || results.length ? lazyStrings.liveConversation__generate_again() : lazyStrings.liveConversation__generate_response() }}</button><button v-else type="button" @click="emit('cancel')" tw-class="inline-flex min-h-10 items-center gap-2 rounded-xl border border-gray-200 px-4 py-2.5 text-xs font-medium text-gray-700 hover:bg-gray-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:border-gray-700 dark:text-gray-200 dark:hover:bg-gray-800" data-testid="live-diagnostics-cancel"><SquareIcon aria-hidden="true" tw-class="h-4 w-4" />{{ lazyStrings.liveConversation__cancel_generation() }}</button><span v-if="status" role="status" tw-class="flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400" data-testid="live-diagnostics-status"><Loader2Icon v-if="busy" aria-hidden="true" tw-class="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />{{ status }}</span></div>
    <div v-if="busy && run && run.plannedInputSamples > 0" tw-class="space-y-1.5" data-testid="live-diagnostics-input-progress"><div tw-class="flex flex-wrap items-center justify-between gap-2 text-[11px] text-gray-500 dark:text-gray-400"><span>{{ lazyStrings.liveConversation__submitted_input_audio() }}: {{ (run.submittedSamples / speechSampleRate).toFixed(2) }} / {{ (run.plannedInputSamples / speechSampleRate).toFixed(2) }} s</span><span>{{ lazyStrings.liveConversation__pending_input_audio() }}: {{ (queuedSamples / speechSampleRate).toFixed(2) }} s</span></div><progress :value="run.submittedSamples" :max="run.plannedInputSamples" :aria-label="lazyStrings.liveConversation__submitted_input_audio()" tw-class="h-1.5 w-full accent-blue-500" data-testid="live-diagnostics-input-bar" /></div>
    <p tw-class="text-[11px] leading-5 text-gray-500 dark:text-gray-400">{{ lazyStrings.liveConversation__wait_for_response_after_input({ seconds: tailSeconds }) }}</p>
    <details tw-class="rounded-xl border border-gray-200/70 px-4 py-3 text-xs dark:border-gray-800" data-testid="live-diagnostics-settings"><summary tw-class="cursor-pointer font-medium text-gray-600 dark:text-gray-300">{{ lazyStrings.liveConversation__investigation_settings() }}</summary><div tw-class="mt-4 space-y-4"><slot name="settings" /><label tw-class="block text-xs font-medium text-gray-600 dark:text-gray-300">{{ lazyStrings.liveConversation__random_seed() }}<input :value="seed" @change="editSeed({ event: $event })" type="number" min="0" :max="Number.MAX_SAFE_INTEGER" step="1" :disabled="busy || blocked" :aria-invalid="!Number.isSafeInteger(seed) || seed < 0 || undefined" tw-class="mt-2 block w-40 rounded-lg border border-gray-200/80 bg-gray-50/60 px-3 py-2 text-xs focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-40 dark:border-gray-700/60 dark:bg-gray-800/40" data-testid="live-diagnostics-seed" /></label><p tw-class="text-[11px] leading-5 text-gray-500 dark:text-gray-400">{{ lazyStrings.liveConversation__fixed_seed_help() }}</p></div></details>
    <p v-if="unavailable" role="status" tw-class="text-xs leading-6 text-amber-700 dark:text-amber-300" data-testid="live-diagnostics-unavailable">{{ unavailable }} <button type="button" @click="emit('settings')" tw-class="rounded text-blue-600 underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:text-blue-400">{{ lazyStrings.liveConversation__conversation_settings() }}</button></p>
    <p v-if="failure" role="alert" tw-class="break-words text-xs leading-6 text-red-600 dark:text-red-400" data-testid="live-diagnostics-failure">{{ failure }}</p>
    <section v-if="comparison" tw-class="space-y-3 border-t border-gray-200/70 pt-5 dark:border-gray-800" data-testid="live-response-comparison"><h2 tw-class="text-sm font-medium text-gray-800 dark:text-gray-100">{{ lazyStrings.liveConversation__input_volume_comparison() }}</h2><p tw-class="break-words text-xs text-gray-500 dark:text-gray-400" data-testid="live-response-comparison-source">{{ comparison.plan.model.name }}<template v-if="comparison.plan.source.kind !== 'unset'"> · {{ comparison.plan.source.name }}</template></p><p role="status" tw-class="text-xs tabular-nums text-gray-500 dark:text-gray-400" data-testid="live-response-comparison-progress">{{ lazyStrings.liveConversation__response_condition_progress({ completed: comparisonCounts.completed, total: comparison.plan.trials.length }) }}</p><progress :value="comparisonCounts.completed" :max="comparison.plan.trials.length" :aria-label="lazyStrings.liveConversation__input_volume_comparison()" tw-class="h-1.5 w-full accent-blue-500" data-testid="live-response-comparison-bar" /><p v-if="comparison.capture.limitReason" role="status" tw-class="text-xs leading-6 text-amber-700 dark:text-amber-300" data-testid="live-response-comparison-limit">{{ lazyStrings.liveConversation__comparison_retention_limit_reached() }}</p><p v-if="comparison.status !== 'in_progress' && comparisonCounts.notRun > 0" role="status" tw-class="text-xs leading-6 text-amber-700 dark:text-amber-300" data-testid="live-response-comparison-not-run">{{ lazyStrings.liveConversation__remaining_conditions_not_run({ count: comparisonCounts.notRun }) }}</p></section>
    <LiveSpeechResponseResult v-for="result in results" :key="result.trialId" :run="result.run" :model-load-milliseconds="result.modelLoadMilliseconds" :data-trial-id="result.trialId" @replay-start="replayStarted({ element: $event })" @replay-end="emit('replayEnd', $event)" />
    <LiveSpeechResponseResult v-if="run && !completedRunIds.has(run.id)" :run="run" :model-load-milliseconds="modelLoadMilliseconds" @replay-start="replayStarted({ element: $event })" @replay-end="emit('replayEnd', $event)" />
  </section>
</template>
