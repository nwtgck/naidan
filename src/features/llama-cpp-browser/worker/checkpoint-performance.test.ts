import { describe, expect, it, vi } from 'vitest';
import { createCheckpointPerformance } from './checkpoint-performance';
import { checkpointPerformanceSchema } from '@/features/llama-cpp-browser/performance/checkpoint-schema';

describe('bounded checkpoint phase observations', () => {
  it('separates repeated readbacks and restores without double-counting idle time', () => {
    let time = 0; const now = vi.fn(() => time);
    const observation = createCheckpointPerformance({ now });
    expect(now).not.toHaveBeenCalled();
    observation.enter({ phase: 'capture-position' }); time = 1;
    observation.enter({ phase: 'capture-size' }); time = 2;
    observation.enter({ phase: 'capture-allocation' }); time = 3;
    observation.enter({ phase: 'capture-readback' }); time = 203; observation.end();
    time = 900; observation.enter({ phase: 'restore-memory' }); time = 901;
    observation.enter({ phase: 'restore-write' }); time = 911; observation.end();
    observation.retained(); time = 2000;
    const result = checkpointPerformanceSchema.parse(observation.snapshot());
    expect(result).toMatchObject({ captureAttempts: 1, restoreAttempts: 1, retainedRestoredCaptures: 1 });
    expect(result.phases.reduce((sum, phase) => sum + phase.elapsedMs, 0)).toBe(214);
    expect(result.phases.find(phase => phase.phase === 'capture-readback')?.elapsedMs).toBe(200);
    observation.enter({ phase: 'capture-readback' }); time = 2005;
    expect(observation.snapshot().phases.find(phase => phase.phase === 'capture-readback')).toEqual({ phase: 'capture-readback', visits: 2, elapsedMs: 205 });
    expect(result.phases.find(phase => phase.phase === 'capture-readback')?.visits).toBe(1);
  });

  it('finishes an active phase on a failed request and keeps counts bounded by phase variety', () => {
    let time = 0; const observation = createCheckpointPerformance({ now: () => time });
    for (let index = 0; index < 1000; index++) {
      observation.enter({ phase: 'capture-position' }); time++;
    }
    const result = observation.snapshot();
    expect(result.phases).toEqual([{ phase: 'capture-position', visits: 1000, elapsedMs: 1000 }]);
    expect(result.captureAttempts).toBe(1000);
    expect(checkpointPerformanceSchema.safeParse({ ...result, tensorValues: [1] }).success).toBe(false);
  });
});
