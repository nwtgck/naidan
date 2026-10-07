import { toImageGenerationStoreId, toImageGenerationSessionId } from '@/01-models/ids';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createImageGenerationQueryClient } from './client';

const mocks = vi.hoisted(() => ({ query: vi.fn(), release: vi.fn(), workers: [] as EventTarget[], terminate: vi.fn() }));
vi.mock('@/utils/worker-transport', () => ({ wrapWorkerRemote: () => ({ query: mocks.query }), releaseWorkerRemote: () => mocks.release() }));

beforeEach(() => {
  vi.resetAllMocks(); mocks.workers.length = 0;
  vi.stubGlobal('Worker', class extends EventTarget {
    constructor() {
      super(); mocks.workers.push(this);
    }
    terminate() {
      mocks.terminate();
    }
  });
});

afterEach(() => vi.unstubAllGlobals());

const query = { visibility: 'active' as const, text: '', tags: [], match: 'all' as const, runId: undefined, cursor: undefined, limit: 40 };
const request = { store: { storageType: 'opfs' as const, storeId: toImageGenerationStoreId({ raw: 'store-aa' }) }, sessionId: toImageGenerationSessionId({ raw: 'session-aa' }), query };
const page = { runsWithAssets: [], deletedAssetIds: [], pendingDeletions: [], page: { items: [], total: 0, nextCursor: undefined, warnings: [], warningCount: 0 }, runs: { items: [], warnings: [], warningCount: 0 } };

it.each(['error', 'messageerror'])('rejects pending reads on %s and permits retry with a new Worker', async event => {
  const oldRead = Promise.withResolvers<typeof page>();
  mocks.query.mockReturnValueOnce(oldRead.promise).mockResolvedValue(page);
  mocks.release.mockImplementation(() => new Promise(() => undefined));
  const client = createImageGenerationQueryClient();
  expect(mocks.workers).toHaveLength(0);
  const task = client.query(request);
  const rejected = expect(task).rejects.toThrow();
  const worker = mocks.workers[0]!;
  worker.dispatchEvent(new Event(event));
  await rejected;
  expect(mocks.terminate).toHaveBeenCalledTimes(1);
  expect(mocks.release).toHaveBeenCalledTimes(1);
  await expect(client.query(request)).resolves.toEqual(page);
  expect(mocks.workers).toHaveLength(2);
  worker.dispatchEvent(new Event(event));
  expect(mocks.terminate).toHaveBeenCalledTimes(1);
  oldRead.resolve({ ...page, page: { ...page.page, total: 99 } });
  await client.dispose();
  expect(mocks.terminate).toHaveBeenCalledTimes(2);
});

it('settles pending reads and disposal without waiting for a release acknowledgement', async () => {
  mocks.query.mockImplementation(() => new Promise(() => undefined));
  mocks.release.mockImplementation(() => new Promise(() => undefined));
  const client = createImageGenerationQueryClient();
  const first = expect(client.query(request)).rejects.toMatchObject({ name: 'AbortError' });
  const second = expect(client.query(request)).rejects.toMatchObject({ name: 'AbortError' });
  await client.dispose();
  await first; await second;
  expect(mocks.terminate).toHaveBeenCalledTimes(1);
  await expect(client.query(request)).rejects.toThrow('disposed');
  await client.dispose();
  expect(mocks.workers).toHaveLength(1);
  expect(mocks.terminate).toHaveBeenCalledTimes(1);
});

it('allows ordinary read failures to settle without retiring a healthy Worker', async () => {
  mocks.query.mockRejectedValueOnce(new Error('Cannot read history index')).mockResolvedValue(page);
  const client = createImageGenerationQueryClient();
  await expect(client.query(request)).rejects.toThrow('Cannot read history index');
  expect(mocks.terminate).not.toHaveBeenCalled();
  await expect(client.query(request)).resolves.toEqual(page);
  expect(mocks.workers).toHaveLength(1);
  await client.dispose();
});

it('rejects malformed worker output instead of publishing unvalidated records', async () => {
  mocks.query.mockResolvedValueOnce({ page: { items: [] } });
  const client = createImageGenerationQueryClient();
  await expect(client.query(request)).rejects.toThrow();
  await client.dispose();
});
