import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as Comlink from 'comlink';
import { createProductionRuntimeStartupFixture, installProductionRuntimeStartupPlatform } from '@/features/transformers-js/runtime/fixtures/production-runtime-startup-fixture';

// Mock Worker class
const workers: MockWorker[] = [];
class MockWorker extends EventTarget {
  static latest: MockWorker;
  private active = true;
  readonly startup = createProductionRuntimeStartupFixture({ emitFromWorker: ({ message }) => this.dispatchEvent(new MessageEvent('message', { data: message })) });
  terminate = vi.fn(() => {
    this.active = false;
  });
  postMessage = vi.fn((message: unknown) => this.startup.acceptHostMessage({ message }));
  static constructorCount = 0;
  constructor() {
    super();
    workers.push(this);
    MockWorker.constructorCount++;
    MockWorker.latest = this;
    queueMicrotask(() => {
      if (this.active) this.startup.start();
    });
  }
}

vi.stubGlobal('Worker', MockWorker);

afterEach(() => {
  for (const worker of workers.splice(0)) worker.dispatchEvent(new Event('error'));
});

// Mock navigator.storage
vi.stubGlobal('navigator', {
  storage: {
    getDirectory: vi.fn().mockResolvedValue({
      getDirectoryHandle: vi.fn().mockResolvedValue({
        getDirectoryHandle: vi.fn().mockRejectedValue(new Error('Not found')),
      }),
    }),
  },
});

// Mock Comlink
vi.mock('comlink', () => {
  const releaseProxy = Symbol('releaseProxy');
  return {
    wrap: vi.fn(_worker => {
      return {
        [releaseProxy]: vi.fn(),
        scanModel: vi.fn().mockResolvedValue({ files: [] }),
        prefetchUrls: vi.fn().mockResolvedValue({
          requestedCount: 0,
          cachedCount: 0,
          downloadedCount: 0,
          failedCount: 0,
          complete: true,
          files: [],
        }),
      };
    }),
    proxy: vi.fn(x => x),
    expose: vi.fn(),
    releaseProxy,
    createEndpoint: Symbol('createEndpoint'),
  };
});

