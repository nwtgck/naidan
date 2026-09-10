// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createProductionLoadIdentityTracker, productionLoadIdentitySchema } from './load-identity';

const fetch = vi.fn(() => {
  throw new Error('External network forbidden in load identity tests');
});
beforeEach(() => {
  vi.stubGlobal('fetch', fetch);
});
afterEach(() => {
  expect(fetch).not.toHaveBeenCalled(); vi.unstubAllGlobals();
});
function route() {
  return { cleanModelId: 'synthetic/model', autoClass: 'AutoModelForCausalLM', processor: 'tokenizer', candidate: { device: 'wasm', dtype: 'q4' } };
}
function ready() {
  return {
    status: 'ready', workerLoadOrdinal: 1, requestedModelId: 'hf.co/synthetic/model', requestedRevision: { status: 'provided', value: 'synthetic-revision' },
    cleanModelId: 'synthetic/model', autoClass: 'AutoModelForCausalLM', processor: 'tokenizer',
    selectedCandidate: { device: 'wasm', dtype: 'q4' }, resolvedRevision: { status: 'not-observed' }, sessionExecutionProvider: { status: 'not-observed' },
  };
}

describe('Worker-local completed Production Load identity', () => {
  it('records the ordinary completed route rather than inferring a backend or resolved revision', () => {
    const tracker = createProductionLoadIdentityTracker();
    expect(tracker.snapshot()).toEqual({ status: 'not-observed', reason: 'no-completed-load' });
    const load = tracker.beginLoad({ source: 'ordinary', modelId: 'hf.co/synthetic/model', revision: 'synthetic-revision' });
    expect(tracker.snapshot()).toEqual({ status: 'not-observed', reason: 'load-in-progress' });
    load.finish({ route: route() });
    expect(tracker.snapshot()).toEqual(ready());
  });

  it('retains an omitted revision without inventing main or an immutable commit', () => {
    const tracker = createProductionLoadIdentityTracker();
    tracker.beginLoad({ source: 'ordinary', modelId: 'synthetic/model', revision: undefined }).finish({ route: route() });
    expect(tracker.snapshot()).toMatchObject({ status: 'ready', requestedRevision: { status: 'omitted' }, resolvedRevision: { status: 'not-observed' } });
  });

  it('owns and freezes primitive copies without retaining candidate or arbitrary route data', () => {
    const tracker = createProductionLoadIdentityTracker();
    const original = route();
    const secret = vi.fn(() => {
      throw new Error('Unrelated getter must not run');
    });
    Object.defineProperty(original, 'loadAttempts', { get: secret });
    tracker.beginLoad({ source: 'ordinary', modelId: 'synthetic/model', revision: undefined }).finish({ route: original });
    original.candidate.dtype = 'q4f16';
    const snapshot = tracker.snapshot();
    expect(snapshot).toMatchObject({ selectedCandidate: { dtype: 'q4' } });
    expect(Object.isFrozen(snapshot)).toBe(true);
    if (snapshot.status !== 'ready') throw new Error('Expected ready');
    expect(Object.isFrozen(snapshot.selectedCandidate)).toBe(true);
    expect(Object.isFrozen(snapshot.requestedRevision)).toBe(true);
    expect(secret).not.toHaveBeenCalled();
  });

  it('rejects selected-field accessors without invoking them or throwing into Load', () => {
    const tracker = createProductionLoadIdentityTracker();
    const value = route();
    const getter = vi.fn(() => {
      throw new Error('Do not read accessor');
    });
    Object.defineProperty(value, 'candidate', { get: getter });
    expect(() => tracker.beginLoad({ source: 'ordinary', modelId: 'synthetic/model', revision: undefined }).finish({ route: value })).not.toThrow();
    expect(tracker.snapshot()).toEqual({ status: 'not-observed', reason: 'recording-failed' });
    expect(getter).not.toHaveBeenCalled();
  });

  it('bounds identity strings instead of publishing a truncated model identity', () => {
    const tracker = createProductionLoadIdentityTracker();
    tracker.beginLoad({ source: 'ordinary', modelId: 'synthetic/model', revision: 'x'.repeat(129) }).finish({ route: route() });
    expect(tracker.snapshot()).toEqual({ status: 'not-observed', reason: 'identity-limit' });
  });

  it('invalidates a prior ready route when a subsequent Load fails before preparation completes', () => {
    const tracker = createProductionLoadIdentityTracker();
    tracker.beginLoad({ source: 'ordinary', modelId: 'synthetic/model', revision: undefined }).finish({ route: route() });
    tracker.beginLoad({ source: 'ordinary', modelId: 'synthetic/model', revision: 'second' }).finish({ route: undefined });
    expect(tracker.snapshot()).toEqual({ status: 'not-observed', reason: 'no-completed-load' });
  });

  it('permits its own candidate cleanup before a successful fallback route completes', () => {
    const tracker = createProductionLoadIdentityTracker();
    const load = tracker.beginLoad({ source: 'ordinary', modelId: 'synthetic/model', revision: undefined });
    load.clear();
    expect(tracker.snapshot()).toEqual({ status: 'not-observed', reason: 'runtime-cleared' });
    load.finish({ route: route() });
    expect(tracker.snapshot()).toMatchObject({ status: 'ready', selectedCandidate: { device: 'wasm', dtype: 'q4' } });
  });

  it('invalidates immediately on external unload and prevents a late completion from restoring ready', () => {
    const tracker = createProductionLoadIdentityTracker();
    const load = tracker.beginLoad({ source: 'ordinary', modelId: 'synthetic/model', revision: undefined });
    tracker.clear();
    expect(tracker.snapshot()).toEqual({ status: 'not-observed', reason: 'runtime-cleared' });
    load.finish({ route: route() });
    expect(tracker.snapshot()).toEqual({ status: 'not-observed', reason: 'runtime-cleared' });
  });

  it('does not claim either overlapping Load is the active runtime and recovers only on a new uncontended Load', () => {
    const tracker = createProductionLoadIdentityTracker();
    const first = tracker.beginLoad({ source: 'ordinary', modelId: 'synthetic/model', revision: 'first' });
    const second = tracker.beginLoad({ source: 'ordinary', modelId: 'synthetic/model', revision: 'second' });
    second.finish({ route: route() });
    first.finish({ route: route() });
    expect(tracker.snapshot()).toEqual({ status: 'not-observed', reason: 'overlapping-lifecycle' });
    tracker.beginLoad({ source: 'ordinary', modelId: 'synthetic/model', revision: 'third' }).finish({ route: route() });
    expect(tracker.snapshot()).toMatchObject({ status: 'ready', workerLoadOrdinal: 3, requestedRevision: { value: 'third' } });
  });

  it('invalidates ordinary ready when a non-ordinary private loader starts and does not promote that result', () => {
    const tracker = createProductionLoadIdentityTracker();
    tracker.beginLoad({ source: 'ordinary', modelId: 'synthetic/model', revision: undefined }).finish({ route: route() });
    const probe = tracker.beginLoad({ source: 'non-ordinary', modelId: 'synthetic/model', revision: undefined });
    expect(tracker.snapshot()).toEqual({ status: 'not-observed', reason: 'untracked-load-path' });
    probe.finish({ route: route() });
    expect(tracker.snapshot()).toEqual({ status: 'not-observed', reason: 'untracked-load-path' });
  });

  it('does not let a duplicate completion or cleanup from a finished operation overwrite a later ready', () => {
    const tracker = createProductionLoadIdentityTracker();
    const first = tracker.beginLoad({ source: 'ordinary', modelId: 'synthetic/model', revision: 'first' });
    first.finish({ route: route() });
    tracker.beginLoad({ source: 'ordinary', modelId: 'synthetic/model', revision: 'second' }).finish({ route: route() });
    first.clear(); first.finish({ route: undefined });
    expect(tracker.snapshot()).toMatchObject({ status: 'ready', workerLoadOrdinal: 2, requestedRevision: { value: 'second' } });
  });

  it('starts a new Worker tracker with no prior Load identity', () => {
    const first = createProductionLoadIdentityTracker();
    first.beginLoad({ source: 'ordinary', modelId: 'synthetic/model', revision: undefined }).finish({ route: route() });
    expect(createProductionLoadIdentityTracker().snapshot()).toEqual({ status: 'not-observed', reason: 'no-completed-load' });
  });

  it('rejects a mismatched normalized model in the receiving DTO', () => {
    const value = ready();
    expect(productionLoadIdentitySchema.safeParse(value).success).toBe(true);
    expect(productionLoadIdentitySchema.safeParse({ ...value, cleanModelId: 'other/model' }).success).toBe(false);
  });

  it('rejects invented backend resolution and unsafe ordinals in the receiving DTO', () => {
    const value = ready();
    expect(productionLoadIdentitySchema.safeParse({ ...value, sessionExecutionProvider: { status: 'observed', value: 'webgpu' } }).success).toBe(false);
    expect(productionLoadIdentitySchema.safeParse({ ...value, workerLoadOrdinal: Number.MAX_SAFE_INTEGER + 1 }).success).toBe(false);
  });
});
