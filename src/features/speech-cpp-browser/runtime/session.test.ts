import { describe, expect, it } from 'vitest';
import { createSpeechSession } from './session';
import { speechSessionFixture, startOptions } from './session.test-support';
import { speechFrameSamples, SpeechRuntimeError, type SpeechDialoguePort } from '@/features/speech-cpp-browser/types';

const file = new File(['model fixture'], 'Haru.gguf');

describe('speech session lane and ownership', () => {
  it('copies callback-owned PCM before start returns and tolerates its later reuse', async () => {
    const entered = Promise.withResolvers<void>(), gate = Promise.withResolvers<void>();
    const borrowed = new Float32Array(speechFrameSamples).fill(0.5);
    const dialogue: SpeechDialoguePort = { push: async () => ({ kind: 'continue' }), end: async () => {}, release: async () => {} };
    await using fixture = speechSessionFixture({
      push: undefined,
      start: async ({ onFrame }) => {
        expect(onFrame({ samples: borrowed, text: 'hello' })).toBe('continue');
        borrowed.fill(0);
        entered.resolve();
        await gate.promise;
        return dialogue;
      },
    });
    await fixture.client.loadModel({ file });
    const started = fixture.client.start({ options: startOptions });
    await entered.promise;
    expect(fixture.client.getState().phase).toBe('starting');
    expect(fixture.frames[0]?.samples[0]).toBe(0.5);
    expect(fixture.frames[0]?.text).toBe('hello');
    gate.resolve();
    await started;
    expect(fixture.client.getState().phase).toBe('running');
  });

  it('bounds retained input including the pending native call and copies caller PCM', async () => {
    const gate = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>();
    let received: Float32Array | undefined;
    await using fixture = speechSessionFixture({
      start: undefined,
      push: async ({ samples }) => {
        received = samples;
        entered.resolve();
        await gate.promise;
        return { kind: 'continue' };
      },
    });
    await fixture.client.loadModel({ file });
    await fixture.client.start({ options: startOptions });
    const input = new Float32Array(16).fill(0.25);
    expect(fixture.client.push({ samples: input, sampleRate: 24000 })).toEqual({ kind: 'accepted' });
    input.fill(0);
    await entered.promise;
    expect(received?.[0]).toBe(0.25);
    expect(fixture.client.push({ samples: new Float32Array(16), sampleRate: 24000 })).toEqual({ kind: 'backpressure' });
    expect(fixture.client.getState().queuedSamples).toBe(16);
    gate.resolve();
    await fixture.client.stop({ mode: 'finish' });
    expect(fixture.client.getState().queuedSamples).toBe(0);
  });

  it('cancels immediately but waits for the pending call before end and release', async () => {
    const gate = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>();
    await using fixture = speechSessionFixture({
      start: undefined,
      push: async () => {
        entered.resolve();
        await gate.promise;
        return { kind: 'continue' };
      },
    });
    await fixture.client.loadModel({ file });
    await fixture.client.start({ options: startOptions });
    fixture.client.push({ samples: new Float32Array(8), sampleRate: 24000 });
    await entered.promise;
    fixture.client.push({ samples: new Float32Array(8), sampleRate: 24000 });
    const stopped = fixture.client.stop({ mode: 'cancel' });
    expect(fixture.events).toEqual(['start', 'push', 'cancel']);
    expect(fixture.client.push({ samples: new Float32Array(8), sampleRate: 24000 })).toEqual({ kind: 'not_running' });
    gate.resolve();
    await stopped;
    expect(fixture.events).toEqual(['start', 'push', 'cancel', 'end', 'dialogue_release']);
    expect(fixture.client.getState().completion).toBe('cancelled');
    expect(fixture.client.getState().model).toBeDefined();
    await fixture.client.releaseModel();
    expect(fixture.events.at(-1)).toBe('model_release');
  });

  it('publishes max_seconds completion and retains the model for a new session', async () => {
    await using fixture = speechSessionFixture({ start: undefined, push: async () => ({ kind: 'completed', reason: 'max_seconds' }) });
    await fixture.client.loadModel({ file });
    await fixture.client.start({ options: startOptions });
    fixture.client.push({ samples: new Float32Array(8), sampleRate: 24000 });
    await fixture.client.stop({ mode: 'finish' });
    expect(fixture.client.getState().completion).toBe('max_seconds');
    expect(fixture.events).not.toContain('model_release');
    await fixture.client.start({ options: startOptions });
    expect(fixture.client.getState().phase).toBe('running');
  });

  it('preserves native failure details while releasing session before model', async () => {
    const details = { code: 'runtime_failed' as const, message: 'device failed', nativeStatus: -5, nativeInput: 'device' };
    await using fixture = speechSessionFixture({
      start: undefined,
      push: async () => {
        throw new SpeechRuntimeError({ details });
      },
    });
    await fixture.client.loadModel({ file });
    await fixture.client.start({ options: startOptions });
    fixture.client.push({ samples: new Float32Array(8), sampleRate: 24000 });
    await fixture.client.stop({ mode: 'finish' });
    expect(fixture.client.getState().phase).toBe('failed');
    expect(fixture.client.getState().failure).toEqual(details);
    expect(fixture.events.slice(-3)).toEqual(['end', 'dialogue_release', 'model_release']);
  });

  it('releases a model that arrives after disposal without publishing it', async () => {
    const opened = Promise.withResolvers<void>();
    await using fixture = speechSessionFixture({ start: undefined, push: undefined });
    const client = createSpeechSession({
      openModel: async () => {
        await opened.promise;
        return fixture.model;
      },
      observers: { onFrame() {}, onState() {} },
      maxQueuedSeconds: 1,
    });
    const loading = client.loadModel({ file });
    const rejected = expect(loading).rejects.toBeDefined();
    const disposed = client.dispose();
    opened.resolve();
    await rejected;
    await disposed;
    expect(fixture.events.filter(value => value === 'model_release')).toHaveLength(1);
    expect(client.getState().phase).toBe('disposed');
  });
});
