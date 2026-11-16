import { describe, expect, it } from 'vitest';
import { createModelLoadEstimate, modelLoadStageWeights } from './model-load-progress';

describe('model load work estimate', () => {
  it('keeps byte coverage separate from overall work and reserves native completion for validation', () => {
    const estimate = createModelLoadEstimate();
    expect(estimate.update({ progress: { stage: 'checking_model' }, ready: false })).toBeUndefined();
    expect(estimate.update({ progress: { stage: 'loading_runtime', fetchedBytes: 1, decompressedBytes: 1, totalDecompressedBytes: 4 }, ready: false })).toBe(25);
    const partial = estimate.update({ progress: { stage: 'reading_model', readBytes: 95, totalBytes: 100000 }, ready: false });
    expect(partial).toBeGreaterThanOrEqual(40);
    expect(partial).toBeLessThan(41);
    expect(estimate.update({ progress: { stage: 'reading_model', readBytes: 100000, totalBytes: 100000 }, ready: false })).toBe(85);
    expect(estimate.update({ progress: { stage: 'preparing_model' }, ready: false })).toBe(85);
    expect(estimate.update({ progress: { stage: 'checking_loaded_model' }, ready: false })).toBe(90);
    expect(estimate.update({ progress: undefined, ready: true })).toBe(100);
    expect(Object.values(modelLoadStageWeights).reduce((total, value) => total + value, 0)).toBe(100);
  });

  it('does not go backwards when validation repeats or when runtime loading precedes JS checks', () => {
    const estimate = createModelLoadEstimate();
    expect(estimate.update({ progress: { stage: 'loading_runtime', fetchedBytes: 1, decompressedBytes: 1, totalDecompressedBytes: 1 }, ready: false })).toBe(20);
    expect(estimate.update({ progress: { stage: 'checking_model' }, ready: false })).toBe(20);
    expect(estimate.update({ progress: { stage: 'reading_model', readBytes: 1, totalBytes: 2 }, ready: false })).toBe(62.5);
    expect(estimate.update({ progress: { stage: 'checking_model' }, ready: false })).toBe(62.5);
    expect(estimate.update({ progress: { stage: 'reading_model', readBytes: 1, totalBytes: 10 }, ready: false })).toBe(62.5);
    expect(estimate.update({ progress: { stage: 'checking_loaded_model' }, ready: false })).toBeLessThan(100);
  });

  it('resets for a new model load and keeps unquantified initial work indeterminate', () => {
    const estimate = createModelLoadEstimate();
    expect(estimate.update({ progress: undefined, ready: false })).toBeUndefined();
    expect(estimate.update({ progress: { stage: 'preparing_runtime' }, ready: false })).toBeUndefined();
    estimate.update({ progress: { stage: 'reading_model', readBytes: 1, totalBytes: 1 }, ready: false });
    estimate.reset();
    expect(estimate.update({ progress: { stage: 'checking_model' }, ready: false })).toBeUndefined();
  });
});
