import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { ensureAllStringsForTest } from '@/strings/utils.test-support';
import { createLiveSpeechFixture } from '@/features/live-conversation/logic/speech-controller.test-support';
import LiveConversationDiagnostics from './LiveConversationDiagnostics.vue';
import type { SpeechReplayTiming } from '@/features/live-conversation/logic/speech-file-run';

beforeEach(async () => {
  await ensureAllStringsForTest({ locale: 'ja' });
});

async function fixture() {
  const speech = createLiveSpeechFixture();
  const createUrl = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:audio');
  const revokeUrl = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  const pause = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  const file = new File(['audio'], 'timing.wav', { type: 'audio/wav' });
  await speech.controller.load({ file: new File(['model'], 'model.gguf') });
  await speech.controller.runFile({ file, maxSeconds: 120, language: 'en', persona: undefined, name: undefined, tailSeconds: 5, seed: 0, inputPacing: 'fast' });
  const run = speech.controller.getState().fileRun;
  if (!run) {
    throw new Error('Expected a completed file run');
  }
  const wrapper = mount(LiveConversationDiagnostics, { props: { file, run, text: '', busy: false, blocked: false, canGenerate: true, unavailable: undefined, selectionFailure: undefined, tailSeconds: 5, seed: 0, inputPacing: 'fast', queuedSamples: 0, modelLoadMilliseconds: undefined } });
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
    expect(f.wrapper.get('[data-testid="live-diagnostics-output-lateness-help"]').text()).toContain('初期フレームを除き');
    expect(f.wrapper.get('[data-testid="live-diagnostics-output-lateness-help"]').text()).toContain('処理待ち・受信');
    expect(f.wrapper.get('[data-testid="live-diagnostics-timing-pacing"]').text()).toBe('実時間ペース');
  });

  it('leaves missing real-time measurements unavailable', async () => {
    await using f = await fixture();
    await f.wrapper.setProps({ run: { ...f.run, inputPacing: 'real_time', submittedSamples: 0, replayTiming: { dialogueReadyMilliseconds: undefined, producerDurationMilliseconds: undefined, drainDurationMilliseconds: undefined, maxScheduleLatenessMilliseconds: 0, maxOutputLatenessMilliseconds: undefined, maxQueuedSamples: 0, catchUpFrames: 0, interruption: undefined } } });
    for (const field of ['dialogue-ready', 'producer-time', 'drain-time', 'input-lateness', 'output-lateness']) {
      expect(f.wrapper.get(`[data-testid="live-diagnostics-${field}"]`).text()).toBe('—');
    }
  });

  it.each([
    ['preparing_input', '音声を準備中'],
    ['starting_dialogue', '対話を開始中'],
    ['feeding_input', '入力音声を送信中'],
    ['draining_input', '残りの入力を処理中'],
    ['saving_output', '出力音声を準備中'],
    ['finished', '生成完了'],
  ] as const)('shows the measured %s stage without inventing a silence or gap phase', async (stage, label) => {
    await using f = await fixture();
    await f.wrapper.setProps({ busy: true, run: { ...f.run, stage, status: 'running', submittedSamples: 3200, plannedInputSamples: 6400 }, queuedSamples: 1600 });
    expect(f.wrapper.get('[data-testid="live-diagnostics-status"]').text()).toContain(label);
    expect(f.wrapper.get('[data-testid="live-diagnostics-input-bar"]').attributes('value')).toBe('3200');
    expect(f.wrapper.get('[data-testid="live-diagnostics-input-bar"]').attributes('max')).toBe('6400');
    expect(f.wrapper.get('[data-testid="live-diagnostics-input-progress"]').text()).toContain('0.13 / 0.27 s');
    expect(f.wrapper.get('[data-testid="live-diagnostics-input-progress"]').text()).toContain('0.07 s');
    expect(f.wrapper.get('[data-testid="live-diagnostics-pacing"]').attributes('disabled')).toBeDefined();
  });

  it.each([
    ['user_cancel', '生成を中止しました'],
    ['user_finish', '入力の送信を終了しました'],
    ['page_hidden', 'ページが非表示になったため中断'],
    ['backpressure', '処理待ちの入力が上限に達したため中断'],
    ['native_completed', 'モデルが対話を終了'],
  ] satisfies [SpeechReplayTiming['interruption'], string][])('explains %s interruptions without replacing native failure details', async (interruption, reason) => {
    await using f = await fixture();
    const run = { ...f.run, replayTiming: { dialogueReadyMilliseconds: 1, producerDurationMilliseconds: 1, drainDurationMilliseconds: 1, maxScheduleLatenessMilliseconds: 1, maxOutputLatenessMilliseconds: undefined, maxQueuedSamples: 1, catchUpFrames: 0, interruption } };
    await f.wrapper.setProps({ run: { ...run, status: 'partial' } });
    expect(f.wrapper.get('[data-testid="live-diagnostics-interruption"]').text()).toContain(reason);
    await f.wrapper.setProps({ run: { ...run, status: 'failed', failure: { code: 'runtime_failed', message: 'Native error', nativeStatus: -9, nativeInput: 'speech_step' } } });
    expect(f.wrapper.find('[data-testid="live-diagnostics-interruption"]').exists()).toBe(false);
    expect(f.wrapper.get('[data-testid="live-diagnostics-failure"]').text()).toContain('Native error');
    expect(f.wrapper.get('[data-testid="live-diagnostics-details"]').text()).toContain('-9');
    expect(f.wrapper.get('[data-testid="live-diagnostics-details"]').text()).toContain('speech_step');
  });

  it('keeps execution RTF unavailable without output audio and explains the initial frame separately', async () => {
    await using f = await fixture();
    expect(f.wrapper.get('[data-testid="live-diagnostics-rtf"]').text()).toBe('—');
    expect(f.wrapper.get('[data-testid="live-diagnostics-rtf-help"]').text()).toContain('入力ペース・処理・通信の待ち時間を含み');
    expect(f.wrapper.get('[data-testid="live-diagnostics-first-output-help"]').text()).toContain('返答までの時間ではありません');
    expect(f.wrapper.text()).not.toContain('GPU 処理時間');
    expect(f.wrapper.text()).not.toContain('出力の到着間隔');
  });
});