describe('transformersJsService worker restart', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    installProductionRuntimeStartupPlatform({ origin: 'http://localhost' });
    MockWorker.constructorCount = 0;
  });

  it('serializes concurrent explicit restart requests', async () => {
    (Comlink.wrap as any).mockImplementation(() => ({
      [Comlink.releaseProxy]: vi.fn(),
    }));

    const { transformersJsService } = await import('@/features/transformers-js/index');
    expect(MockWorker.constructorCount).toBe(0);

    await Promise.all([
      transformersJsService.restart(),
      transformersJsService.restart(),
      transformersJsService.restart(),
    ]);

    expect(MockWorker.constructorCount).toBe(1);
  });

  it('should recreate worker when loadDownloadedModel fails with Aborted()', async () => {
    // 1. Setup mock remote BEFORE importing service
    const mockRemote = {
      loadDownloadedModel: vi.fn().mockRejectedValue(new Error('RuntimeError: Aborted(). Build with -sASSERTIONS for more info.')),
    };
    (Comlink.wrap as any).mockImplementation(() => {
      return Object.assign(mockRemote, { [Comlink.releaseProxy]: vi.fn() });
    });

    // 2. Import service
    const { transformersJsService } = await import('@/features/transformers-js/index');
    const countAfterImport = MockWorker.constructorCount;

    // 3. Act
    try {
      await transformersJsService.loadDownloadedModel({ modelId: 'some-model' });
    } catch (e) {
      // Expected error
    }

    // 4. Assert
    expect(MockWorker.constructorCount).toBeGreaterThan(countAfterImport);
  });

  it('should recreate worker when loadDownloadedModel fails with WebGPU Kernel error', async () => {
    const mockRemote = {
      loadDownloadedModel: vi.fn().mockRejectedValue(new Error('[WebGPU] Kernel "[Add] /model/layers.0/..." failed. Error: Can\'t perform binary op')),
    };
    (Comlink.wrap as any).mockImplementation(() => {
      return Object.assign(mockRemote, { [Comlink.releaseProxy]: vi.fn() });
    });

    const { transformersJsService } = await import('@/features/transformers-js/index');
    const countBefore = MockWorker.constructorCount;

    try {
      await transformersJsService.loadDownloadedModel({ modelId: 'some-model' });
    } catch (e) { /* Expected */ }

    expect(MockWorker.constructorCount).toBeGreaterThan(countBefore);
  });

  it('should recreate worker when generateText fails with Aborted()', async () => {
    // 1. Setup mock remote
    const mockRemote = {
      loadDownloadedModel: vi.fn().mockResolvedValue({ device: 'webgpu' }),
      generateText: vi.fn().mockRejectedValue(new Error('RuntimeError: Aborted()')),
    };
    (Comlink.wrap as any).mockImplementation(() => {
      return Object.assign(mockRemote, { [Comlink.releaseProxy]: vi.fn() });
    });

    // 2. Import service
    const { transformersJsService } = await import('@/features/transformers-js/index');

    // 3. Initial load success
    await transformersJsService.loadDownloadedModel({ modelId: 'some-model' });
    const countAfterLoad = MockWorker.constructorCount;

    // 4. Act
    try {
      await transformersJsService.generateText({
        messages: [],
        onChunk: () => {},
        onToolCalls: () => {},
      });
    } catch (e) {
      // Expected
    }

    // 5. Assert
    expect(MockWorker.constructorCount).toBeGreaterThan(countAfterLoad);
    expect(transformersJsService.getState().status).toBe('idle');
  });

  it('should recreate worker when generateText fails with WebGPU Kernel error', async () => {
    const mockRemote = {
      loadDownloadedModel: vi.fn().mockResolvedValue({ device: 'webgpu' }),
      generateText: vi.fn().mockRejectedValue(new Error('[WebGPU] Kernel failure during inference')),
    };
    (Comlink.wrap as any).mockImplementation(() => {
      return Object.assign(mockRemote, { [Comlink.releaseProxy]: vi.fn() });
    });

    const { transformersJsService } = await import('@/features/transformers-js/index');
    await transformersJsService.loadDownloadedModel({ modelId: 'some-model' });
    const countAfterLoad = MockWorker.constructorCount;

    try {
      await transformersJsService.generateText({
        messages: [],
        onChunk: () => {},
        onToolCalls: () => {},
      });
    } catch (e) { /* Expected */ }

    expect(MockWorker.constructorCount).toBeGreaterThan(countAfterLoad);
    expect(transformersJsService.getState().status).toBe('idle');
  });

  it('replaces a terminal Load Realm without retrying the model until the next explicit Load', async () => {
    const entered = Promise.withResolvers<void>();
    const load = vi.fn().mockImplementationOnce(() => {
      entered.resolve();
      return new Promise<never>(() => undefined);
    }).mockResolvedValue({ device: 'webgpu' });
    vi.mocked(Comlink.wrap).mockImplementation(() => ({
      loadDownloadedModel: load,
      [Comlink.releaseProxy]: vi.fn(),
      [Comlink.createEndpoint]: vi.fn(),
    }));
    const { transformersJsService } = await import('@/features/transformers-js/index');
    const first = transformersJsService.loadDownloadedModel({ modelId: 'some-model' });
    const rejected = expect(first).rejects.toMatchObject({ name: 'ProductionWorkerLifecycleError', reason: 'worker-error' });
    await entered.promise;
    const oldWorker = MockWorker.latest;
    oldWorker.dispatchEvent(new ErrorEvent('error', { message: 'entry Realm crashed' }));
    await rejected;
    expect(oldWorker.terminate).toHaveBeenCalledOnce();
    expect(MockWorker.constructorCount).toBe(2);
    expect(load).toHaveBeenCalledOnce();

    await transformersJsService.loadDownloadedModel({ modelId: 'some-model' });
    expect(load).toHaveBeenCalledTimes(2);
    expect(MockWorker.constructorCount).toBe(2);
    expect(transformersJsService.getState().status).toBe('ready');
  });

  it('replaces a terminal generation Realm without automatically reloading or generating', async () => {
    const entered = Promise.withResolvers<void>();
    const load = vi.fn().mockResolvedValue({ device: 'webgpu' });
    const generate = vi.fn(() => {
      entered.resolve();
      return new Promise<never>(() => undefined);
    });
    vi.mocked(Comlink.wrap).mockImplementation(() => ({
      loadDownloadedModel: load, generateText: generate,
      [Comlink.releaseProxy]: vi.fn(),
      [Comlink.createEndpoint]: vi.fn(),
    }));
    const { transformersJsService } = await import('@/features/transformers-js/index');
    await transformersJsService.loadDownloadedModel({ modelId: 'some-model' });
    const generated = transformersJsService.generateText({ messages: [], onChunk: vi.fn(), onToolCalls: vi.fn() });
    const rejected = expect(generated).rejects.toMatchObject({ name: 'ProductionWorkerLifecycleError', reason: 'message-error' });
    await entered.promise;
    MockWorker.latest.dispatchEvent(new Event('messageerror'));
    await rejected;
    expect(MockWorker.constructorCount).toBe(2);
    expect(load).toHaveBeenCalledOnce();
    expect(generate).toHaveBeenCalledOnce();
    expect(transformersJsService.getState().status).toBe('idle');
  });
});
