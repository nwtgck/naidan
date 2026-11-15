<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue';
import { AudioLinesIcon, DownloadIcon } from 'lucide-vue-next';
import { currentLocale, lazyStrings } from '@/strings';
import type { SpeechFileRunState } from '@/features/live-conversation/logic/speech-file-run';
import { speechSampleRate } from '@/features/speech-cpp-browser/types';

const props = defineProps<{ run: SpeechFileRunState, modelLoadMilliseconds: number | undefined }>();
const emit = defineEmits<{ replayStart: [element: HTMLAudioElement], replayEnd: [element: HTMLAudioElement] }>();
const root = ref<HTMLElement>();
const resultInputLevel = computed(() => {
  const requested = props.run?.inputLevel.requested;
  switch (requested?.kind) {
  case 'gain': {
    const label = lazyStrings.liveConversation__set_volume_multiplier();
    return label === undefined ? undefined : `${label} · ${formatInputLevelNumber({ value: requested.gain })}×`;
  }
  case 'peak': return lazyStrings.liveConversation__match_peak_to_percent({ percent: formatInputLevelNumber({ value: requested.targetPeak * 100 }) });
  case undefined: return undefined;
  default: {
    const exhaustive: never = requested;
    throw new Error(String(exhaustive));
  }
  }
});
const resultPacing = computed(() => {
  const pacing = props.run?.inputPacing;
  switch (pacing) {
  case 'fast': return lazyStrings.liveConversation__as_fast_as_possible();
  case 'real_time': return lazyStrings.liveConversation__real_time_pace();
  case undefined: return undefined;
  default: {
    const exhaustive: never = pacing;
    throw new Error(String(exhaustive));
  }
  }
});
const interruption = computed(() => {
  const reason = props.run?.replayTiming?.interruption;
  switch (reason) {
  case 'user_cancel': return lazyStrings.liveConversation__generation_cancelled();
  case 'user_finish': return lazyStrings.liveConversation__input_finished_early();
  case 'page_hidden': return lazyStrings.liveConversation__interrupted_when_page_hidden();
  case 'backpressure': return lazyStrings.liveConversation__input_queue_limit_reached();
  case 'native_completed': return lazyStrings.liveConversation__model_finished_before_all_input();
  case undefined: return undefined;
  default: {
    const exhaustive: never = reason;
    throw new Error(String(exhaustive));
  }
  }
});

function formatInputLevelNumber({ value }: { value: number }): string {
  return new Intl.NumberFormat(currentLocale.value, { maximumSignificantDigits: 4 }).format(value);
}

function replay({ event, action }: { event: Event, action: 'start' | 'end' }): void {
  if (!(event.target instanceof HTMLAudioElement)) {
    return;
  }
  switch (action) {
  case 'start':
    for (const audio of root.value?.querySelectorAll('audio') ?? []) {
      if (audio !== event.target) {
        audio.pause();
      }
    }
    emit('replayStart', event.target);
    break;
  case 'end': emit('replayEnd', event.target);
    break;
  default: {
    const exhaustive: never = action;
    throw new Error(String(exhaustive));
  }
  }
}

function pauseAudio(): void {
  for (const audio of root.value?.querySelectorAll('audio') ?? []) {
    audio.pause();
  }
}

function downloadName({ run, side }: { run: SpeechFileRunState, side: 'input' | 'output' }): string {
  const name = run.inputName.replace(/\.[^.]+$/, '');
  switch (side) {
  case 'input': return `naidan-${name}-${run.id}-input.wav`;
  case 'output': return `naidan-${name}-${run.id}-response.wav`;
  default: {
    const exhaustive: never = side;
    throw new Error(String(exhaustive));
  }
  }
}

