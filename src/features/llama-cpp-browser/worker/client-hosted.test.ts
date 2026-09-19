import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLlamaCppWorkerClient } from './client-hosted';
const transport = vi.hoisted(() => ({ remote: { listModels: vi.fn(), importModel: vi.fn(), removeModel: vi.fn(), generate: vi.fn() }, release: vi.fn() }));
vi.mock('@/utils/worker-transport', () => ({ wrapWorkerRemote: () => transport.remote,
  releaseWorkerRemote: transport.release, workerProxy: ({ value }: { value: unknown }) => value }));
class TestWorker extends EventTarget {
  static instances: TestWorker[] = [];
  terminate = vi.fn();
  constructor() {
    super(); TestWorker.instances.push(this);
  }
}
beforeEach(() => {
  vi.clearAllMocks(); TestWorker.instances = [];
  vi.stubGlobal('Worker', TestWorker);
  transport.remote.listModels.mockResolvedValue([]);
});
afterEach(() => {
  vi.unstubAllGlobals();
});
describe('hosted Worker lifetime', () => {
  it('does not construct a Worker when the platform has no Worker support', async () => {
    vi.stubGlobal('Worker', undefined);
    const client = createLlamaCppWorkerClient();
    await expect(client.listModels({ signal: undefined })).rejects.toThrow('unavailable');
    expect(TestWorker.instances).toHaveLength(0);
    client.dispose();
  });
  it('rejects a pending call immediately when its signal aborts and terminates the Worker once', async () => {
    transport.remote.listModels.mockImplementation(() => new Promise(() => {}));
    const client = createLlamaCppWorkerClient(); const controller = new AbortController();
    const pending = client.listModels({ signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toThrow('aborted');
    expect(TestWorker.instances[0]?.terminate).toHaveBeenCalledOnce();
    expect(transport.release).toHaveBeenCalledOnce();
    client.dispose();
    expect(TestWorker.instances[0]?.terminate).toHaveBeenCalledOnce();
    await expect(client.listModels({ signal: undefined })).rejects.toThrow('worker-failed');
  });
  it('rejects pending work on a Worker error without exposing the native error message', async () => {
    transport.remote.listModels.mockImplementation(() => new Promise(() => {}));
    const client = createLlamaCppWorkerClient(); const pending = client.listModels({ signal: undefined });
    TestWorker.instances[0]?.dispatchEvent(new ErrorEvent('error', { message: 'private prompt and path', cancelable: true }));
    await expect(pending).rejects.toThrow('llama.cpp browser: worker-failed');
    expect(TestWorker.instances[0]?.terminate).toHaveBeenCalledOnce();
  });
  it('rejects overlapping operations instead of sharing unsafe native state', async () => {
    transport.remote.listModels.mockImplementation(() => new Promise(() => {}));
    const client = createLlamaCppWorkerClient(); const first = client.listModels({ signal: undefined });
    await expect(client.listModels({ signal: undefined })).rejects.toThrow('busy');
    client.dispose(); await expect(first).rejects.toThrow('worker-failed');
  });
  it('validates model inventory received from the Worker', async () => {
    transport.remote.listModels.mockResolvedValue([{ id: 'not-a-uuid', name: 'private.gguf', size: 1, importedAt: 0 }]);
    const client = createLlamaCppWorkerClient();
    await expect(client.listModels({ signal: undefined })).rejects.toThrow();
    client.dispose();
  });
});
