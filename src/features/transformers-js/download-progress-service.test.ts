// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { TransformersJsProgressCallback, TransformersJsWorkerClient } from './types';
import type { DownloadProgressCallback } from './download-progress';
import type { RuntimeAcceptanceProgressCallback } from './download-verification/logic/runtime-acceptance-progress';
import type { DownloadTimingCallback, DownloadAcceptanceTiming } from './download-timing';

const transfer = vi.hoisted(() => ({ resolve: vi.fn(), reuse: vi.fn(), prepare: vi.fn() }));
vi.mock('./download-verification/logic/resolve-public-hugging-face-revision', () => ({ resolvePublicHuggingFaceRevision: transfer.resolve }));
vi.mock('./download-verification/logic/reuse-downloaded-production-revision', () => ({ reuseDownloadedProductionRevision: transfer.reuse }));
vi.mock('./download-verification/logic/run-production-download-preparation', () => ({ runProductionDownloadPreparation: transfer.prepare }));

const owners: Array<{ dispose(): Promise<void> }> = [];
const acceptanceTiming: DownloadAcceptanceTiming = { kind: 'acceptance', version: 1, route: 'candidate', revision: 'a'.repeat(40), candidate: { device: 'webgpu', dtype: 'q4f16' }, timingStatus: 'measured', hostDurationMs: 23_000, loadOutcome: 'accepted', cleanupOutcome: 'completed', hostSettlement: 'fulfilled', attemptCount: 1 };
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal('fetch', vi.fn(() => {
    throw new Error('Progress tests forbid network access');
  }));
  transfer.resolve.mockResolvedValue({ normalizedModelId: 'fixture/model', requestedRevision: 'main', resolvedRevision: 'a'.repeat(40) });
  transfer.reuse.mockResolvedValue({ reused: true, loadRevision: 'a'.repeat(40), acceptance: {} });
});

it('bounds a held Download subscriber and retains terminal state without waiting for its acknowledgement', async () => {
  const { createTransformersJsService } = await import('./index-hosted');
  const owner = createTransformersJsService({ createWorkerClient: () => {
    throw new Error('No runtime expected');
  } });
  owners.push(owner);
  const held = Promise.withResolvers<void>();
  const subscriber = vi.fn(({ status }: { status: string }) => status === 'loading' ? held.promise : undefined);
  owner.service.subscribe({ listener: subscriber });
  subscriber.mockClear();
  transfer.reuse.mockResolvedValue({ reused: false });
  transfer.prepare.mockImplementation(async ({ onDownloadProgress }: { onDownloadProgress: DownloadProgressCallback }) => {
    onDownloadProgress({ event: { kind: 'candidate', candidate: { device: 'wasm', dtype: 'q4' }, index: 0, count: 1 } });
    onDownloadProgress({ event: { kind: 'plan', index: 0, paths: ['onnx/model.onnx'] } });
    for (let loaded = 1; loaded <= 1000; loaded++) onDownloadProgress({ event: { kind: 'file', index: 0, info: { status: 'progress', file: 'onnx/model.onnx', loaded, total: 1000 } } });
    onDownloadProgress({ event: { kind: 'file', index: 0, info: { status: 'done', file: 'onnx/model.onnx', loaded: 1000, total: 1000 } } });
    return { status: 'accepted' };
  });
  await owner.service.downloadModel({ modelId: 'fixture/model' });
  expect(subscriber).toHaveBeenCalledTimes(1);
  expect(owner.service.getState()).toMatchObject({ status: 'idle', downloadProgress: { phase: 'complete', overallProgress: 100, files: [{ status: 'complete', loaded: 1000 }] } });
  held.resolve();
  await vi.waitFor(() => expect(subscriber).toHaveBeenCalledTimes(2));
  expect(subscriber.mock.calls[1]?.[0]).toMatchObject({ status: 'idle' });
});

it('retains ordinary Download timing in its owning service without mutating a captured snapshot', async () => {
  const { createTransformersJsService } = await import('./index-hosted');
  const first = createTransformersJsService({ createWorkerClient: () => {
    throw new Error('No runtime expected');
  } });
  const second = createTransformersJsService({ createWorkerClient: () => {
    throw new Error('No runtime expected');
  } });
  owners.push(first, second);
  transfer.reuse.mockResolvedValue({ reused: false });
  transfer.prepare.mockImplementation(async ({ onTiming }: { onTiming: DownloadTimingCallback }) => {
    onTiming({ observation: acceptanceTiming });
    return { status: 'accepted' };
  });
  const empty = first.service.getDownloadTimingSnapshot();
  await first.service.downloadModel({ modelId: 'fixture/model' });
  const snapshot = first.service.getDownloadTimingSnapshot();
  expect(snapshot.records).toHaveLength(1);
  expect(snapshot.records[0]).toMatchObject({ modelId: 'fixture/model', outcome: 'completed', observations: [acceptanceTiming] });
  expect(empty.records).toEqual([]);
  expect(second.service.getDownloadTimingSnapshot().records).toEqual([]);
  snapshot.records[0]!.observations.length = 0;
  expect(first.service.getDownloadTimingSnapshot().records[0]?.observations).toEqual([acceptanceTiming]);
  expect(transfer.prepare).toHaveBeenCalledOnce();
});

