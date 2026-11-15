import { describe, expect, it, vi } from 'vitest';
import { createLiveSpeechFixture } from './speech-controller.test-support';
import { createSpeechResponseResultViews } from './response-result-views';
import { speechInvestigationLimits } from '@/features/speech-cpp-browser/investigation/types';

async function fixture() {
  const speech = createLiveSpeechFixture();
  let sequence = 0;
  const createUrl = vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:comparison-${++sequence}`);
  const revokeUrl = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  const views = createSpeechResponseResultViews();
  await speech.controller.load({ file: new File(['model'], 'model.gguf') });
  vi.mocked(speech.client.start).mockImplementation(async () => {
    speech.change({ state: { phase: 'running' } });
    speech.frame({ samples: new Float32Array(3200).fill(0.25), text: 'Response' });
  });
  const source = new File(['source'], 'source.wav', { type: 'audio/wav' });
  async function run() {
    await speech.controller.runFile({ file: source, maxSeconds: 120, language: 'en', persona: undefined, name: undefined, tailSeconds: 0, seed: 0, inputPacing: 'fast', inputLevel: { kind: 'gain', gain: 1 }, maximumRetainedAudioBytes: speechInvestigationLimits.audioBytes });
    const result = speech.controller.getState().fileRun;
    if (!result) {
      throw new Error('Expected a file run');
    }
    return result;
  }
  return {
    speech,
    source,
    views,
    createUrl,
    revokeUrl,
    run,
    async [Symbol.asyncDispose]() {
      views.clear();
      await speech.controller.dispose();
      createUrl.mockRestore();
      revokeUrl.mockRestore();
    },
  };
}

describe('comparison audio presentation ownership', () => {
  it('retains accepted Blob references with URLs independent of the next runtime run', async () => {
    await using f = await fixture();
    const run = await f.run();
    const input = f.speech.controller.getFileRunAudio({ id: run.id, role: 'input' });
    const output = f.speech.controller.getFileRunAudio({ id: run.id, role: 'output' });
    if (!input || !output) {
      throw new Error('Expected retained file audio');
    }
    const result = f.views.retain({ trialId: 'trial-1', run, modelLoadMilliseconds: 12, audio: { source: { status: 'retained', blob: f.source, format: 'wav', description: 'Source' }, input: { status: 'retained', blob: input, format: 'wav', description: 'Accepted input' }, output: { status: 'retained', blob: output, format: 'wav', description: 'Native output' } } });
    expect(result.run.input?.url).not.toBe(run.input?.url);
    expect(result.run.output?.url).not.toBe(run.output?.url);
    expect(f.createUrl).toHaveBeenLastCalledWith(output);
    expect(f.createUrl).not.toHaveBeenCalledWith(f.source);
    await f.run();
    expect(f.revokeUrl).toHaveBeenCalledWith(run.input?.url);
    expect(f.revokeUrl).not.toHaveBeenCalledWith(result.run.input?.url);
    expect(f.revokeUrl).not.toHaveBeenCalledWith(result.run.output?.url);
    expect(result.run.text).toBe('Response');
    f.views.clear();
    expect(f.revokeUrl).toHaveBeenCalledWith(result.run.input?.url);
    expect(f.revokeUrl).toHaveBeenCalledWith(result.run.output?.url);
  });

  it('does not retain URLs for audio rejected by the collection budget', async () => {
    await using f = await fixture();
    const run = await f.run();
    const before = f.createUrl.mock.calls.length;
    const result = f.views.retain({ trialId: 'trial-1', run, modelLoadMilliseconds: undefined, audio: { source: { status: 'retained', blob: f.source, format: 'wav', description: 'Source' }, input: { status: 'unavailable', reason: 'Collection limit' }, output: { status: 'unavailable', reason: 'Collection limit' } } });
    expect(result.run.input).toBeUndefined();
    expect(result.run.output).toBeUndefined();
    expect(f.createUrl).toHaveBeenCalledTimes(before);
  });
});
