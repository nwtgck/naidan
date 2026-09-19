// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createFreshMetadataWorkerClient } from './client-hosted';
import { FRESH_METADATA_TIMEOUT_MS, type FreshMetadataResult, type FreshMetadataSummary, type FreshMetadataWorker } from './types';

const fixture = vi.hoisted(() => ({ run: vi.fn<FreshMetadataWorker['run']>(), terminate: vi.fn(), release: vi.fn() }));
vi.mock('@/utils/worker-transport', () => ({
  wrapWorkerRemote: () => ({ run: fixture.run }),
  releaseWorkerRemote: fixture.release,
  workerProxy: ({ value }: { value: unknown }) => value,
}));
const modelId = 'fixture/public-model';
const revision = 'a'.repeat(40);
const initial: FreshMetadataSummary = { schemaVersion: 1, modelId, revision, maximumBytes: 8, receivedBytes: 0, source: 'fresh-network-memory', status: 'running', requests: [] };

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('Worker', class {
    terminate = fixture.terminate;
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it('physically terminates a stuck Worker at the deadline and retains the last HTTP observation', async () => {
  vi.useFakeTimers();
  const held = Promise.withResolvers<FreshMetadataResult>();
  let publish: Parameters<FreshMetadataWorker['run']>[1] | undefined;
  fixture.run.mockImplementation((_input, callback) => {
    publish = callback;
    callback({ summary: { ...initial, receivedBytes: 1, requests: [{ consumer: 'runtime-preparation', path: 'config.json', request: 'full', status: 'reading', httpStatus: 200, receivedBytes: 1 }] } });
    return held.promise;
  });
  const observer = vi.fn();
  const client = createFreshMetadataWorkerClient();
  const pending = client.run({ modelId, revision, maximumBytes: 8, repositoryFiles: [], signal: new AbortController().signal, onObservation: observer });
  await vi.advanceTimersByTimeAsync(FRESH_METADATA_TIMEOUT_MS);
  const result = await pending;
  expect(result.summary.status).toBe('timeout');
  expect(result.summary.requests[0]?.path).toBe('config.json');
  expect(fixture.terminate).toHaveBeenCalledOnce();
  publish!({ summary: { ...initial, status: 'prepared' } });
  held.resolve({ summary: { ...initial, status: 'prepared' }, files: [] });
  await Promise.resolve();
  expect(observer).toHaveBeenCalledOnce();
  client.dispose();
  expect(fixture.terminate).toHaveBeenCalledOnce();
});

it('does not start remote work when already interrupted', async () => {
  const abort = new AbortController();
  const error = new Error('fixture user interruption');
  abort.abort(error);
  const client = createFreshMetadataWorkerClient();
  await expect(client.run({ modelId, revision, maximumBytes: 8, repositoryFiles: [], signal: abort.signal, onObservation: () => undefined })).rejects.toBe(error);
  expect(fixture.run).not.toHaveBeenCalled();
  expect(fixture.terminate).toHaveBeenCalledOnce();
});

it('rejects mismatched observation identity without waiting for a stuck remote return', async () => {
  fixture.run.mockImplementation((_input, callback) => {
    callback({ summary: { ...initial, revision: 'b'.repeat(40) } });
    return new Promise(() => undefined);
  });
  const client = createFreshMetadataWorkerClient();
  const result = await client.run({ modelId, revision, maximumBytes: 8, repositoryFiles: [], signal: new AbortController().signal, onObservation: () => undefined });
  expect(result.summary.status).toBe('failed');
  expect(result.summary.revision).toBe(revision);
  expect(fixture.terminate).toHaveBeenCalledOnce();
});