it('does not record success or late timing while a cancelled Download is still settling', async () => {
  const { createTransformersJsService } = await import('./index-hosted');
  const owner = createTransformersJsService({ createWorkerClient: () => {
    throw new Error('No runtime expected');
  } });
  owners.push(owner);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  transfer.reuse.mockResolvedValue({ reused: false });
  transfer.prepare.mockImplementation(async ({ onTiming }: { onTiming: DownloadTimingCallback }) => {
    entered.resolve();
    await release.promise;
    onTiming({ observation: acceptanceTiming });
    return { status: 'accepted' };
  });
  const running = owner.service.downloadModel({ modelId: 'fixture/model' });
  const rejected = running.catch((error: unknown) => error);
  try {
    await entered.promise;
    await owner.service.interrupt();
    const pending = owner.service.getDownloadTimingSnapshot();
    expect(pending.records[0]?.outcome).toBe('running');
    expect(pending.records[0]?.wallMs).toBeUndefined();
    release.resolve();
    expect(await rejected).toMatchObject({ name: 'AbortError' });
    expect(owner.service.getDownloadTimingSnapshot().records[0]).toMatchObject({ outcome: 'aborted', observations: [] });
    expect(pending.records[0]?.outcome).toBe('running');
  } finally {
    release.resolve();
    await rejected;
  }
});

