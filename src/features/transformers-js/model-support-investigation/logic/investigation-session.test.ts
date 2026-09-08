import { Blob as NodeBlob } from 'node:buffer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { configurationForPreset } from './investigation-config';
import {
  recallInvestigationSession,
  rememberInvestigationSession,
  TEST_ONLY,
  type InvestigationSessionSnapshot,
} from './investigation-session';

function snapshot({ batchId }: { batchId: string }): InvestigationSessionSnapshot {
  return {
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
    for (const batchId of ['first', 'second', 'third']) {
      rememberInvestigationSession({ snapshot: snapshot({ batchId }) });
    }
    expect(recallInvestigationSession({ seededTarget: 'org/first' })).toBeUndefined();
    expect(recallInvestigationSession({ seededTarget: 'org/second' })?.batchId).toBe('second');
    expect(recallInvestigationSession({ seededTarget: undefined })?.batchId).toBe('third');
    rememberInvestigationSession({ snapshot: snapshot({ batchId: 'second' }) });
    expect(recallInvestigationSession({ seededTarget: undefined })?.batchId).toBe('second');
    expect(recallInvestigationSession({ seededTarget: 'org/third' })?.batchId).toBe('third');
  });

  it('isolates mutable result state while retaining immutable Blob bytes for re-export', async () => {
    const original = snapshot({ batchId: 'first' });
    original.replayMetadata = [['org/first', [{ path: 'config.json', blob: new Blob(['{"model_type":"fixture"}']) }]]];
    rememberInvestigationSession({ snapshot: original });
    original.targets.push('org/other');
    original.replayMetadata.splice(0);
    const restored = recallInvestigationSession({ seededTarget: 'org/first' });
    expect(restored?.targets).toEqual(['org/first']);
    expect(await restored?.replayMetadata[0]?.[1][0]?.blob.text()).toBe('{"model_type":"fixture"}');
    restored?.targets.splice(0);
    expect(recallInvestigationSession({ seededTarget: 'org/first' })?.targets).toEqual(['org/first']);
  });

  it('does not substitute a different model result and clears all retained state', () => {
    rememberInvestigationSession({ snapshot: snapshot({ batchId: 'first' }) });
    expect(recallInvestigationSession({ seededTarget: 'org/unknown' })).toBeUndefined();
    TEST_ONLY.clear();
    expect(recallInvestigationSession({ seededTarget: undefined })).toBeUndefined();
  });
});
