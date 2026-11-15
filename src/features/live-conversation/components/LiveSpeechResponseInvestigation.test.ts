import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { ensureAllStringsForTest } from '@/strings/utils.test-support';
import { createLiveSpeechFixture } from '@/features/live-conversation/logic/speech-controller.test-support';
import LiveSpeechResponseInvestigation from './LiveSpeechResponseInvestigation.vue';
import { ensureStrings } from '@/strings';
import { speechInvestigationLimits } from '@/features/speech-cpp-browser/investigation/types';

beforeEach(async () => {
  await ensureAllStringsForTest({ locale: 'en' });
});

async function fixture() {
  const speech = createLiveSpeechFixture();
  const createUrl = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:audio');
  const revokeUrl = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  const pause = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  const file = new File(['audio'], 'timing.wav', { type: 'audio/wav' });
  await speech.controller.load({ file: new File(['model'], 'model.gguf') });
  await speech.controller.runFile({ file, maxSeconds: 120, language: 'en', persona: undefined, name: undefined, tailSeconds: 5, seed: 0, inputPacing: 'fast', inputLevel: { kind: 'gain', gain: 1 }, maximumRetainedAudioBytes: speechInvestigationLimits.audioBytes });
  const run = speech.controller.getState().fileRun;
  if (!run) {
    throw new Error('Expected a completed file run');
  }
  const wrapper = mount(LiveSpeechResponseInvestigation, { props: { file, run, text: '', busy: false, blocked: false, canGenerate: true, unavailable: undefined, selectionFailure: undefined, tailSeconds: 5, seed: 0, inputPacing: 'fast', inputLevels: [{ kind: 'gain', gain: 1 }], results: [], comparison: undefined, queuedSamples: 0, modelLoadMilliseconds: undefined } });
  return {
    run,
    wrapper,
    async [Symbol.asyncDispose]() {
      wrapper.unmount();
      await speech.controller.dispose();
      createUrl.mockRestore();
      revokeUrl.mockRestore();
      pause.mockRestore();
    },
  };
}

