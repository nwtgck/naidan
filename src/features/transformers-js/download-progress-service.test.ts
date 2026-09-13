// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { TransformersJsProgressCallback, TransformersJsWorkerClient } from './types';
import type { DownloadProgressCallback } from './download-progress';

const transfer = vi.hoisted(() => ({ resolve: vi.fn(), reuse: vi.fn(), prepare: vi.fn() }));
vi.mock('./download-verification/logic/resolve-public-hugging-face-revision', () => ({ resolvePublicHuggingFaceRevision: transfer.resolve }));
vi.mock('./download-verification/logic/reuse-downloaded-production-revision', () => ({ reuseDownloadedProductionRevision: transfer.reuse }));
vi.mock('./download-verification/logic/run-production-download-preparation', () => ({ runProductionDownloadPreparation: transfer.prepare }));

const owners: Array<{ dispose(): Promise<void> }> = [];
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
afterEach(async () => {
  await Promise.all(owners.splice(0).map(owner => owner.dispose()));
  expect(fetch).not.toHaveBeenCalled();
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
  expect(transfer.reuse).toHaveBeenCalledExactlyOnceWith({ modelId: 'fixture/model', resolvedRevision: 'a'.repeat(40) });
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
  expect(observed[0]).toMatchObject({ status: 'loading', totalLoadedAmount: 0, downloadProgress: { phase: 'preparing-metadata', overallProgress: 5, files: [], receivedBytes: 0 } });
  expect(owner.service.getState()).toMatchObject({ status: 'idle', downloadProgress: { phase: 'complete', overallProgress: 100 } });
  expect(transfer.prepare).toHaveBeenCalledOnce();
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
