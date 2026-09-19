import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDownloadMeasurementClock, createDownloadTimingCollector, disposeWithDownloadTiming, downloadTimingSnapshotSchema, type DownloadAcceptanceTiming } from './download-timing';

const observation: DownloadAcceptanceTiming = {
  kind: 'acceptance', version: 1, revision: 'a'.repeat(40), route: 'candidate',
  candidate: { device: 'webgpu', dtype: 'q4f16' }, timingStatus: 'measured', hostDurationMs: 23_000,
  loadOutcome: 'accepted', cleanupOutcome: 'completed', hostSettlement: 'fulfilled', attemptCount: 1,
};
afterEach(() => vi.restoreAllMocks());

describe('retained Download timing', () => {
  it('preserves a synchronous disposal failure even when its observer asynchronously rejects', async () => {
    const original = new Error('Synthetic disposal failure');
    const outcomes: string[] = [];
    await expect(disposeWithDownloadTiming({
      dispose: () => {
        throw original;
      },
      onOutcome: async ({ outcome }) => {
        outcomes.push(outcome);
        throw new Error('Synthetic observation failure');
      },
    })).rejects.toBe(original);
    expect(outcomes).toEqual(['failed']);
  });

  it('keeps snapshots detached from both callback inputs and later operations', () => {
    const collector = createDownloadTimingCollector();
    const owner = collector.begin({ modelId: 'org/model', runtimeEpoch: 0 });
    const input = structuredClone(observation);
    owner.observe({ observation: input });
    input.hostDurationMs = 99;
    const first = collector.snapshot();
    owner.finish({ outcome: 'completed' });
    collector.begin({ modelId: 'org/next', runtimeEpoch: 0 });
    expect(first.records).toHaveLength(1);
    expect(first.records[0]?.outcome).toBe('running');
    expect(first.records[0]?.observations[0]).toEqual(observation);
    first.records[0]!.observations.length = 0;
    expect(collector.snapshot().records[0]?.observations).toEqual([observation]);
  });

  it('bounds records and per-operation scalars while ignoring late evicted owners', () => {
    const collector = createDownloadTimingCollector();
    const first = collector.begin({ modelId: 'org/first', runtimeEpoch: 0 });
    for (let i = 0; i < 8; i++) collector.begin({ modelId: 'org/next', runtimeEpoch: i });
    first.observe({ observation });
    first.finish({ outcome: 'completed' });
    const current = collector.begin({ modelId: 'org/current', runtimeEpoch: 9 });
    for (let i = 0; i < 130; i++) current.observe({ observation });
    const snapshot = collector.snapshot();
    expect(snapshot.records).toHaveLength(8);
    expect(snapshot.droppedOperations).toBe(2);
    expect(snapshot.records.at(-1)).toMatchObject({ truncated: true, droppedObservations: 2 });
    expect(snapshot.records.at(-1)?.observations).toHaveLength(128);
    expect(downloadTimingSnapshotSchema.safeParse(snapshot).success).toBe(true);
  });

  it('does not retain private paths, query strings or malformed advisory fields', () => {
    const collector = createDownloadTimingCollector();
    const owner = collector.begin({ modelId: '/private/example?token=synthetic', runtimeEpoch: 0 });
    owner.observe({ observation: { ...observation, revision: 'main?token=secret' } });
    const snapshot = collector.snapshot();
    expect(snapshot.records[0]?.modelId).toBeUndefined();
    expect(snapshot.records[0]?.observations).toEqual([]);
    expect(snapshot.records[0]?.truncated).toBe(true);
    expect(JSON.stringify(snapshot)).not.toContain('secret');
    expect(JSON.stringify(snapshot)).not.toContain('/private/');
  });

  it('does not fabricate cross-session identity when random identity is unavailable', () => {
    vi.spyOn(crypto, 'randomUUID').mockImplementation(() => {
      throw new Error('no entropy');
    });
    const collector = createDownloadTimingCollector();
    collector.begin({ modelId: 'org/model', runtimeEpoch: 0 }).finish({ outcome: 'completed' });
    const snapshot = collector.snapshot();
    expect(snapshot.identityStatus).toBe('unavailable');
    expect(snapshot.serviceEpoch).toBeUndefined();
    expect(snapshot.records[0]?.operationId).toBeUndefined();
    expect(snapshot.records[0]?.wallMs).toBeUndefined();
  });

  it('rejects oversized raw arrays before reading their elements', () => {
    const snapshot = createDownloadTimingCollector().snapshot();
    const records = new Array(129);
    const read = vi.fn(() => {
      throw new Error('Oversized array must not be traversed');
    });
    Object.defineProperty(records, 0, { get: read });
    expect(downloadTimingSnapshotSchema.safeParse({ ...snapshot, records }).success).toBe(false);
    expect(read).not.toHaveBeenCalled();
  });

  it('disables an invalid clock without coercing a negative duration to zero', () => {
    let now = 10;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const clock = createDownloadMeasurementClock();
    const start = clock.read();
    now = 9;
    const end = clock.read();
    expect(clock.elapsed({ start, end })).toBeUndefined();
    now = 20;
    expect(clock.read()).toBeUndefined();
  });

  it('keeps independent services isolated and clears only the owning lifetime', () => {
    const first = createDownloadTimingCollector();
    const second = createDownloadTimingCollector();
    const owner = first.begin({ modelId: 'org/model', runtimeEpoch: 0 });
    const frozen = first.snapshot();
    first.clear();
    owner.observe({ observation });
    expect(first.snapshot().records).toEqual([]);
    expect(second.snapshot().availability).toBe('unavailable-in-this-service-session');
    expect(frozen.records).toHaveLength(1);
    expect(first.snapshot().serviceEpoch).not.toBe(second.snapshot().serviceEpoch);
  });

  it('marks owner retirement without inventing I/O completion and ignores its late settlement', () => {
    const collector = createDownloadTimingCollector();
    const old = collector.begin({ modelId: 'org/old', runtimeEpoch: 0 });
    collector.retireActive();
    const retired = collector.snapshot();
    const next = collector.begin({ modelId: 'org/new', runtimeEpoch: 1 });
    old.observe({ observation });
    old.finish({ outcome: 'completed' });
    next.observe({ observation });
    const current = collector.snapshot();
    expect(current.records[0]).toEqual(retired.records[0]);
    expect(current.records[0]).toMatchObject({ outcome: 'retired', wallMs: undefined, timingStatus: 'unavailable', observations: [] });
    expect(current.records[1]).toMatchObject({ outcome: 'running', observations: [observation] });
  });
});
