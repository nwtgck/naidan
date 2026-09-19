import { afterEach, describe, expect, it, vi } from 'vitest';
import { configurationForPreset } from './investigation-config';
import { createInitialInvestigationCheckpoint } from './investigation-recovery';
import type { InvestigationReplayMetadataSummary } from './collect-replay-metadata';
import type { FreshMetadataSummary } from '@/features/transformers-js/model-support-investigation/fresh-metadata-worker/types';
import {
  isDownloadOnlyInvestigation,
  targetInvestigationBudgetMs,
  settledReplayMetadataBytes,
  withInvestigationTargetBudget,
} from './investigation-batch-budget';

afterEach(() => vi.useRealTimers());

describe('download investigation batch budget', () => {
  it('charges all fresh HTTP bytes without double-counting their in-memory replay', () => {
    const checkpoint = createInitialInvestigationCheckpoint({ modelId: 'org/model', runId: 'fresh-model', now: () => '2026-09-09T00:00:00.000Z' });
    const summary: InvestigationReplayMetadataSummary = {
      schemaVersion: 1, modelId: 'org/model', revision: 'a'.repeat(40), status: 'partial',
      receivedBytes: 100, retainedBytes: 0, budgetBytes: 1024, files: [],
    };
    const freshMetadata: FreshMetadataSummary = {
      schemaVersion: 1, modelId: 'org/model', revision: 'a'.repeat(40), source: 'fresh-network-memory',
      status: 'failed', maximumBytes: 1024, receivedBytes: 175,
      requests: [{ consumer: 'runtime-preparation', path: 'config.json', request: 'full', status: 'complete', receivedBytes: 175 }],
    };
    expect(settledReplayMetadataBytes({ summary, freshMetadata, recovery: checkpoint.recovery })).toBe(175);
  });

  it('keeps the reservation when fresh acquisition ended with an unaccounted cancelled body', () => {
    const checkpoint = createInitialInvestigationCheckpoint({ modelId: 'org/model', runId: 'cancelled-fresh-model', now: () => '2026-09-09T00:00:00.000Z' });
    const summary: InvestigationReplayMetadataSummary = {
      schemaVersion: 1, modelId: 'org/model', revision: 'a'.repeat(40), status: 'partial',
      receivedBytes: 0, retainedBytes: 0, budgetBytes: 1024, files: [],
    };
    const freshMetadata: FreshMetadataSummary = {
      schemaVersion: 1, modelId: 'org/model', revision: 'a'.repeat(40), source: 'fresh-network-memory',
      status: 'failed', maximumBytes: 1024, receivedBytes: 200,
      requests: [{ consumer: 'runtime-preparation', path: 'tokenizer.json', request: 'full', status: 'cancelled', receivedBytes: 200 }],
    };
    expect(settledReplayMetadataBytes({ summary, freshMetadata, recovery: checkpoint.recovery })).toBeUndefined();
  });

  it('does not exhaust later models budgets for a successfully cancelled header-only size probe', () => {
    const checkpoint = createInitialInvestigationCheckpoint({ modelId: 'org/model', runId: 'probe-model', now: () => '2026-09-09T00:00:00.000Z' });
    const summary: InvestigationReplayMetadataSummary = {
      schemaVersion: 1, modelId: 'org/model', revision: 'a'.repeat(40), status: 'complete',
      receivedBytes: 100, retainedBytes: 0, budgetBytes: 1024, files: [],
    };
    const freshMetadata: FreshMetadataSummary = {
      schemaVersion: 1, modelId: 'org/model', revision: 'a'.repeat(40), source: 'fresh-network-memory',
      status: 'prepared', maximumBytes: 1024, receivedBytes: 101,
      preparation: { processor: 'tokenizer', resourcePlansByCandidate: {} },
      requests: [
        { consumer: 'runtime-preparation', path: 'config.json', request: 'full', status: 'complete', receivedBytes: 100 },
        { consumer: 'runtime-preparation', path: 'config.json', request: 'size-probe', status: 'cancelled', receivedBytes: 1 },
      ],
    };
    expect(settledReplayMetadataBytes({ summary, freshMetadata, recovery: checkpoint.recovery })).toBe(101);
  });

  it('settles finished collection independently of later runtime interruption, without refunding unknown reads', () => {
    const checkpoint = createInitialInvestigationCheckpoint({ modelId: 'org/model', runId: 'failed-model', now: () => '2026-09-08T00:00:00.000Z' });
    expect(checkpoint.run.status).toBe('failed');
    const summary: InvestigationReplayMetadataSummary = {
      schemaVersion: 1, modelId: 'org/model', revision: 'a'.repeat(40), status: 'partial',
      receivedBytes: 100, retainedBytes: 0, budgetBytes: 1024, files: [],
    };
    for (const status of ['complete', 'partial'] as const) {
      expect(settledReplayMetadataBytes({ freshMetadata: undefined, summary: { ...summary, status }, recovery: { ...checkpoint.recovery, status: 'completed' } })).toBe(100);
    }
    for (const status of ['running', 'interrupted'] as const) {
      expect(settledReplayMetadataBytes({ freshMetadata: undefined, summary, recovery: { ...checkpoint.recovery, status } })).toBe(100);
      expect(settledReplayMetadataBytes({ freshMetadata: undefined, summary: { ...summary, status: 'collecting' }, recovery: { ...checkpoint.recovery, status } })).toBeUndefined();
    }
    expect(settledReplayMetadataBytes({ freshMetadata: undefined, summary: { ...summary, status: 'collecting' }, recovery: { ...checkpoint.recovery, status: 'completed' } })).toBeUndefined();
    expect(settledReplayMetadataBytes({ freshMetadata: undefined, summary: undefined, recovery: checkpoint.recovery })).toBeUndefined();
    expect(settledReplayMetadataBytes({ freshMetadata: undefined, summary, recovery: undefined })).toBeUndefined();
    expect(settledReplayMetadataBytes({ freshMetadata: undefined,
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
