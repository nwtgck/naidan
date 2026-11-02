import { describe, expect, it } from 'vitest';
import { liveCommandSchema, liveEventSchema } from './live-types';

describe('live wire limits', () => {
  it('allows explicit channels per response without a model identifier', () => {
    for (const output of ['text', 'audio', 'mixed']) {
      expect(liveCommandSchema.safeParse({ type: 'respond', turnId: 'turn', output, maxSteps: 1024 }).success).toBe(true);
    }
  });

  it.each([NaN, Infinity, -Infinity])('rejects nonfinite microphone samples %s', value => {
    expect(liveCommandSchema.safeParse({ type: 'audio', turnId: 'turn', sequence: 0, pcm: new Float32Array([value]) }).success).toBe(false);
  });

  it('rejects oversized audio and unsafe sequence numbers', () => {
    expect(liveCommandSchema.safeParse({ type: 'audio', turnId: 't', sequence: 0, pcm: new Float32Array(32001) }).success).toBe(false);
    expect(liveCommandSchema.safeParse({ type: 'audio', turnId: 't', sequence: Number.MAX_SAFE_INTEGER + 1, pcm: new Float32Array(1) }).success).toBe(false);
  });

  it('rejects unknown commands and invalid output events', () => {
    expect(liveCommandSchema.safeParse({ type: 'execute', shell: 'ls' }).success).toBe(false);
    expect(liveEventSchema.safeParse({ type: 'audio', sampleRate: 0, pcm: new Float32Array(1) }).success).toBe(false);
    expect(liveEventSchema.safeParse({ type: 'text', text: 'x', arbitrary: true }).success).toBe(false);
  });
});
