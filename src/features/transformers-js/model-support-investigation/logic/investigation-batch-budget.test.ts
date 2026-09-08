import { afterEach, describe, expect, it, vi } from 'vitest';
import { configurationForPreset } from './investigation-config';
import { createInitialInvestigationCheckpoint } from './investigation-recovery';
import type { InvestigationReplayMetadataSummary } from './collect-replay-metadata';
import {
  isDownloadOnlyInvestigation,
  targetInvestigationBudgetMs,
  settledReplayMetadataBytes,
  withInvestigationTargetBudget,
} from './investigation-batch-budget';

afterEach(() => vi.useRealTimers());

describe('download investigation batch budget', () => {
  it('settles finished collection independently of later runtime interruption, without refunding unknown reads', () => {
    const checkpoint = createInitialInvestigationCheckpoint({ modelId: 'org/model', runId: 'failed-model', now: () => '2026-09-08T00:00:00.000Z' });
    expect(checkpoint.run.status).toBe('failed');
    const summary: InvestigationReplayMetadataSummary = {
      schemaVersion: 1, modelId: 'org/model', revision: 'a'.repeat(40), status: 'partial',
      receivedBytes: 100, retainedBytes: 0, budgetBytes: 1024, files: [],
    };
    for (const status of ['complete', 'partial'] as const) {
      expect(settledReplayMetadataBytes({ summary: { ...summary, status }, recovery: { ...checkpoint.recovery, status: 'completed' } })).toBe(100);
    }
    for (const status of ['running', 'interrupted'] as const) {
      expect(settledReplayMetadataBytes({ summary, recovery: { ...checkpoint.recovery, status } })).toBe(100);
      expect(settledReplayMetadataBytes({ summary: { ...summary, status: 'collecting' }, recovery: { ...checkpoint.recovery, status } })).toBeUndefined();
    }
    expect(settledReplayMetadataBytes({ summary: { ...summary, status: 'collecting' }, recovery: { ...checkpoint.recovery, status: 'completed' } })).toBeUndefined();
    expect(settledReplayMetadataBytes({ summary: undefined, recovery: checkpoint.recovery })).toBeUndefined();
    expect(settledReplayMetadataBytes({ summary, recovery: undefined })).toBeUndefined();
    expect(settledReplayMetadataBytes({
      summary: { ...summary, files: [{ path: 'config.json', source: 'remote-exact', byteLength: 100, status: 'timeout' }] },
      recovery: { ...checkpoint.recovery, status: 'completed' },
    })).toBeUndefined();
  });
  it('limits download-only scopes, not Full or Offline runtime investigation', () => {
    expect(isDownloadOnlyInvestigation({ configuration: configurationForPreset({ preset: 'download-focused' }) })).toBe(true);
    expect(isDownloadOnlyInvestigation({ configuration: configurationForPreset({ preset: 'full' }) })).toBe(false);
    expect(isDownloadOnlyInvestigation({ configuration: configurationForPreset({ preset: 'offline' }) })).toBe(false);
    const offlineMetadata = configurationForPreset({ preset: 'download-focused' });
    offlineMetadata.externalNetworkPolicy = 'deny';
    expect(isDownloadOnlyInvestigation({ configuration: offlineMetadata })).toBe(true);
  });

  it('shares the remaining time fairly and reuses time saved by fast targets', () => {
    expect(targetInvestigationBudgetMs({ deadlineMs: 240_000, nowMs: 0, remainingTargets: 9 })).toBe(26_666);
    expect(targetInvestigationBudgetMs({ deadlineMs: 240_000, nowMs: 8_000, remainingTargets: 8 })).toBe(29_000);
    expect(targetInvestigationBudgetMs({ deadlineMs: 240_000, nowMs: 250_000, remainingTargets: 2 })).toBe(0);
    expect(() => targetInvestigationBudgetMs({ deadlineMs: 1, nowMs: 0, remainingTargets: 0 })).toThrow();
  });

  it('retains the result without calling stop after success or an ordinary failure', async () => {
    vi.useFakeTimers();
    const stop = vi.fn();
    await expect(withInvestigationTargetBudget({ start: async () => 'result', stop, timeoutMs: 100 })).resolves.toBe('result');
    await expect(withInvestigationTargetBudget({ start: async () => {
      throw new Error('original');
    }, stop, timeoutMs: 100 })).rejects.toThrow('original');
    await vi.advanceTimersByTimeAsync(1000);
    expect(stop).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stops an unresponsive target and ignores late success or rejection', async () => {
    vi.useFakeTimers();
    for (const result of ['resolve', 'reject'] as const) {
      const deferred = Promise.withResolvers<string>();
      const stop = vi.fn();
      const pending = withInvestigationTargetBudget({ start: () => deferred.promise, timeoutMs: 20, stop });
      const assertion = expect(pending).rejects.toMatchObject({ name: 'InvestigationTargetBudgetError' });
      await vi.advanceTimersByTimeAsync(20);
      await assertion;
      expect(stop).toHaveBeenCalledOnce();
      if (result === 'resolve') deferred.resolve('late');
      else deferred.reject(new Error('late failure'));
      await vi.advanceTimersByTimeAsync(100);
      expect(stop).toHaveBeenCalledOnce();
    }
  });

  it('does not start a target after the total budget has expired', async () => {
    const start = vi.fn(async () => 'unreachable');
    const stop = vi.fn();
    await expect(withInvestigationTargetBudget({ start, stop, timeoutMs: 0 })).rejects.toMatchObject({ name: 'InvestigationTargetBudgetError' });
    expect(start).not.toHaveBeenCalled();
    expect(stop).toHaveBeenCalledOnce();
  });

  it('preserves the timeout cause even when stopping the worker throws', async () => {
    vi.useFakeTimers();
    const pending = withInvestigationTargetBudget({
      start: () => new Promise(() => undefined),
      timeoutMs: 10,
      stop: () => {
        throw new Error('cleanup failed');
      },
    });
    const assertion = expect(pending).rejects.toMatchObject({ name: 'InvestigationTargetBudgetError' });
    await vi.advanceTimersByTimeAsync(10);
    await assertion;
  });
});
