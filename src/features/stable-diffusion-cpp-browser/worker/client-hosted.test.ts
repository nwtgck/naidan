import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createImageClient } from './client-hosted';
import { requestFixture as request } from '@/features/stable-diffusion-cpp-browser/test-fixtures';
const mocks = vi.hoisted(() => ({ generate: vi.fn(), release: vi.fn(), terminate: vi.fn(), constructed: vi.fn() }));
vi.mock('@/utils/worker-transport', () => ({ wrapWorkerRemote: () => ({ generate: mocks.generate }), releaseWorkerRemote: () => mocks.release(), workerProxy: ({ value }: { value: unknown }) => value }));
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('Worker', class extends EventTarget {
    constructor() {
      super(); mocks.constructed();
    } terminate() {
      mocks.terminate();
    }
  });
});
afterEach(() => vi.unstubAllGlobals());
it('does not create a worker before explicit generation and ignores pre-aborted requests', async () => {
  const client = createImageClient(); expect(mocks.constructed).not.toHaveBeenCalled();
  const controller = new AbortController(); controller.abort();
  await expect(client.generate({ request: request(), signal: controller.signal, onProgress: vi.fn() })).rejects.toMatchObject({ name: 'AbortError' });
  expect(mocks.constructed).not.toHaveBeenCalled(); client.dispose();
});
it('cancels a permanently suspended native call and terminates its worker', async () => {
  mocks.generate.mockImplementation(() => new Promise(() => undefined));
  const controller = new AbortController(); const client = createImageClient();
  const task = client.generate({ request: request(), signal: controller.signal, onProgress: vi.fn() });
  const settled = expect(task).rejects.toMatchObject({ name: 'AbortError' });
  controller.abort(); await settled;
  expect(mocks.terminate).toHaveBeenCalled(); expect(mocks.release).toHaveBeenCalled();
});
it('disposal rejects a pending request even when the proxy never acknowledges release', async () => {
  mocks.generate.mockImplementation(() => new Promise(() => undefined));
  mocks.release.mockImplementation(() => new Promise(() => undefined));
  const client = createImageClient(); const task = client.generate({ request: request(), signal: new AbortController().signal, onProgress: vi.fn() });
  const settled = expect(task).rejects.toMatchObject({ name: 'AbortError' }); client.dispose(); await settled;
  expect(mocks.terminate).toHaveBeenCalled();
});
it('releases worker after success and rejects malformed responses', async () => {
  const client = createImageClient();
  mocks.generate.mockResolvedValue({ png: new Blob(['fixture'], { type: 'image/png' }), width: 256, height: 256, modelVersion: 'mocked result' });
  const result = await client.generate({ request: request(), signal: new AbortController().signal, onProgress: vi.fn() });
  expect(result.modelVersion).toBe('mocked result'); expect(mocks.terminate).toHaveBeenCalled();
  mocks.generate.mockResolvedValue({ png: 'not a Blob' });
  await expect(client.generate({ request: request(), signal: new AbortController().signal, onProgress: vi.fn() })).rejects.toThrow();
  client.dispose();
});
