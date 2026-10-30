import { describe, expect, it, vi } from 'vitest';
import { toVolumeId } from '@/01-models/ids';
import { createLiveControllerFixture, liveAnswer, shellCall } from './controller.test-support';

const open = { modelId: 'model', instructions: '', folder: undefined };
const turn = { text: 'Hello', images: [], settings: { output: 'mixed' as const, transcription: 'off' as const } };

describe('ephemeral live conversation ownership', () => {
  it('loads once, changes output channels per turn, and closes once', async () => {
    await using f = createLiveControllerFixture();
    await f.controller.open(open);
    expect(f.controller.getState().phase).toBe('ready');
    await f.controller.send(turn);
    await f.controller.send({ ...turn, settings: { ...turn.settings, output: 'text' } });
    expect(f.runLiveSession).toHaveBeenCalledOnce();
    expect(f.request.mock.calls.filter(([value]) => value.command.type === 'respond').map(([value]) => value.command)).toEqual([
      expect.objectContaining({ output: 'mixed' }), expect.objectContaining({ output: 'text' }),
    ]);
    expect(f.controller.getState().entries).toHaveLength(2);
    await f.controller.close();
    await f.controller.close();
    expect(f.player.close).toHaveBeenCalledOnce();
    expect(f.controller.getState().phase).toBe('idle');
  });

  it('does not acquire microphone permission when opening a session', async () => {
    await using f = createLiveControllerFixture();
    await f.controller.open(open);
    expect(f.capture).not.toHaveBeenCalled();
    expect(f.wesh).not.toHaveBeenCalled();
  });

  it('handles model failure without retaining the playback device', async () => {
    await using f = createLiveControllerFixture();
    f.runLiveSession.mockRejectedValue(new Error('model failed'));
    await f.controller.open(open);
    expect(f.controller.getState()).toMatchObject({ phase: 'idle', failure: 'model failed' });
    expect(f.player.close).toHaveBeenCalledOnce();
  });

  it('closes safely while model preparation is unresolved', async () => {
    await using f = createLiveControllerFixture();
    f.runLiveSession.mockImplementation(async ({ signal }) => {
      await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
    });
    const opening = f.controller.open(open);
    await vi.waitFor(() => expect(f.runLiveSession).toHaveBeenCalledOnce());
    await f.controller.close();
    await opening;
    expect(f.controller.getState().phase).toBe('idle');
    expect(f.player.close).toHaveBeenCalledOnce();
  });

  it('accepts a completed transcript only when requested for that recording', async () => {
    await using f = createLiveControllerFixture();
    await f.controller.open(open);
    await f.controller.record({ ...turn, settings: { output: 'mixed', transcription: 'on' } });
    f.capture.mock.calls[0]![0].onPcm({ pcm: new Float32Array([0.1, 0.2]) });
    await f.controller.finishRecording();
    expect(f.controller.getState().entries[0]).toMatchObject({ transcript: 'Recognized words', answer: 'Answer' });
    expect(f.request.mock.calls.map(([value]) => value.command.type)).toEqual(['begin', 'audio', 'transcribe', 'respond']);
    expect(f.finish).toHaveBeenCalledWith({ action: 'send' });
    await f.controller.record(turn);
    f.capture.mock.calls[1]![0].onPcm({ pcm: new Float32Array([0.1]) });
    await f.controller.finishRecording();
    expect(f.request.mock.calls.filter(([value]) => value.command.type === 'transcribe')).toHaveLength(1);
  });

  it('stops playback before the delayed native response finishes and ignores late chunks', async () => {
    await using f = createLiveControllerFixture();
    await f.controller.open(open);
    const gate = Promise.withResolvers<void>();
    const original = f.request.getMockImplementation()!;
    f.request.mockImplementation(async args => {
      if (args.command.type !== 'respond') {
        return original(args);
      }
      await gate.promise;
      await args.onEvent({ event: { type: 'text', text: 'Too late' } });
      await args.onEvent({ event: { type: 'audio', sampleRate: 24000, pcm: new Float32Array([0.1]) } });
      return { type: 'answer', turnId: args.command.turnId, text: '', toolCalls: [], finishReason: 'interrupted' };
    });
    const sending = f.controller.send(turn);
    await vi.waitFor(() => expect(f.request.mock.calls.some(([args]) => args.command.type === 'respond')).toBe(true));
    f.player.stop.mockClear();
    const stopping = f.controller.interrupt();
    await vi.waitFor(() => expect(f.interrupt).toHaveBeenCalledOnce());
    expect(f.player.stop).toHaveBeenCalled();
    gate.resolve();
    await sending;
    await stopping;
    expect(f.player.append).not.toHaveBeenCalled();
    expect(f.controller.getState().entries[0]).toMatchObject({ status: 'discarded' });
    expect(f.controller.getState().phase).toBe('ready');
    expect(f.runLiveSession).toHaveBeenCalledOnce();
  });

  it('cancels a pending microphone and discards the native turn before starting another', async () => {
    await using f = createLiveControllerFixture();
    await f.controller.open(open);
    f.capture.mockImplementation(async ({ signal }) => {
      await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('microphone aborted')), { once: true }));
      return { finish: f.finish };
    });
    const recording = f.controller.record(turn);
    await vi.waitFor(() => expect(f.capture).toHaveBeenCalledOnce());
    await f.controller.interrupt();
    await recording;
    expect(f.controller.getState().phase).toBe('ready');
    expect(f.request.mock.calls.filter(([value]) => value.command.type === 'rollback')).toHaveLength(1);
    await f.controller.send(turn);
    expect(f.controller.getState().entries.at(-1)?.status).toBe('complete');
  });

  it('remembers an interrupt while the input header is still being encoded', async () => {
    await using f = createLiveControllerFixture();
    await f.controller.open(open);
    const gate = Promise.withResolvers<void>();
    const original = f.request.getMockImplementation()!;
    f.request.mockImplementation(async args => {
      if (args.command.type === 'begin') {
        await gate.promise;
      }
      return original(args);
    });
    const sending = f.controller.send(turn);
    await vi.waitFor(() => expect(f.request).toHaveBeenCalledOnce());
    const stopping = f.controller.interrupt();
    await vi.waitFor(() => expect(f.interrupt).toHaveBeenCalledOnce());
    gate.resolve();
    await sending;
    await stopping;
    expect(f.request.mock.calls.some(([value]) => value.command.type === 'respond')).toBe(false);
    expect(f.controller.getState().entries[0]?.status).toBe('discarded');
  });

  it('does not run Wesh before explicit approval and retains its volume on close', async () => {
    await using f = createLiveControllerFixture();
    await f.controller.open({ ...open, folder: { volumeId: toVolumeId({ raw: 'volume' }), access: 'read-write' } });
    const original = f.request.getMockImplementation()!;
    f.request.mockImplementation(async args => args.command.type === 'respond' ? liveAnswer({ turnId: args.command.turnId, calls: [shellCall] }) : original(args));
    await f.controller.send(turn);
    expect(f.controller.getState().phase).toBe('approval');
    expect(f.tools.execute).not.toHaveBeenCalled();
    await f.controller.approve({ decision: 'run' });
    expect(f.tools.execute).toHaveBeenCalledOnce();
    expect(f.request.mock.calls.find(([value]) => value.command.type === 'tool-results')?.[0].command).toMatchObject({ results: [{ id: 'call-1', content: 'result' }] });
    await f.controller.close();
    expect(f.tools.close).toHaveBeenCalledOnce();
    expect(f.controller.getState().entries[0]?.toolResults).toHaveLength(1);
  });

  it('declines tool calls without executing them', async () => {
    await using f = createLiveControllerFixture();
    await f.controller.open({ ...open, folder: { volumeId: toVolumeId({ raw: 'volume' }), access: 'read-only' } });
    const original = f.request.getMockImplementation()!;
    f.request.mockImplementation(async args => args.command.type === 'respond' ? liveAnswer({ turnId: args.command.turnId, calls: [shellCall] }) : original(args));
    await f.controller.send(turn);
    await f.controller.approve({ decision: 'deny' });
    expect(f.tools.execute).not.toHaveBeenCalled();
    expect(f.controller.getState().entries[0]?.toolResults[0]?.result).toContain('declined');
  });

  it('does not roll back the previous completed turn when the next activation fails', async () => {
    await using f = createLiveControllerFixture();
    await f.controller.open(open);
    await f.controller.send(turn);
    f.player.activate.mockRejectedValueOnce(new Error('device unavailable'));
    await f.controller.send(turn);
    expect(f.controller.getState().entries).toHaveLength(1);
    expect(f.controller.getState().entries[0]?.status).toBe('complete');
    expect(f.request.mock.calls.filter(([value]) => value.command.type === 'rollback')).toHaveLength(0);
    expect(f.controller.getState().phase).toBe('ready');
  });

  it('opens microphone capture before a slow native input header has completed', async () => {
    await using f = createLiveControllerFixture();
    await f.controller.open(open);
    const gate = Promise.withResolvers<void>();
    const original = f.request.getMockImplementation()!;
    f.request.mockImplementation(async args => {
      if (args.command.type === 'begin') {
        await gate.promise;
      }
      return original(args);
    });
    const recording = f.controller.record(turn);
    await vi.waitFor(() => expect(f.capture).toHaveBeenCalledOnce());
    f.capture.mock.calls[0]![0].onPcm({ pcm: new Float32Array([0.5]) });
    expect(f.request.mock.calls.filter(([value]) => value.command.type === 'audio')).toHaveLength(0);
    gate.resolve();
    await recording;
    await f.controller.finishRecording();
    expect(f.request.mock.calls.map(([value]) => value.command.type)).toEqual(['begin', 'audio', 'respond']);
  });

  it('keeps completed history when the bounded turn history rejects another turn', async () => {
    await using f = createLiveControllerFixture();
    await f.controller.open(open);
    for (let i = 0; i < 64; i++) {
      await f.controller.send(turn);
    }
    await f.controller.record(turn);
    expect(f.capture).not.toHaveBeenCalled();
    expect(f.controller.getState().entries).toHaveLength(64);
    expect(f.controller.getState().entries.every(entry => entry.status === 'complete')).toBe(true);
    expect(f.request.mock.calls.filter(([value]) => value.command.type === 'rollback')).toHaveLength(0);
    await f.controller.reset();
    await f.controller.send(turn);
    expect(f.controller.getState().entries).toHaveLength(1);
  });

  it('does not publish state after the page is disposed', async () => {
    await using f = createLiveControllerFixture();
    await f.controller.open(open);
    await f.controller.dispose();
    const count = f.onChange.mock.calls.length;
    await f.controller.open(open);
    await f.controller.close();
    expect(f.onChange).toHaveBeenCalledTimes(count);
    expect(f.runLiveSession).toHaveBeenCalledOnce();
  });
});

describe('live playback tail admission', () => {
  it('requires explicit interruption before accepting a new turn over queued speech', async () => {
    await using f = createLiveControllerFixture();
    await f.controller.open({ modelId: 'model', instructions: '', folder: undefined });
    await f.controller.send({ text: 'First', images: [], settings: { output: 'mixed', transcription: 'off' } });
    const before = f.request.mock.calls.length;
    f.playback.mock.calls[0]![0].onPlaying({ playing: true });
    await f.controller.send({ text: 'Second', images: [], settings: { output: 'mixed', transcription: 'off' } });
    await f.controller.record({ text: '', images: [], settings: { output: 'mixed', transcription: 'off' } });
    expect(f.request.mock.calls).toHaveLength(before);
    expect(f.capture).not.toHaveBeenCalled();
    expect(f.controller.getState().entries).toHaveLength(1);
    await f.controller.interrupt();
    expect(f.controller.getState().entries[0]?.status).toBe('discarded');
    expect(f.request.mock.calls.some(([args]) => args.command.type === 'rollback')).toBe(true);
  });
});