onBeforeUnmount(pauseAudio);
defineExpose({ pauseAudio, ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>

<template>
  <article ref="root" tw-class="space-y-4 border-t border-gray-200/70 pt-5 dark:border-gray-800" :data-run-id="run.id" data-testid="live-response-result">
    <p v-if="run.status === 'partial' && !run.failure && interruption" role="status" tw-class="text-xs leading-6 text-amber-700 dark:text-amber-300" data-testid="live-diagnostics-interruption">{{ interruption }}</p>
    <p v-if="run.failure" role="alert" tw-class="break-words text-xs leading-6 text-red-600 dark:text-red-400" data-testid="live-diagnostics-failure">{{ run.failure.message }}</p>
    <p v-if="run.audioRetention.status === 'limit'" role="status" tw-class="text-xs leading-6 text-amber-700 dark:text-amber-300" data-testid="live-diagnostics-audio-retention-limit">{{ lazyStrings.liveConversation__comparison_audio_retention_limit() }}</p>
    <div v-if="run?.inputLevel" tw-class="space-y-2"><p tw-class="text-xs text-gray-500 dark:text-gray-400" data-testid="live-diagnostics-result-input-level">{{ lazyStrings.liveConversation__input_volume() }}: {{ resultInputLevel }}</p><p tw-class="text-xs text-gray-500 dark:text-gray-400" data-testid="live-diagnostics-result-gain">{{ lazyStrings.liveConversation__applied_volume_multiplier() }}: {{ run.inputLevel.appliedGain === undefined ? '—' : `${formatInputLevelNumber({ value: run.inputLevel.appliedGain })}×` }}</p><p v-if="run.inputLevel.clippedSamples !== undefined && run.inputLevel.clippedSamples > 0" role="status" tw-class="text-xs leading-6 text-amber-700 dark:text-amber-300" data-testid="live-diagnostics-input-clipped">{{ lazyStrings.liveConversation__input_volume_clipped({ count: run.inputLevel.clippedSamples }) }}</p></div>
    <section v-if="(run.output || run.text)" tw-class="space-y-4 rounded-2xl border border-gray-200/70 bg-white p-4 dark:border-gray-700/60 dark:bg-gray-800/40 sm:p-5" data-testid="live-diagnostics-result">
      <div tw-class="flex flex-wrap items-center justify-between gap-3"><h3 tw-class="flex items-center gap-2 text-sm font-medium text-gray-800 dark:text-gray-100"><AudioLinesIcon aria-hidden="true" tw-class="h-4 w-4 text-blue-500" />{{ lazyStrings.liveConversation__generated_response() }}</h3><a v-if="run?.output" :href="run.output.url" :download="downloadName({ run, side: 'output' })" tw-class="inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-gray-200 px-3 py-2 text-xs font-medium text-gray-600 hover:bg-gray-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800" data-testid="live-diagnostics-download-output"><DownloadIcon aria-hidden="true" tw-class="h-3.5 w-3.5" />{{ lazyStrings.liveConversation__save_response_wav() }}</a></div>
      <p v-if="run" tw-class="text-[11px] font-medium text-gray-500 dark:text-gray-400" data-testid="live-diagnostics-result-pacing">{{ lazyStrings.liveConversation__input_pacing() }}: {{ resultPacing }}</p>
      <audio v-if="run?.output" :src="run.output.url" controls preload="none" @play="replay({ event: $event, action: 'start' })" @pause="replay({ event: $event, action: 'end' })" @ended="replay({ event: $event, action: 'end' })" :aria-label="lazyStrings.liveConversation__generated_response()" tw-class="h-10 w-full" data-testid="live-diagnostics-output-replay" />
      <p v-if="run.text" tw-class="whitespace-pre-wrap break-words text-sm leading-7" data-testid="live-diagnostics-text">{{ run.text }}</p>
      <p v-if="run?.output?.status === 'partial'" tw-class="text-xs leading-5 text-amber-700 dark:text-amber-300">{{ lazyStrings.liveConversation__partial_generation_saved() }}</p>
      <p v-if="run?.output" tw-class="text-[11px] leading-5 text-gray-500 dark:text-gray-400">{{ lazyStrings.liveConversation__wav_contains_generated_audio() }}</p>
    </section>
    <section v-if="run" tw-class="space-y-3 rounded-xl border border-gray-200/70 bg-white/70 p-4 dark:border-gray-800 dark:bg-gray-900/40" data-testid="live-diagnostics-timings">
      <div tw-class="flex flex-wrap items-center justify-between gap-2"><h3 tw-class="text-xs font-medium text-gray-700 dark:text-gray-200">{{ lazyStrings.liveConversation__timings() }}</h3><p tw-class="text-[11px] text-gray-500 dark:text-gray-400" data-testid="live-diagnostics-timing-pacing">{{ resultPacing }}</p></div>
      <dl tw-class="grid grid-cols-2 gap-4 sm:grid-cols-3"><div><dt tw-class="text-[11px] text-gray-500 dark:text-gray-400">{{ lazyStrings.liveConversation__model_loading_time() }}</dt><dd tw-class="mt-1 text-sm font-medium tabular-nums text-gray-800 dark:text-gray-100">{{ modelLoadMilliseconds === undefined ? '—' : `${(modelLoadMilliseconds / 1000).toFixed(2)} s` }}</dd></div><div><dt tw-class="text-[11px] text-gray-500 dark:text-gray-400">{{ lazyStrings.liveConversation__input_preparation_time() }}</dt><dd tw-class="mt-1 text-sm font-medium tabular-nums text-gray-800 dark:text-gray-100" data-testid="live-diagnostics-prepare-time">{{ run.inputPreparationMilliseconds === undefined ? '—' : `${(run.inputPreparationMilliseconds / 1000).toFixed(2)} s` }}</dd></div><div><dt tw-class="text-[11px] text-gray-500 dark:text-gray-400">{{ lazyStrings.liveConversation__time_to_first_output() }}</dt><dd tw-class="mt-1 text-sm font-medium tabular-nums text-gray-800 dark:text-gray-100" data-testid="live-diagnostics-first-output">{{ run.firstOutputMilliseconds === undefined ? '—' : `${(run.firstOutputMilliseconds / 1000).toFixed(2)} s` }}</dd></div><div><dt tw-class="text-[11px] text-gray-500 dark:text-gray-400">{{ lazyStrings.liveConversation__execution_time() }}</dt><dd tw-class="mt-1 text-sm font-medium tabular-nums text-gray-800 dark:text-gray-100" data-testid="live-diagnostics-generation-time">{{ run.generationMilliseconds === undefined ? '—' : `${(run.generationMilliseconds / 1000).toFixed(2)} s` }}</dd></div><div><dt tw-class="text-[11px] text-gray-500 dark:text-gray-400">{{ lazyStrings.liveConversation__output_audio_length() }}</dt><dd tw-class="mt-1 text-sm font-medium tabular-nums text-gray-800 dark:text-gray-100">{{ run.outputStatistics.seconds.toFixed(2) }} s</dd></div><div><dt tw-class="text-[11px] text-gray-500 dark:text-gray-400">{{ lazyStrings.liveConversation__execution_rtf() }}</dt><dd tw-class="mt-1 text-sm font-medium tabular-nums text-gray-800 dark:text-gray-100" data-testid="live-diagnostics-rtf">{{ run.generationMilliseconds === undefined || run.outputStatistics.seconds <= 0 ? '—' : `${(run.generationMilliseconds / 1000 / run.outputStatistics.seconds).toFixed(3)} s/s` }}</dd></div></dl>
      <p tw-class="text-[11px] leading-5 text-gray-500 dark:text-gray-400" data-testid="live-diagnostics-first-output-help">{{ lazyStrings.liveConversation__first_output_may_precede_input() }}</p>
      <p data-testid="live-diagnostics-rtf-help" tw-class="text-[11px] leading-5 text-gray-400 dark:text-gray-500">{{ lazyStrings.liveConversation__execution_rtf_includes_waits() }}</p><p tw-class="text-[11px] text-gray-400 dark:text-gray-500">{{ lazyStrings.liveConversation__run_total() }}: {{ (run.elapsedMilliseconds / 1000).toFixed(2) }} s</p>
    </section>
    <details v-if="run" tw-class="rounded-xl border border-gray-200/70 px-4 py-3 text-xs text-gray-500 dark:border-gray-800 dark:text-gray-400" data-testid="live-diagnostics-details"><summary tw-class="cursor-pointer font-medium">{{ lazyStrings.liveConversation__audio_details() }}</summary><div tw-class="mt-4 space-y-4">
      <section v-if="run.replayTiming" tw-class="space-y-3" data-testid="live-diagnostics-replay-timing">
        <h3 tw-class="font-medium text-gray-700 dark:text-gray-200">{{ lazyStrings.liveConversation__input_pacing_measurements() }}</h3>
        <dl tw-class="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <div><dt>{{ lazyStrings.liveConversation__dialogue_start_ready_time() }}</dt><dd tw-class="mt-1 tabular-nums" data-testid="live-diagnostics-dialogue-ready">{{ run.replayTiming.dialogueReadyMilliseconds === undefined ? '—' : `${(run.replayTiming.dialogueReadyMilliseconds / 1000).toFixed(2)} s` }}</dd></div>
          <div><dt>{{ lazyStrings.liveConversation__input_submission_time() }}</dt><dd tw-class="mt-1 tabular-nums" data-testid="live-diagnostics-producer-time">{{ run.replayTiming.producerDurationMilliseconds === undefined ? '—' : `${(run.replayTiming.producerDurationMilliseconds / 1000).toFixed(2)} s` }}</dd></div>
          <div><dt>{{ lazyStrings.liveConversation__processing_after_input() }}</dt><dd tw-class="mt-1 tabular-nums" data-testid="live-diagnostics-drain-time">{{ run.replayTiming.drainDurationMilliseconds === undefined ? '—' : `${(run.replayTiming.drainDurationMilliseconds / 1000).toFixed(2)} s` }}</dd></div>
          <div><dt>{{ lazyStrings.liveConversation__maximum_input_schedule_delay() }}</dt><dd tw-class="mt-1 tabular-nums" data-testid="live-diagnostics-input-lateness">{{ run.submittedSamples === 0 ? '—' : `${(run.replayTiming.maxScheduleLatenessMilliseconds / 1000).toFixed(3)} s` }}</dd></div>
          <div><dt>{{ lazyStrings.liveConversation__maximum_output_lateness() }}</dt><dd tw-class="mt-1 tabular-nums" data-testid="live-diagnostics-output-lateness">{{ run.replayTiming.maxOutputLatenessMilliseconds === undefined ? '—' : `${(run.replayTiming.maxOutputLatenessMilliseconds / 1000).toFixed(3)} s` }}</dd></div>
          <div><dt>{{ lazyStrings.liveConversation__maximum_pending_input() }}</dt><dd tw-class="mt-1 tabular-nums" data-testid="live-diagnostics-max-queue">{{ (run.replayTiming.maxQueuedSamples / speechSampleRate).toFixed(2) }} s</dd></div>
        </dl>
        <p tw-class="text-[11px] leading-5" data-testid="live-diagnostics-output-lateness-help">{{ lazyStrings.liveConversation__output_lateness_includes_input_and_queue() }}</p>
        <p>{{ lazyStrings.liveConversation__catch_up_input_frames() }}: <span tw-class="tabular-nums" data-testid="live-diagnostics-catch-up">{{ run.replayTiming.catchUpFrames }}</span></p>
        <p v-if="interruption">{{ lazyStrings.liveConversation__execution_interruption() }}: {{ interruption }}</p>
      </section>
      <div v-if="run.inputLevel?.before && run.inputLevel.after" tw-class="space-y-3" data-testid="live-diagnostics-input-level-details"><div><h3 tw-class="mb-1 font-medium">{{ lazyStrings.liveConversation__input_before_volume_adjustment() }}</h3><p tw-class="break-words font-mono" data-testid="live-diagnostics-input-before-level">{{ lazyStrings.liveConversation__audio_statistics({ seconds: run.inputLevel.before.seconds.toFixed(2), sampleRate: run.inputLevel.before.sampleRate, peak: run.inputLevel.before.peak.toFixed(4), rms: run.inputLevel.before.rms.toFixed(4), clipped: run.inputLevel.before.clippedSamples }) }}</p></div><div><h3 tw-class="mb-1 font-medium">{{ lazyStrings.liveConversation__input_after_volume_adjustment() }}</h3><p tw-class="break-words font-mono" data-testid="live-diagnostics-input-after-level">{{ lazyStrings.liveConversation__audio_statistics({ seconds: run.inputLevel.after.seconds.toFixed(2), sampleRate: run.inputLevel.after.sampleRate, peak: run.inputLevel.after.peak.toFixed(4), rms: run.inputLevel.after.rms.toFixed(4), clipped: run.inputLevel.after.clippedSamples }) }}</p></div></div>
      <div><h3 tw-class="mb-1 font-medium">{{ lazyStrings.liveConversation__submitted_input_audio() }}</h3><p v-if="run.input" tw-class="mb-2 text-[11px] leading-5" data-testid="live-diagnostics-adjusted-input-help">{{ lazyStrings.liveConversation__input_after_volume_adjustment_help() }}</p><audio v-if="run.input" :src="run.input.url" controls preload="none" @play="replay({ event: $event, action: 'start' })" @pause="replay({ event: $event, action: 'end' })" @ended="replay({ event: $event, action: 'end' })" :aria-label="lazyStrings.liveConversation__submitted_input_audio()" tw-class="mb-2 h-10 w-full" data-testid="live-diagnostics-adjusted-input-replay" /><p tw-class="break-words font-mono">{{ lazyStrings.liveConversation__audio_statistics({ seconds: run.inputStatistics.seconds.toFixed(2), sampleRate: run.inputStatistics.sampleRate, peak: run.inputStatistics.peak.toFixed(4), rms: run.inputStatistics.rms.toFixed(4), clipped: run.inputStatistics.clippedSamples }) }}</p><a v-if="run.input" :href="run.input.url" :download="downloadName({ run, side: 'input' })" tw-class="mt-2 inline-flex items-center gap-1.5 rounded text-blue-600 underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:text-blue-400" data-testid="live-diagnostics-download-input"><DownloadIcon aria-hidden="true" tw-class="h-3.5 w-3.5" />{{ lazyStrings.liveConversation__save_submitted_input_wav() }}</a></div><div><h3 tw-class="mb-1 font-medium">{{ lazyStrings.liveConversation__generated_response() }}</h3><p tw-class="break-words font-mono">{{ lazyStrings.liveConversation__audio_statistics({ seconds: run.outputStatistics.seconds.toFixed(2), sampleRate: run.outputStatistics.sampleRate, peak: run.outputStatistics.peak.toFixed(4), rms: run.outputStatistics.rms.toFixed(4), clipped: run.outputStatistics.clippedSamples }) }}</p></div><p tw-class="break-words font-mono">{{ lazyStrings.liveConversation__file_generation_statistics({ submitted: run.submittedSamples, frames: run.frames, seconds: (run.elapsedMilliseconds / 1000).toFixed(2), tail: run.effectiveTailSeconds.toFixed(2), gaps: run.sequenceDiscontinuities }) }}</p><p>{{ lazyStrings.liveConversation__random_seed() }}: {{ run.seed }} · {{ lazyStrings.liveConversation__conversation_language() }}: {{ run.language }}</p><div v-if="run.firstFrameStatistics"><h3 tw-class="mb-1 font-medium">{{ lazyStrings.liveConversation__first_output_frame() }}</h3><p tw-class="break-words font-mono">{{ lazyStrings.liveConversation__audio_statistics({ seconds: run.firstFrameStatistics.seconds.toFixed(2), sampleRate: run.firstFrameStatistics.sampleRate, peak: run.firstFrameStatistics.peak.toFixed(4), rms: run.firstFrameStatistics.rms.toFixed(4), clipped: run.firstFrameStatistics.clippedSamples }) }}</p></div><code v-if="run.failure" tw-class="block whitespace-pre-wrap break-words">{{ run.failure.message }}<template v-if="run.failure.nativeStatus !== undefined">{{ '\n' }}{{ run.failure.nativeStatus }}</template><template v-if="run.failure.nativeInput !== undefined">{{ '\n' }}{{ run.failure.nativeInput }}</template></code></div></details>
  </article>
</template>
