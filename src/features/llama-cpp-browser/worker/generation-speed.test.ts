import { describe, expect, it, vi } from 'vitest';
import { createGenerationSpeedTracker } from './generation-speed';
import { generationEventSchema, generationResultSchema } from '@/features/llama-cpp-browser/types';

describe('lightweight worker generation speed', () => {
  it('does not block sampling and permits at most one unacknowledged telemetry event', async () => {
    let release!: () => void;
    const blocked = new Promise<void>(resolve => {
      release = resolve;
    });
    const onEvent = vi.fn(() => blocked);
    const tracker = createGenerationSpeedTracker({ onEvent });
    tracker.sample({ sampledAt: 0, endOfGeneration: false });
    tracker.sample({ sampledAt: 1000, endOfGeneration: false });
    tracker.sample({ sampledAt: 2000, endOfGeneration: false });
    tracker.sample({ sampledAt: 3000, endOfGeneration: false });
    expect(onEvent).toHaveBeenCalledOnce();
    expect(tracker.finish()).toMatchObject({ nOutputTokens: 4, speed: { perSecond: 1 } });
    release();
    await blocked;
    await Promise.resolve();
    tracker.sample({ sampledAt: 4000, endOfGeneration: false });
    expect(onEvent).toHaveBeenCalledTimes(2);
  });

  it('contains failed optional event delivery and still returns final metrics', async () => {
    const tracker = createGenerationSpeedTracker({
      onEvent: async () => {
        throw new Error('receiver closed');
      },
    });
    tracker.sample({ sampledAt: 0, endOfGeneration: false });
    tracker.sample({ sampledAt: 1000, endOfGeneration: false });
    await Promise.resolve();
    await Promise.resolve();
    tracker.sample({ sampledAt: 2000, endOfGeneration: false });
    expect(tracker.finish()).toMatchObject({ nOutputTokens: 3, speed: { perSecond: 1 } });
    await Promise.resolve();
  });

  it('excludes EOG from both the numerator and the final sample timestamp', () => {
    const tracker = createGenerationSpeedTracker({ onEvent: async () => {} });
    tracker.sample({ sampledAt: 0, endOfGeneration: false });
    tracker.sample({ sampledAt: 1000, endOfGeneration: false });
    tracker.sample({ sampledAt: 10000, endOfGeneration: true });
    expect(tracker.finish()).toMatchObject({ nOutputTokens: 2, speed: { perSecond: 1, interval: { nUnits: 1, durationMs: 1000 } } });
    const empty = createGenerationSpeedTracker({ onEvent: async () => {} });
    empty.sample({ sampledAt: 10000, endOfGeneration: true });
    expect(empty.finish()).toBeUndefined();
  });

  it('normalizes malformed optional wire metrics without accepting malformed required content', () => {
    expect(generationEventSchema.parse({ type: 'generation_metrics', metrics: { speed: 'invalid' } })).toEqual({ type: 'generation_metrics', metrics: undefined });
    expect(generationEventSchema.safeParse({ type: 'text', text: 3 }).success).toBe(false);
    // Result validation still owns the content contract; only its telemetry field is lenient.
    const shape = generationResultSchema.shape.generationMetrics;
    expect(shape.parse({ speed: { unit: 'tokens', measurement: 'worker_sample_interval', perSecond: -1 } })).toBeUndefined();
  });
});