it('drops a disposed service owner timing callback without resurrecting retained records', async () => {
  const { createTransformersJsService } = await import('./index-hosted');
  const owner = createTransformersJsService({ createWorkerClient: () => {
    throw new Error('No runtime expected');
  } });
  owners.push(owner);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const finished = Promise.withResolvers<void>();
  transfer.reuse.mockResolvedValue({ reused: false });
  transfer.prepare.mockImplementation(async ({ onTiming }: { onTiming: DownloadTimingCallback }) => {
    entered.resolve();
    await release.promise;
    onTiming({ observation: acceptanceTiming });
    finished.resolve();
    return { status: 'accepted' };
  });
  const running = owner.service.downloadModel({ modelId: 'fixture/model' }).catch((error: unknown) => error);
  try {
    await entered.promise;
    await owner.dispose();
    expect(await running).toMatchObject({ reason: 'disposed' });
    release.resolve();
    await finished.promise;
    expect(owner.service.getDownloadTimingSnapshot().records).toEqual([]);
  } finally {
    release.resolve();
    await running;
  }
});
afterEach(async () => {
  await Promise.all(owners.splice(0).map(owner => owner.dispose()));
  expect(fetch).not.toHaveBeenCalled();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('does not let a failing Download progress subscriber prevent cache reuse or change its result', async () => {
  const { createTransformersJsService } = await import('./index-hosted');
  const createWorkerClient = vi.fn<() => TransformersJsWorkerClient>(() => {
    throw new Error('No Production client is needed for this reuse fixture');
  });
  const owner = createTransformersJsService({ createWorkerClient });
  owners.push(owner);
  const healthy = vi.fn();
  owner.service.subscribe({ listener: ({ status }) => {
    if (status === 'loading') throw new Error('Synthetic failed progress renderer');
  } });
  owner.service.subscribe({ listener: healthy });
  owner.service.subscribeModelList({ listener: () => {
    throw new Error('Broken list renderer');
  } });
  const healthyList = vi.fn();
  owner.service.subscribeModelList({ listener: healthyList });
  await expect(owner.service.downloadModel({ modelId: 'fixture/model' })).resolves.toBeUndefined();
  expect(transfer.resolve).toHaveBeenCalledExactlyOnceWith({ modelId: 'fixture/model' });
  expect(transfer.reuse).toHaveBeenCalledExactlyOnceWith({ modelId: 'fixture/model', resolvedRevision: 'a'.repeat(40), onProgress: expect.any(Function), onTiming: expect.any(Function), createAcceptanceClient: expect.any(Function) });
  expect(transfer.prepare).not.toHaveBeenCalled();
  expect(createWorkerClient).not.toHaveBeenCalled();
  expect(owner.service.getState()).toMatchObject({ status: 'idle', loadingModelId: undefined });
  expect(healthy).toHaveBeenCalledWith(expect.objectContaining({ status: 'loading' }));
  expect(healthyList).toHaveBeenCalledOnce();
});

it('does not turn a completed raw cache or metadata read into early Download completion before a transfer plan exists', async () => {
  const { createTransformersJsService } = await import('./index-hosted');
  const owner = createTransformersJsService({ createWorkerClient: () => {
    throw new Error('This scalar progress control must not load weights');
  } });
  owners.push(owner);
  transfer.reuse.mockResolvedValue({ reused: false });
  const observed: Array<ReturnType<typeof owner.service.getState>> = [];
  transfer.prepare.mockImplementationOnce(async ({ progressCallback }: { progressCallback: TransformersJsProgressCallback }) => {
    // Only numbers are supplied, not a buffer or a download. A cache/runtime
    // progress event does not establish the network transfer set or its end.
    progressCallback({ info: { status: 'progress', file: 'onnx/model_q4.onnx', loaded: 2096824320, total: 2096824320, progress: 100 } });
    observed.push(owner.service.getState());
    return { status: 'accepted' };
  });
  await owner.service.downloadModel({ modelId: 'fixture/model' });
  expect(observed).toHaveLength(1);
  expect(observed[0]?.progress).toBeLessThanOrEqual(10);
  expect(observed[0]).toMatchObject({ status: 'loading', totalLoadedAmount: 0, downloadProgress: { phase: 'preparing-metadata', overallProgress: 2, files: [], receivedBytes: 0 } });
  expect(owner.service.getState()).toMatchObject({ status: 'idle', downloadProgress: { phase: 'complete', overallProgress: 100 } });
  expect(transfer.prepare).toHaveBeenCalledOnce();
});

it('shows cached model-session acceptance at 95 without starting size discovery or prefetch', async () => {
  const { createTransformersJsService } = await import('./index-hosted');
  const createWorkerClient = vi.fn<() => TransformersJsWorkerClient>(() => {
    throw new Error('Unexpected runtime');
  });
  const owner = createTransformersJsService({ createWorkerClient }); owners.push(owner);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let reuseProgress: RuntimeAcceptanceProgressCallback | undefined;
  transfer.reuse.mockImplementationOnce(async ({ onProgress }: { onProgress: RuntimeAcceptanceProgressCallback }) => {
    reuseProgress = onProgress; entered.resolve(); await release.promise;
    return { reused: true, loadRevision: 'a'.repeat(40), acceptance: {} };
  });
  const running = owner.service.downloadModel({ modelId: 'fixture/model' });
  await Promise.race([entered.promise, running.then(() => {
    throw new Error('Download settled before acceptance');
  })]);
  try {
    reuseProgress?.({ progress: { phase: 'cache-inventory', revision: 'a'.repeat(40), candidate: undefined, info: undefined } });
    expect(owner.service.getState().downloadProgress?.overallProgress).toBe(1);
    reuseProgress?.({ progress: { phase: 'runtime', revision: 'a'.repeat(40), candidate: { device: 'wasm', dtype: 'q4' }, info: { status: 'cache-acceptance-model-session' } } });
    expect(owner.service.getState()).toMatchObject({ status: 'loading', downloadProgress: { overallProgress: 95, phase: 'checking-runtime', files: [], downloadEta: { status: 'unavailable' } } });
    expect(transfer.prepare).not.toHaveBeenCalled();
    expect(createWorkerClient).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  } finally {
    release.resolve(); await running;
  }
  expect(owner.service.getState().downloadProgress).toMatchObject({ phase: 'complete', overallProgress: 100 });
});

it('ignores a previous Download callback while a new operation owns the service', async () => {
  const { createTransformersJsService } = await import('./index-hosted');
  const owner = createTransformersJsService({ createWorkerClient: () => {
    throw new Error('No runtime expected');
  } });
  owners.push(owner);
  transfer.reuse.mockResolvedValue({ reused: false });
  let previous: DownloadProgressCallback | undefined;
  transfer.prepare.mockImplementationOnce(async ({ onDownloadProgress }: { onDownloadProgress: DownloadProgressCallback }) => {
    previous = onDownloadProgress;
    onDownloadProgress({ event: { kind: 'candidate', candidate: { device: 'wasm', dtype: 'q4' }, index: 0, count: 1 } });
    onDownloadProgress({ event: { kind: 'plan', index: 0, paths: ['old/model.onnx'] } });
    return { status: 'accepted' };
  });
  await owner.service.downloadModel({ modelId: 'fixture/first' });
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  transfer.prepare.mockImplementationOnce(async ({ onDownloadProgress }: { onDownloadProgress: DownloadProgressCallback }) => {
    onDownloadProgress({ event: { kind: 'candidate', candidate: { device: 'wasm', dtype: 'q4' }, index: 0, count: 1 } });
    onDownloadProgress({ event: { kind: 'plan', index: 0, paths: ['new/model.onnx'] } });
    entered.resolve();
    await release.promise;
    return { status: 'accepted' };
  });
  const running = owner.service.downloadModel({ modelId: 'fixture/second' });
  await entered.promise;
  try {
    const before = structuredClone(owner.service.getState());
    previous?.({ event: { kind: 'file', index: 0, info: { status: 'done', file: 'new/model.onnx', loaded: 900, total: 900 } } });
    previous?.({ event: { kind: 'phase', phase: 'failed' } });
    expect(owner.service.getState()).toEqual(before);
    expect(before.downloadProgress?.files).toEqual([{ path: 'new/model.onnx', status: 'queued', loaded: 0, total: undefined, progress: undefined }]);
  } finally {
    release.resolve();
    await running;
  }
});

it('drops the old buffered snapshot when the same listener is unsubscribed and registered again', async () => {
  const { createTransformersJsService } = await import('./index-hosted');
  const owner = createTransformersJsService({ createWorkerClient: () => {
    throw new Error('No runtime expected');
  } });
  owners.push(owner);
  const held = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const listener = vi.fn(({ status }: { status: string }) => status === 'loading' ? held.promise : undefined);
  const unsubscribe = owner.service.subscribe({ listener });
  transfer.resolve.mockImplementationOnce(async () => {
    entered.resolve(); await release.promise; return { resolvedRevision: 'a'.repeat(40) };
  });
  const running = owner.service.downloadModel({ modelId: 'fixture/model' });
  await entered.promise;
  unsubscribe();
  const unsubscribeAgain = owner.service.subscribe({ listener });
  release.resolve();
  await running;
  const before = listener.mock.calls.length;
  held.resolve();
  await vi.waitFor(() => expect(listener).toHaveBeenCalledTimes(before + 1));
  expect(listener.mock.calls.at(-1)?.[0]).toMatchObject({ status: 'idle' });
  unsubscribeAgain();
});

it('publishes stalled ETA from the display timer and retires that timer after Download settles', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  const clock = vi.spyOn(performance, 'now').mockReturnValue(0);
  const { createTransformersJsService } = await import('./index-hosted');
  const owner = createTransformersJsService({ createWorkerClient: () => {
    throw new Error('No runtime expected');
  } }); owners.push(owner);
  // The existing subscriber is an invalidation signal; Manager reads getState.
  const snapshots: ReturnType<typeof owner.service.getState>[] = [];
  const notifications = vi.fn(() => {
    snapshots.push(owner.service.getState());
  }); owner.service.subscribe({ listener: notifications });
  transfer.reuse.mockResolvedValue({ reused: false });
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  transfer.prepare.mockImplementationOnce(async ({ onDownloadProgress }: { onDownloadProgress: DownloadProgressCallback }) => {
    onDownloadProgress({ event: { kind: 'candidate', index: 0, count: 1, candidate: { device: 'wasm', dtype: 'q4' } } });
    onDownloadProgress({ event: { kind: 'plan', index: 0, paths: ['onnx/a'] } });
    onDownloadProgress({ event: { kind: 'sizes', index: 0, sizes: [{ path: 'onnx/a', bytes: 600 }] } });
    onDownloadProgress({ event: { kind: 'file', index: 0, info: { status: 'download', file: 'onnx/a', loaded: 0, downloadCumulativeTiming: { clockId: 'source', sequence: 1, firstFetchStartedAtMs: 20_000, observedAtMs: 20_000, receivedBytes: 0 } } } });
    onDownloadProgress({ event: { kind: 'file', index: 0, info: { status: 'progress', file: 'onnx/a', loaded: 300, downloadCumulativeTiming: { clockId: 'source', sequence: 2, firstFetchStartedAtMs: 20_000, observedAtMs: 23_000, receivedBytes: 300 } } } });
    started.resolve(); await release.promise; return { status: 'accepted' };
  });
  const running = owner.service.downloadModel({ modelId: 'fixture/model' });
  await Promise.race([started.promise, running.then(() => {
    throw new Error('Premature Download completion');
  })]);
  try {
    expect(owner.service.getState().downloadProgress?.downloadEta).toEqual({ status: 'estimating', remainingSeconds: 3, bytesPerSecond: 100 });
    expect(vi.getTimerCount()).toBe(1);
    clock.mockReturnValue(10_000);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(snapshots.at(-1)).toMatchObject({ downloadProgress: { downloadEta: { status: 'stalled' }, overallProgress: 50 } });
  } finally {
    release.resolve(); await running;
  }
  expect(vi.getTimerCount()).toBe(0);
  const completed = owner.service.getState();
  await vi.advanceTimersByTimeAsync(30_000);
  expect(owner.service.getState()).toEqual(completed);
});
