import { expect, it, vi } from 'vitest';
import { createGpuMeasurements } from './gpu-performance';
import { imageDiagnosticSchema } from '@/features/stable-diffusion-cpp-browser/diagnostics';
it('emits schema-valid window deltas and separate run totals, including pending waits', () => {
  let time = 0; const emit = vi.fn(); const metrics = createGpuMeasurements({ emit, now: () => time });
  metrics.begin({ runId: 1 }); metrics.write({ bytes: 12, usage: 0x40 });
  const finish = metrics.current()!.queue.start(); time = 50;
  metrics.checkpoint({ point: { phase: 'sampling', step: 0, reason: 'phase' } });
  time = 80; finish({ failed: false }); metrics.write({ bytes: 1024, usage: 0x80 });
  time = 100; metrics.finish({ outcome: 'complete' });
  for (const [entry] of emit.mock.calls) expect(imageDiagnosticSchema.safeParse({ ...entry, elapsedMs: 0 }).success, JSON.stringify(entry)).toBe(true);
  const windows = emit.mock.calls.map(([e]) => e.fields).filter(f => f.metric === 'gpu-counters');
  expect(windows.map(w => [w.scope, w.writes, w.writeBytes, w.windowWallMs])).toEqual([['window', 1, 12, 50], ['window', 1, 1024, 50], ['run-total', 2, 1036, 100]]);
  const waits = emit.mock.calls.map(([e]) => e.fields).filter(f => f.metric === 'gpu-wait' && f.kind === 'queue');
  expect(waits.map(w => [w.scope, w.wallSumMs, w.wallUnionMs, w.pending])).toEqual([['window', 50, 50, 1], ['window', 30, 30, 0], ['run-total', 80, 80, 0]]);
});
it('starts zero counters for the next image while retaining device capabilities', () => {
  const emit = vi.fn(), metrics = createGpuMeasurements({ emit, now: () => 1 });
  metrics.device({ fields: { deviceTimestampQuery: true } }); metrics.begin({ runId: 1 }); metrics.write({ bytes: 64, usage: 0 });
  const old = metrics.current()!; metrics.finish({ outcome: 'cancelled' });
  metrics.begin({ runId: 2 }); metrics.finish({ outcome: 'complete' });
  expect(old.closed).toBe(true);
  expect(emit.mock.calls.some(([e]) => e.fields.metric === 'gpu-counters' && e.fields.runId === 2 && e.fields.scope === 'run-total' && e.fields.writes === 0)).toBe(true);
  expect(emit.mock.calls.some(([e]) => e.fields.metric === 'gpu-device' && e.fields.runId === 2 && e.fields.reusedDevice)).toBe(true);
});
it('bounds coverage diagnostics and histogram storage regardless of the number of operations', () => {
  const emit = vi.fn(), metrics = createGpuMeasurements({ emit, now: () => 1 });
  for (let i = 0; i < 100; i++) metrics.unavailable({ method: 'name' + i });
  metrics.begin({ runId: 1 }); for (let i = 0; i < 20000; i++) metrics.write({ bytes: 2048, usage: 128 });
  expect(metrics.current()!.histogram).toHaveLength(8);
  expect(emit).toHaveBeenCalledTimes(1); metrics.finish({ outcome: 'failed' });
  expect(emit.mock.calls.at(-1)?.[0].fields.unavailableMethods.split(',')).toHaveLength(32);
});
