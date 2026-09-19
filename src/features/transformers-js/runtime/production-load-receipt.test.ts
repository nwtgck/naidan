import { describe, expect, it, vi } from 'vitest';
import { createProductionLoadReceiptRecorder, productionLoadReceiptSchema, readProductionLoadResultReceipt } from './production-load-receipt';

const modelId = 'fixture/model';
const revision = 'a'.repeat(40);
const required = ['config.json', 'onnx/model_q4.onnx'];
const completion = {
  autoClass: 'AutoModelForCausalLM', processor: 'tokenizer',
  candidate: { device: 'wasm', dtype: 'q4' }, plannedRequiredPaths: required,
} as const;

function key({ path, cacheRevision }: { path: string; cacheRevision: string }) {
  return `models/huggingface.co/${modelId}/resolve/${cacheRevision}/${path}`;
}

function recordedReceipt() {
  const recorder = createProductionLoadReceiptRecorder({ modelId, revision });
  for (const path of required) recorder.observe({ resourceKey: key({ path, cacheRevision: revision }), result: 'hit' });
  const receipt = recorder.finish({ ...completion, plannedRequiredPaths: [...required] });
  if (receipt === undefined) throw new Error('Expected a complete scoped receipt fixture');
  return receipt;
}

describe('Production offline Load receipt recorder', () => {
  it('records scoped cache matches separately from the Loader option and body-consumption claims', () => {
    const recorder = createProductionLoadReceiptRecorder({ modelId: `hf.co/${modelId}`, revision });
    for (const path of [...required, 'tokenizer.json', 'config.json']) recorder.observe({ resourceKey: key({ path, cacheRevision: revision }), result: 'hit' });
    recorder.observe({ resourceKey: key({ path: 'optional.json', cacheRevision: revision }), result: 'miss' });
    const receipt = recorder.finish({ ...completion, plannedRequiredPaths: [...required] });
    expect(receipt).toMatchObject({
      modelId, loaderRevisionOption: { status: 'provided', value: revision },
      cacheLookup: { revision, source: 'read-only-opfs-scoped-match', hitPaths: ['config.json', 'onnx/model_q4.onnx', 'tokenizer.json'] },
      completion: 'model-session-and-tokenizer-processor-ready', resourceHealth: 'healthy-after-close',
      accessBoundary: 'production-offline-read-only',
      limitations: { wholeFileProvenance: 'not-verified', allPlannedBodiesConsumed: 'not-certified' },
    });
    expect(receipt?.plannedRequiredPaths).toEqual(required);
    expect(productionLoadReceiptSchema.safeParse({ ...receipt, limitations: { wholeFileProvenance: 'verified', allPlannedBodiesConsumed: 'certified' } }).success).toBe(false);
  });

  it.each([undefined, 'main'] as const)('preserves an explicitly omitted or main Loader option: %s', loaderRevision => {
    const recorder = createProductionLoadReceiptRecorder({ modelId, revision: loaderRevision });
    for (const path of required) recorder.observe({ resourceKey: key({ path, cacheRevision: 'main' }), result: 'hit' });
    const receipt = recorder.finish({ ...completion, plannedRequiredPaths: [...required] });
    expect(receipt?.loaderRevisionOption).toEqual(loaderRevision === undefined ? { status: 'omitted' } : { status: 'provided', value: 'main' });
    expect(receipt?.cacheLookup.revision).toBe('main');
  });

  it('does not turn a planned path or a miss into an actual cache hit', () => {
    const recorder = createProductionLoadReceiptRecorder({ modelId, revision });
    recorder.observe({ resourceKey: key({ path: required[0]!, cacheRevision: revision }), result: 'hit' });
    recorder.observe({ resourceKey: key({ path: required[1]!, cacheRevision: revision }), result: 'miss' });
    expect(recorder.finish({ ...completion, plannedRequiredPaths: [...required] })).toBeUndefined();
  });

  it.each([
    'models/huggingface.co/fixture/other/resolve/' + revision + '/config.json',
    'models/huggingface.co/fixture/model/resolve/' + revision + '/../config.json',
    'models/huggingface.co/fixture/model/resolve/' + revision + '/onnx/../config.json',
    'models/huggingface.co/fixture/model/resolve/',
  ])('refuses foreign or malformed hit namespaces permanently: %s', resourceKey => {
    const recorder = createProductionLoadReceiptRecorder({ modelId, revision });
    recorder.observe({ resourceKey, result: 'hit' });
    for (const path of required) recorder.observe({ resourceKey: key({ path, cacheRevision: revision }), result: 'hit' });
    expect(recorder.finish({ ...completion, plannedRequiredPaths: [...required] })).toBeUndefined();
  });

  it('refuses mixed actual namespaces and an option that differs from the only observed namespace', () => {
    const mixed = createProductionLoadReceiptRecorder({ modelId, revision });
    mixed.observe({ resourceKey: key({ path: required[0]!, cacheRevision: revision }), result: 'hit' });
    mixed.observe({ resourceKey: key({ path: required[1]!, cacheRevision: 'b'.repeat(40) }), result: 'hit' });
    expect(mixed.finish({ ...completion, plannedRequiredPaths: [...required] })).toBeUndefined();
    const optionMismatch = createProductionLoadReceiptRecorder({ modelId, revision: undefined });
    for (const path of required) optionMismatch.observe({ resourceKey: key({ path, cacheRevision: revision }), result: 'hit' });
    expect(optionMismatch.finish({ ...completion, plannedRequiredPaths: [...required] })).toBeUndefined();
  });

  it('bounds unique hits without penalizing repeated matches at the limit', () => {
    const recorder = createProductionLoadReceiptRecorder({ modelId, revision });
    for (let index = 0; index < 256; index++) recorder.observe({ resourceKey: key({ path: `file-${index}.json`, cacheRevision: revision }), result: 'hit' });
    recorder.observe({ resourceKey: key({ path: 'file-0.json', cacheRevision: revision }), result: 'hit' });
    expect(recorder.finish({ ...completion, plannedRequiredPaths: ['file-0.json'] })?.cacheLookup.hitPaths).toHaveLength(256);
    recorder.observe({ resourceKey: key({ path: 'overflow.json', cacheRevision: revision }), result: 'hit' });
    expect(recorder.finish({ ...completion, plannedRequiredPaths: ['file-0.json'] })).toBeUndefined();
  });

  it.each(['local/model', 'user/model'])('does not misclassify a non-repository model as HF cache acceptance: %s', localModelId => {
    const recorder = createProductionLoadReceiptRecorder({ modelId: localModelId, revision });
    recorder.observe({ resourceKey: `models/huggingface.co/${localModelId}/resolve/${revision}/config.json`, result: 'hit' });
    expect(recorder.finish({ ...completion, plannedRequiredPaths: ['config.json'] })).toBeUndefined();
  });
});

