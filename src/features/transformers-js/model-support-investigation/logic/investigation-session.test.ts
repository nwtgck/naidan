import { Blob as NodeBlob } from 'node:buffer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { configurationForPreset } from './investigation-config';
import {
  recallInvestigationSession,
  createInvestigationSessionView,
  TEST_ONLY,
  type InvestigationSessionSnapshot,
} from './investigation-session';

function snapshot({ batchId }: { batchId: string }): Extract<InvestigationSessionSnapshot, { view: 'results' }> {
  return {
    view: 'results',
    batchId,
    targets: [`org/${batchId}`],
    configuration: configurationForPreset({ preset: 'download-focused' }),
    executions: [],
    runs: [],
    recoveries: [],
    replayMetadata: [],
    selectedTarget: undefined,
  };
}

beforeEach(() => {
  TEST_ONLY.clear();
  // Exercise native Blob structured cloning, unavailable in jsdom's Blob.
  vi.stubGlobal('Blob', NodeBlob);
});
afterEach(() => vi.unstubAllGlobals());

describe('tab-memory investigation sessions', () => {
  it('keeps only two batches and replaces an existing batch without growing history', () => {
    const view = createInvestigationSessionView({ initialSnapshot: undefined });
    for (const batchId of ['first', 'second', 'third']) {
      view.remember({ snapshot: snapshot({ batchId }) });
    }
    expect(recallInvestigationSession({ seededTarget: 'org/first' })).toBeUndefined();
    expect(recallInvestigationSession({ seededTarget: 'org/second' })?.batchId).toBe('second');
    expect(recallInvestigationSession({ seededTarget: undefined })?.batchId).toBe('third');
    view.remember({ snapshot: snapshot({ batchId: 'second' }) });
    expect(recallInvestigationSession({ seededTarget: undefined })?.batchId).toBe('second');
    expect(recallInvestigationSession({ seededTarget: 'org/third' })?.batchId).toBe('third');
  });

  it('isolates mutable result state while retaining immutable Blob bytes for re-export', async () => {
    const view = createInvestigationSessionView({ initialSnapshot: undefined });
    const original = snapshot({ batchId: 'first' });
    original.replayMetadata = [['org/first', [{ path: 'config.json', blob: new Blob(['{"model_type":"fixture"}']) }]]];
    view.remember({ snapshot: original });
    original.targets.push('org/other');
    original.replayMetadata.splice(0);
    const restored = recallInvestigationSession({ seededTarget: 'org/first' });
    if (restored?.view !== 'results') throw new Error('Expected retained results');
    expect(restored?.targets).toEqual(['org/first']);
    expect(await restored?.replayMetadata[0]?.[1][0]?.blob.text()).toBe('{"model_type":"fixture"}');
    restored?.targets.splice(0);
    expect(recallInvestigationSession({ seededTarget: 'org/first' })?.targets).toEqual(['org/first']);
  });

  it('does not substitute a different model result and clears all retained state', () => {
    const view = createInvestigationSessionView({ initialSnapshot: undefined });
    view.remember({ snapshot: snapshot({ batchId: 'first' }) });
    expect(recallInvestigationSession({ seededTarget: 'org/unknown' })).toBeUndefined();
    TEST_ONLY.clear();
    expect(recallInvestigationSession({ seededTarget: undefined })).toBeUndefined();
  });

  it('replaces retained Results with an explicit Setup session containing only model choices', () => {
    const view = createInvestigationSessionView({ initialSnapshot: undefined });
    const results = snapshot({ batchId: 'first' });
    results.replayMetadata = [['org/first', [{ path: 'config.json', blob: new Blob(['old']) }]]];
    view.remember({ snapshot: results });
    const setup: InvestigationSessionSnapshot = {
      view: 'setup',
      batchId: results.batchId,
      targets: results.targets,
      configuration: results.configuration,
    };
    view.remember({ snapshot: setup });
    expect(recallInvestigationSession({ seededTarget: 'org/first' })).toEqual(setup);
    expect(recallInvestigationSession({ seededTarget: undefined })).toEqual(setup);
  });

  it('revokes a retired view synchronously and waits for its teardown before a new view is ready', async () => {
    const results = snapshot({ batchId: 'first' });
    const first = createInvestigationSessionView({ initialSnapshot: undefined });
    first.remember({ snapshot: results });
    const disposal = Promise.withResolvers<void>();
    const dispose = vi.fn(() => disposal.promise);
    const retirement = first.retire({ dispose });
    expect(first.isActive()).toBe(false);
    expect(dispose).toHaveBeenCalledOnce();
    expect(first.retire({ dispose })).toBe(retirement);
    const reopened = createInvestigationSessionView({ initialSnapshot: recallInvestigationSession({ seededTarget: 'org/first' }) });
    expect(reopened.viewId).not.toBe(first.viewId);
    expect(reopened.initialSnapshot?.batchId).toBe('first');
    expect(reopened.initialReadiness).toBe('waiting-for-teardown');
    const ready = vi.fn();
    void reopened.ready.then(ready);
    const replacement = snapshot({ batchId: 'second' });
    reopened.remember({ snapshot: replacement });
    first.remember({ snapshot: results });
    expect(recallInvestigationSession({ seededTarget: undefined })?.batchId).toBe('second');
    expect(ready).not.toHaveBeenCalled();
    disposal.resolve();
    await reopened.ready;
    expect(ready).toHaveBeenCalledOnce();
  });

  it('returns an explicit terminal failure when disposal rejects and carries it into reopened views', async () => {
    const first = createInvestigationSessionView({ initialSnapshot: undefined });
    const result = await first.retire({ dispose: async () => {
      throw new Error('Worker termination unavailable');
    } });
    expect(result).toEqual({ status: 'failed', error: 'Worker termination unavailable' });
    const reopened = createInvestigationSessionView({ initialSnapshot: undefined });
    expect(await reopened.ready).toEqual(result);
    expect(first.isActive()).toBe(false);
    expect(await reopened.retire({ dispose: async () => undefined })).toEqual(result);
    expect(TEST_ONLY.retiringViewCount()).toBe(1);
  });

  it('handles a synchronous teardown exception without rejecting its retirement promise', async () => {
    const view = createInvestigationSessionView({ initialSnapshot: undefined });
    expect(await view.retire({ dispose: () => {
      throw new Error('Synchronous teardown failure');
    } })).toEqual({
      status: 'failed', error: 'Synchronous teardown failure',
    });
  });
});
