import { describe, expect, it } from 'vitest';
import { productionLoadReceiptSchema } from '@/features/transformers-js/runtime/production-load-receipt';
import { createProductionLoadReceiptSlot } from './load-receipt';

const owner = { runId: 'run-one', workerEpoch: 1 };
function receipt() {
  return productionLoadReceiptSchema.parse({
    format: 'production-offline-load-receipt-v1', modelId: 'fixture/model',
    loaderRevisionOption: { status: 'provided', value: 'a'.repeat(40) },
    autoClass: 'AutoModelForCausalLM', processor: 'tokenizer', candidate: { device: 'wasm', dtype: 'q4' },
    plannedRequiredPaths: ['onnx/model.onnx'],
    cacheLookup: { source: 'read-only-opfs-scoped-match', revision: 'a'.repeat(40), hitPaths: ['onnx/model.onnx'] },
    completion: 'model-session-and-tokenizer-processor-ready', resourceHealth: 'healthy-after-close', accessBoundary: 'production-offline-read-only',
    limitations: { wholeFileProvenance: 'not-verified', allPlannedBodiesConsumed: 'not-certified' },
  });
}

describe('Worker-owned Load receipt slot', () => {
  it('can snapshot an accepted Load before any generation and owns the ordinal', () => {
    const slot = createProductionLoadReceiptSlot();
    const first = slot.begin({ owner });
    expect(slot.snapshot({ owner })).toMatchObject({ owner, loadOrdinal: 1, outcome: { status: 'loading' } });
    first.finish({ receipt: receipt() });
    const snapshot = slot.snapshot({ owner });
    expect(snapshot).toMatchObject({ owner, loadOrdinal: 1, outcome: { status: 'accepted', receipt: receipt() } });
    expect(slot.snapshot({ owner: { ...owner, runId: 'other-run' } })).toBeUndefined();
    expect(slot.snapshot({ owner: { ...owner, workerEpoch: 2 } })).toBeUndefined();
    // Snapshot callers receive a validated copy, not the Worker slot's object.
    snapshot!.owner.runId = 'mutated-view';
    expect(slot.snapshot({ owner })?.owner).toEqual(owner);
    const second = slot.begin({ owner });
    expect(slot.snapshot({ owner })).toMatchObject({ loadOrdinal: 2, outcome: { status: 'loading' } });
    second.finish({ receipt: receipt() });
    expect(slot.snapshot({ owner })?.loadOrdinal).toBe(2);
  });

  it('replaces accepted provenance on failure and cannot be revived by duplicate settlement', () => {
    const slot = createProductionLoadReceiptSlot();
    slot.begin({ owner }).finish({ receipt: receipt() });
    const failed = slot.begin({ owner });
    failed.fail();
    failed.finish({ receipt: receipt() });
    expect(slot.snapshot({ owner })).toMatchObject({ loadOrdinal: 2, outcome: { status: 'failed' } });
    slot.begin({ owner }).finish({ receipt: undefined });
    expect(slot.snapshot({ owner })).toMatchObject({ loadOrdinal: 3, outcome: { status: 'not-recorded' } });
  });

  it('clears accepted and pending receipts without allowing late Load completion to resurrect them', () => {
    const slot = createProductionLoadReceiptSlot();
    slot.begin({ owner }).finish({ receipt: receipt() });
    slot.clear();
    expect(slot.snapshot({ owner })?.outcome.status).toBe('cleared');
    const pending = slot.begin({ owner });
    slot.clear();
    pending.finish({ receipt: receipt() });
    expect(slot.snapshot({ owner })).toMatchObject({ loadOrdinal: 2, outcome: { status: 'cleared' } });
  });

  it.each(['old-first', 'new-first'] as const)('refuses overlapping Loads regardless of settlement order: %s', order => {
    const slot = createProductionLoadReceiptSlot();
    const old = slot.begin({ owner });
    const nextOwner = { runId: 'run-two', workerEpoch: 2 };
    const next = slot.begin({ owner: nextOwner });
    for (const load of order === 'old-first' ? [old, next] : [next, old]) load.finish({ receipt: receipt() });
    expect(slot.snapshot({ owner })).toBeUndefined();
    expect(slot.snapshot({ owner: nextOwner })).toBeUndefined();
    slot.begin({ owner: nextOwner }).finish({ receipt: receipt() });
    expect(slot.snapshot({ owner: nextOwner })).toMatchObject({ owner: nextOwner, loadOrdinal: 3, outcome: { status: 'accepted' } });
  });

  it.each([
    { runId: 'bad/owner', workerEpoch: 1 }, { runId: 'run-one', workerEpoch: 0 },
    { runId: 'run-one', workerEpoch: 9 }, { ...owner, loadOrdinal: 999 },
  ])('refuses malformed or caller-supplied ordinal ownership: %j', invalidOwner => {
    const slot = createProductionLoadReceiptSlot();
    slot.begin({ owner: invalidOwner }).finish({ receipt: receipt() });
    expect(slot.snapshot({ owner })).toBeUndefined();
    slot.begin({ owner }).finish({ receipt: receipt() });
    expect(slot.snapshot({ owner })?.loadOrdinal).toBe(2);
  });
});