describe('Load response receipt extraction', () => {
  it('reads only a validated matching Load response and keeps legacy responses unverified', () => {
    const receipt = recordedReceipt();
    expect(readProductionLoadResultReceipt({ value: { device: 'wasm', dtype: 'q4', receipt }, modelId, revision })).toEqual(receipt);
    expect(readProductionLoadResultReceipt({ value: { device: 'wasm', dtype: 'q4' }, modelId, revision })).toBeUndefined();
  });

  it.each(['model', 'revision', 'device', 'dtype', 'shape'] as const)('refuses malformed or mismatching response provenance: %s', mismatch => {
    const receipt = recordedReceipt();
    const value = { device: 'wasm', dtype: 'q4', receipt };
    let requestedModel = modelId;
    let requestedRevision = revision;
    switch (mismatch) {
    case 'model': requestedModel = 'fixture/other'; break;
    case 'revision': requestedRevision = 'b'.repeat(40); break;
    case 'device': value.device = 'webgpu'; break;
    case 'dtype': value.dtype = 'q4f16'; break;
    case 'shape': value.receipt.cacheLookup.hitPaths = []; break;
    default: { const exhaustive: never = mismatch; throw new Error('Unexpected Load response mismatch: ' + exhaustive); }
    }
    expect(readProductionLoadResultReceipt({ value, modelId: requestedModel, revision: requestedRevision })).toBeUndefined();
  });

  it.each(['response', 'nested-receipt'] as const)('refuses getter-bearing input without invoking it: %s', location => {
    const receipt = recordedReceipt();
    const value = { device: 'wasm', dtype: 'q4', receipt };
    const getter = vi.fn(() => location === 'response' ? receipt : [...required]);
    switch (location) {
    case 'response': Object.defineProperty(value, 'receipt', { get: getter, enumerable: true }); break;
    case 'nested-receipt': Object.defineProperty(receipt.cacheLookup, 'hitPaths', { get: getter, enumerable: true }); break;
    default: { const exhaustive: never = location; throw new Error('Unexpected getter location: ' + exhaustive); }
    }
    expect.soft(readProductionLoadResultReceipt({ value, modelId, revision })).toBeUndefined();
    expect(getter).not.toHaveBeenCalled();
  });
});