describe('file investigation pacing and timing presentation', () => {
  it('requires at least one volume condition and distinguishes an audio retention limit from user cancellation', async () => {
    await using f = await fixture();
    await f.wrapper.setProps({ inputLevels: [] });
    expect(f.wrapper.get('[data-testid="live-diagnostics-generate"]').attributes('disabled')).toBeDefined();
    await f.wrapper.setProps({ run: { ...f.run, status: 'partial', audioRetention: { maximumBytes: 48, retainedBytes: 48, status: 'limit' } } });
    expect(f.wrapper.get('[data-testid="live-diagnostics-audio-retention-limit"]').text()).toBe(await ensureStrings.liveConversation__comparison_audio_retention_limit());
    expect(f.wrapper.find('[data-testid="live-diagnostics-interruption"]').exists()).toBe(false);
  });

  it('shows peak matching as one constant adjustment and keeps the requested result separate from the selected mode', async () => {
    await using f = await fixture();
    await f.wrapper.setProps({ inputLevels: [{ kind: 'peak', targetPeak: 0.8 }] });
    expect(f.wrapper.get<HTMLInputElement>('[data-testid="live-diagnostics-input-level-peak-0.8"]').element.checked).toBe(true);
    expect(f.wrapper.get<HTMLInputElement>('[data-testid="live-diagnostics-input-level-gain-1"]').element.checked).toBe(false);
    expect(f.wrapper.get('[data-testid="live-diagnostics-peak-help"]').text()).toBe(await ensureStrings.liveConversation__peak_volume_help());
    expect(f.wrapper.get('[data-testid="live-diagnostics-result-input-level"]').text()).toContain(`${await ensureStrings.liveConversation__set_volume_multiplier()} · 1×`);
    expect(f.wrapper.get('[data-testid="live-diagnostics-result-gain"]').text()).toContain('1×');
  });

  it('shows the run volume snapshot and clipping count independently of the next selected multiplier', async () => {
    await using f = await fixture();
    const before = { ...f.run.inputStatistics, seconds: 1, peak: 0.5, rms: 0.25, clippedSamples: 0 };
    const after = { ...before, peak: 1, rms: 0.75, clippedSamples: 3 };
    await f.wrapper.setProps({ inputLevels: [{ kind: 'gain', gain: 2 }], run: { ...f.run, inputLevel: { requested: { kind: 'gain', gain: 4 }, appliedGain: 4, before, after, clippedSamples: 3 } } });
    expect(f.wrapper.get<HTMLInputElement>('[data-testid="live-diagnostics-input-level-gain-2"]').element.checked).toBe(true);
    expect(f.wrapper.get('[data-testid="live-diagnostics-result-gain"]').text()).toBe(`${await ensureStrings.liveConversation__applied_volume_multiplier()}: 4×`);
    expect(f.wrapper.get('[data-testid="live-diagnostics-input-clipped"]').text()).toBe(await ensureStrings.liveConversation__input_volume_clipped({ count: 3 }));
    expect(f.wrapper.get('[data-testid="live-diagnostics-input-before-level"]').text()).toBe(await ensureStrings.liveConversation__audio_statistics({ seconds: '1.00', sampleRate: before.sampleRate, peak: '0.5000', rms: '0.2500', clipped: 0 }));
    expect(f.wrapper.get('[data-testid="live-diagnostics-input-after-level"]').text()).toBe(await ensureStrings.liveConversation__audio_statistics({ seconds: '1.00', sampleRate: after.sampleRate, peak: '1.0000', rms: '0.7500', clipped: 3 }));
    expect(f.wrapper.get('[data-testid="live-diagnostics-adjusted-input-replay"]').attributes('src')).toBe(f.run.input?.url);
    expect(f.wrapper.get('[data-testid="live-diagnostics-adjusted-input-help"]').text()).toBe(await ensureStrings.liveConversation__input_after_volume_adjustment_help());
    expect(f.wrapper.get('[data-testid="live-diagnostics-download-input"]').attributes('href')).toBe(f.run.input?.url);
    await f.wrapper.setProps({ inputLevels: [{ kind: 'gain', gain: 8 }] });
    expect(f.wrapper.get('[data-testid="live-diagnostics-result-gain"]').text()).toContain('4×');
  });

  it('keeps requested volume visible without inventing measurements before input preparation', async () => {
    await using f = await fixture();
    await f.wrapper.setProps({ run: { ...f.run, status: 'failed', input: undefined, inputLevel: { requested: { kind: 'gain', gain: 8 }, appliedGain: undefined, before: undefined, after: undefined, clippedSamples: undefined } } });
    expect(f.wrapper.get('[data-testid="live-diagnostics-result-input-level"]').text()).toContain(`${await ensureStrings.liveConversation__set_volume_multiplier()} · 8×`);
    expect(f.wrapper.get('[data-testid="live-diagnostics-result-gain"]').text()).toBe(`${await ensureStrings.liveConversation__applied_volume_multiplier()}: —`);
    expect(f.wrapper.find('[data-testid="live-diagnostics-input-level-details"]').exists()).toBe(false);
    expect(f.wrapper.find('[data-testid="live-diagnostics-input-clipped"]').exists()).toBe(false);
    expect(f.wrapper.find('[data-testid="live-diagnostics-adjusted-input-replay"]').exists()).toBe(false);
    expect(f.wrapper.find('[data-testid="live-diagnostics-adjusted-input-help"]').exists()).toBe(false);
  });

  it('omits real-time summaries for fast runs rather than reporting zero delays', async () => {
    await using f = await fixture();
    expect(f.wrapper.find('[data-testid="live-diagnostics-replay-timing"]').exists()).toBe(false);
    expect(f.wrapper.find('[data-testid="live-diagnostics-output-lateness"]').exists()).toBe(false);
    expect(f.wrapper.find('[data-testid="live-diagnostics-max-queue"]').exists()).toBe(false);
  });

  it('distinguishes dialogue readiness from the initial frame and renders only measured summaries', async () => {
    await using f = await fixture();
    await f.wrapper.setProps({ run: { ...f.run, inputPacing: 'real_time', firstOutputMilliseconds: 125, generationMilliseconds: 6000, submittedSamples: 3200, outputStatistics: { ...f.run.outputStatistics, seconds: 8 }, replayTiming: { dialogueReadyMilliseconds: 250, producerDurationMilliseconds: 5400, drainDurationMilliseconds: 350, maxScheduleLatenessMilliseconds: 20, maxOutputLatenessMilliseconds: 200, maxQueuedSamples: 9600, catchUpFrames: 2, interruption: undefined } } });
    expect(f.wrapper.get('[data-testid="live-diagnostics-first-output"]').text()).toBe('0.13 s');
    expect(f.wrapper.get('[data-testid="live-diagnostics-dialogue-ready"]').text()).toBe('0.25 s');
    expect(f.wrapper.get('[data-testid="live-diagnostics-producer-time"]').text()).toBe('5.40 s');
    expect(f.wrapper.get('[data-testid="live-diagnostics-drain-time"]').text()).toBe('0.35 s');
    expect(f.wrapper.get('[data-testid="live-diagnostics-input-lateness"]').text()).toBe('0.020 s');
    expect(f.wrapper.get('[data-testid="live-diagnostics-output-lateness"]').text()).toBe('0.200 s');
    expect(f.wrapper.get('[data-testid="live-diagnostics-max-queue"]').text()).toBe('0.40 s');
    expect(f.wrapper.get('[data-testid="live-diagnostics-catch-up"]').text()).toBe('2');
    expect(f.wrapper.get('[data-testid="live-diagnostics-rtf"]').text()).toBe('0.750 s/s');
    expect(f.wrapper.get('[data-testid="live-diagnostics-output-lateness-help"]').text()).toBe(await ensureStrings.liveConversation__output_lateness_includes_input_and_queue());
    expect(f.wrapper.get('[data-testid="live-diagnostics-timing-pacing"]').text()).toBe(await ensureStrings.liveConversation__real_time_pace());
  });

  it('leaves missing real-time measurements unavailable', async () => {
    await using f = await fixture();
    await f.wrapper.setProps({ run: { ...f.run, inputPacing: 'real_time', submittedSamples: 0, replayTiming: { dialogueReadyMilliseconds: undefined, producerDurationMilliseconds: undefined, drainDurationMilliseconds: undefined, maxScheduleLatenessMilliseconds: 0, maxOutputLatenessMilliseconds: undefined, maxQueuedSamples: 0, catchUpFrames: 0, interruption: undefined } } });
    for (const field of ['dialogue-ready', 'producer-time', 'drain-time', 'input-lateness', 'output-lateness']) {
      expect(f.wrapper.get(`[data-testid="live-diagnostics-${field}"]`).text()).toBe('—');
    }
  });

  it('keeps submitted audio progress separate from the remaining processing stage', async () => {
    await using f = await fixture();
    await f.wrapper.setProps({ busy: true, run: { ...f.run, stage: 'feeding_input', status: 'running', submittedSamples: 3200, plannedInputSamples: 6400 }, queuedSamples: 1600 });
    expect(f.wrapper.get('[data-testid="live-diagnostics-status"]').text()).toBe(await ensureStrings.liveConversation__sending_input_audio());
    expect(f.wrapper.get('[data-testid="live-diagnostics-input-bar"]').attributes('value')).toBe('3200');
    expect(f.wrapper.get('[data-testid="live-diagnostics-input-bar"]').attributes('max')).toBe('6400');
    expect(f.wrapper.get('[data-testid="live-diagnostics-input-progress"]').text()).toContain('0.13 / 0.27 s');
    expect(f.wrapper.get('[data-testid="live-diagnostics-input-progress"]').text()).toContain('0.07 s');
    expect(f.wrapper.get('[data-testid="live-diagnostics-pacing"]').attributes('disabled')).toBeDefined();
    expect(f.wrapper.get('[data-testid="live-diagnostics-input-level-gain-1"]').attributes('disabled')).toBeDefined();
    expect(f.wrapper.get('[data-testid="live-diagnostics-input-level-peak-0.8"]').attributes('disabled')).toBeDefined();
    await f.wrapper.setProps({ run: { ...f.run, stage: 'draining_input', status: 'running', submittedSamples: 6400, plannedInputSamples: 6400 } });
    expect(f.wrapper.get('[data-testid="live-diagnostics-status"]').text()).toBe(await ensureStrings.liveConversation__processing_remaining_input());
    expect(f.wrapper.get('[data-testid="live-diagnostics-input-bar"]').attributes('value')).toBe('6400');
  });

  it.each([
    { reason: 'user_cancel', message: () => ensureStrings.liveConversation__generation_cancelled() },
    { reason: 'user_finish', message: () => ensureStrings.liveConversation__input_finished_early() },
    { reason: 'page_hidden', message: () => ensureStrings.liveConversation__interrupted_when_page_hidden() },
    { reason: 'backpressure', message: () => ensureStrings.liveConversation__input_queue_limit_reached() },
    { reason: 'native_completed', message: () => ensureStrings.liveConversation__model_finished_before_all_input() },
  ] as const)('shows the semantic message for $reason', async ({ reason, message }) => {
    await using f = await fixture();
    await f.wrapper.setProps({ run: { ...f.run, inputPacing: 'real_time', status: 'partial', replayTiming: { dialogueReadyMilliseconds: 1, producerDurationMilliseconds: 1, drainDurationMilliseconds: 1, maxScheduleLatenessMilliseconds: 1, maxOutputLatenessMilliseconds: undefined, maxQueuedSamples: 1, catchUpFrames: 0, interruption: reason } } });
    expect(f.wrapper.get('[data-testid="live-diagnostics-interruption"]').text()).toBe(await message());
  });

  it('prioritizes native failure details over an interruption reason', async () => {
    await using f = await fixture();
    const run = { ...f.run, replayTiming: { dialogueReadyMilliseconds: 1, producerDurationMilliseconds: 1, drainDurationMilliseconds: 1, maxScheduleLatenessMilliseconds: 1, maxOutputLatenessMilliseconds: undefined, maxQueuedSamples: 1, catchUpFrames: 0, interruption: 'page_hidden' as const } };
    await f.wrapper.setProps({ run: { ...run, status: 'failed', failure: { code: 'runtime_failed', message: 'Native error', nativeStatus: -9, nativeInput: 'speech_step' } } });
    expect(f.wrapper.find('[data-testid="live-diagnostics-interruption"]').exists()).toBe(false);
    expect(f.wrapper.get('[data-testid="live-diagnostics-failure"]').text()).toBe('Native error');
    expect(f.wrapper.get('[data-testid="live-diagnostics-details"]').text()).toContain('-9');
    expect(f.wrapper.get('[data-testid="live-diagnostics-details"]').text()).toContain('speech_step');
  });

  it('keeps execution RTF unavailable without output audio and explains the initial frame separately', async () => {
    await using f = await fixture();
    expect(f.wrapper.get('[data-testid="live-diagnostics-rtf"]').text()).toBe('—');
    expect(f.wrapper.get('[data-testid="live-diagnostics-rtf-help"]').text()).toBe(await ensureStrings.liveConversation__execution_rtf_includes_waits());
    expect(f.wrapper.get('[data-testid="live-diagnostics-first-output-help"]').text()).toBe(await ensureStrings.liveConversation__first_output_may_precede_input());
  });
});
