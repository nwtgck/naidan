import { describe, expect, it, vi } from 'vitest';
import { createLiveControllerFixture } from './controller.test-support';

const open = { modelId: 'host/LiquidAI/LFM3-Omni-2B:Q4_K_M', instructions: '', folder: undefined };
const turn = { text: 'Please listen', images: [], settings: { output: 'mixed' as const, transcription: 'on' as const } };
const file = { blob: new Blob(['encoded']), name: 'spoken-question.wav' };

function urlFixture() {
  let id = 0;
  const create = vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:clip-${++id}`);
  const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  return {
    create,
    revoke,
    [Symbol.dispose]() {
      create.mockRestore();
      revoke.mockRestore();
    },
  };
}

describe('live audio file transport and replay lifetimes', () => {
  it('sends every decoded sample in order through the same audio commands as capture', async () => {
    await using f = createLiveControllerFixture();
    await f.controller.open(open);
    const pcm = Float32Array.from({ length: 12001 }, (_, i) => Math.sin(i / 100) * 0.5);
    f.decodeFile.mockResolvedValue(pcm);
    await f.controller.sendAudioFile({ ...turn, file });
    const chunks = f.request.mock.calls.flatMap(([{ command }]) => command.type === 'audio' ? [command] : []);
    expect(chunks.map(value => value.sequence)).toEqual([0, 1, 2]);
    expect(chunks.map(value => value.pcm.length)).toEqual([5120, 5120, 1761]);
    expect(Float32Array.from(chunks.flatMap(value => Array.from(value.pcm)))).toEqual(pcm);
    expect(f.request.mock.calls.map(([args]) => args.command.type)).toEqual(['begin', 'audio', 'audio', 'audio', 'transcribe', 'respond']);
    expect(f.controller.getState().entries[0]).toMatchObject({ modelId: open.modelId, audioSource: { kind: 'file', name: file.name }, transcript: 'Recognized words', inputStatistics: { samples: 12001, sampleRate: 16000 }, inputAudio: undefined, outputAudio: undefined });
    expect(f.capture).not.toHaveBeenCalled();
  });

  it('keeps the preceding turn intact if file decoding fails before native begin', async () => {
    await using f = createLiveControllerFixture();
    await f.controller.open(open);
    await f.controller.send(turn);
    f.decodeFile.mockRejectedValueOnce(new Error('invalid file'));
    await f.controller.sendAudioFile({ ...turn, file });
    expect(f.request.mock.calls.filter(([args]) => args.command.type === 'rollback')).toHaveLength(0);
    expect(f.controller.getState().entries).toHaveLength(1);
    expect(f.controller.getState()).toMatchObject({ phase: 'ready', failure: 'invalid file' });
  });

  it('cancels a pending decode without sending late audio or resetting the previous turn', async () => {
    await using f = createLiveControllerFixture();
    await f.controller.open(open);
    await f.controller.send(turn);
    const gate = Promise.withResolvers<Float32Array>();
    f.decodeFile.mockReturnValue(gate.promise);
    const sending = f.controller.sendAudioFile({ ...turn, file });
    await vi.waitFor(() => expect(f.decodeFile).toHaveBeenCalled());
    const stopping = f.controller.interrupt();
    await vi.waitFor(() => expect(f.decodeFile.mock.calls[0]?.[0].signal.aborted).toBe(true));
    gate.resolve(new Float32Array([0.1]));
    await sending;
    await stopping;
    expect(f.controller.getState().entries).toHaveLength(1);
    expect(f.request.mock.calls.filter(([args]) => ['audio', 'rollback'].includes(args.command.type))).toHaveLength(0);
  });

  it('keeps both directions only after opt-in and releases them when starting a new conversation without reloading', async () => {
    using urls = urlFixture();
    await using f = createLiveControllerFixture();
    const original = f.request.getMockImplementation()!;
    f.request.mockImplementation(async args => {
      if (args.command.type === 'respond') {
        await args.onEvent({ event: { type: 'audio', sampleRate: 24000, pcm: new Float32Array([0.25, 0.5]) } });
      }
      return original(args);
    });
    await f.controller.open(open);
    await f.controller.sendAudioFile({ ...turn, file });
    expect(urls.create).not.toHaveBeenCalled();
    f.controller.retainAudio({ value: 'on' });
    await f.controller.sendAudioFile({ ...turn, file });
    expect(f.controller.getState().entries[1]).toMatchObject({ inputAudio: { sampleRate: 16000, status: 'complete' }, outputAudio: { sampleRate: 24000, status: 'complete' } });
    await f.controller.reset();
    expect(urls.revoke).toHaveBeenCalledTimes(2);
    expect(f.controller.getState().entries).toEqual([]);
    expect(f.controller.getState().phase).toBe('ready');
    expect(f.runLiveSession).toHaveBeenCalledOnce();
    expect(f.player.close).not.toHaveBeenCalled();
  });

  it('never resurrects audio when retention is disabled during a response', async () => {
    using urls = urlFixture();
    await using f = createLiveControllerFixture();
    f.controller.retainAudio({ value: 'on' });
    await f.controller.open(open);
    const original = f.request.getMockImplementation()!;
    f.request.mockImplementation(async args => {
      if (args.command.type === 'respond') {
        await args.onEvent({ event: { type: 'audio', sampleRate: 24000, pcm: new Float32Array([0.2]) } });
        f.controller.retainAudio({ value: 'off' });
        f.controller.retainAudio({ value: 'on' });
        await args.onEvent({ event: { type: 'audio', sampleRate: 24000, pcm: new Float32Array([0.3]) } });
      }
      return original(args);
    });
    await f.controller.sendAudioFile({ ...turn, file });
    expect(f.controller.getState().entries[0]).toMatchObject({ inputAudio: undefined, outputAudio: undefined });
    expect(urls.revoke).toHaveBeenCalledOnce();
  });

  it('shows input metadata for microphone samples and rejects an empty capture', async () => {
    await using f = createLiveControllerFixture();
    await f.controller.open(open);
    await f.controller.record(turn);
    await f.controller.finishRecording();
    expect(f.controller.getState().failure).toContain('No microphone audio');
    expect(f.request.mock.calls.some(([args]) => args.command.type === 'transcribe')).toBe(false);
    await f.controller.record(turn);
    f.capture.mock.calls[1]![0].onPcm({ pcm: new Float32Array([0.5, -0.5]) });
    await f.controller.finishRecording();
    expect(f.controller.getState().entries[1]).toMatchObject({ audioSource: { kind: 'microphone' }, inputStatistics: { samples: 2, peak: 0.5, rms: 0.5 } });
  });

  it('does not invent input audio metadata for text-only turns even on interruption', async () => {
    await using f = createLiveControllerFixture();
    await f.controller.open(open);
    await f.controller.send(turn);
    await f.controller.interrupt();
    expect(f.controller.getState().entries[0]).toMatchObject({ hasAudio: false, inputStatistics: undefined });
  });

  it('continues the response when optional replay storage fails', async () => {
    using urls = urlFixture();
    await using f = createLiveControllerFixture();
    urls.create.mockImplementation(() => {
      throw new Error('blob unavailable');
    });
    f.controller.retainAudio({ value: 'on' });
    await f.controller.open(open);
    await f.controller.sendAudioFile({ ...turn, file });
    expect(f.controller.getState()).toMatchObject({ phase: 'ready', failure: undefined, audioWarning: 'retention-failed' });
    expect(f.controller.getState().entries[0]).toMatchObject({ status: 'complete', answer: 'Answer', inputAudio: undefined, outputAudio: undefined });
  });

  it('rejects a transcript tagged with a different turn before using its text', async () => {
    await using f = createLiveControllerFixture();
    await f.controller.open(open);
    const original = f.request.getMockImplementation()!;
    f.request.mockImplementation(async args => args.command.type === 'transcribe' ? { type: 'transcript', turnId: 'other', text: 'incorrectly routed text' } : original(args));
    await f.controller.sendAudioFile({ ...turn, file });
    expect(f.controller.getState().entries[0]).toMatchObject({ status: 'discarded', transcript: '', answer: '' });
    expect(f.controller.getState().failure).toContain('Invalid live transcript turn');
  });
});
