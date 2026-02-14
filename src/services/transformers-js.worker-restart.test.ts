import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as Comlink from 'comlink';

// Mock Worker class
class MockWorker {
  terminate = vi.fn();
  postMessage = vi.fn();
  addEventListener = vi.fn();
  removeEventListener = vi.fn();
  static constructorCount = 0;
  constructor() {
    MockWorker.constructorCount++;
  }
}

vi.stubGlobal('Worker', MockWorker);

// Mock navigator.storage
vi.stubGlobal('navigator', {
  storage: {
    getDirectory: vi.fn().mockResolvedValue({
      getDirectoryHandle: vi.fn().mockResolvedValue({
        getDirectoryHandle: vi.fn().mockRejectedValue(new Error('Not found'))
      })
    })
  }
});

// Mock Comlink
vi.mock('comlink', () => ({
  wrap: vi.fn(),
  proxy: vi.fn(x => x),
  expose: vi.fn(),
}));

describe('transformersJsService worker restart', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    MockWorker.constructorCount = 0;
  });

  it('should recreate worker when loadModel fails with Aborted()', async () => {
    // 1. Setup mock remote BEFORE importing service
    const mockRemote = {
      loadModel: vi.fn().mockRejectedValue(new Error('RuntimeError: Aborted(). Build with -sASSERTIONS for more info.')),
    };
    (Comlink.wrap as any).mockReturnValue(mockRemote);

    // 2. Import service
    const { transformersJsService } = await import('./transformers-js');
    const countAfterImport = MockWorker.constructorCount;

    // 3. Act
    try {
      await transformersJsService.loadModel('some-model');
    } catch (e) {
      // Expected error
    }

    // 4. Assert
    expect(MockWorker.constructorCount).toBeGreaterThan(countAfterImport);
  });

  it('should recreate worker when loadModel fails with WebGPU Kernel error', async () => {
    const mockRemote = {
      loadModel: vi.fn().mockRejectedValue(new Error('[WebGPU] Kernel "[Add] /model/layers.0/..." failed. Error: Can\'t perform binary op')),
    };
    (Comlink.wrap as any).mockReturnValue(mockRemote);

    const { transformersJsService } = await import('./transformers-js');
    const countBefore = MockWorker.constructorCount;

    try {
      await transformersJsService.loadModel('some-model');
    } catch (e) { /* Expected */ }

    expect(MockWorker.constructorCount).toBeGreaterThan(countBefore);
  });

  it('should recreate worker when generateText fails with Aborted()', async () => {
    // 1. Setup mock remote
    const mockRemote = {
      loadModel: vi.fn().mockResolvedValue({ device: 'webgpu' }),
      generateText: vi.fn().mockRejectedValue(new Error('RuntimeError: Aborted()')),
    };
    (Comlink.wrap as any).mockReturnValue(mockRemote);

    // 2. Import service
    const { transformersJsService } = await import('./transformers-js');

    // 3. Initial load success
    await transformersJsService.loadModel('some-model');
    const countAfterLoad = MockWorker.constructorCount;

    // 4. Act
    try {
      await transformersJsService.generateText([], () => {});
    } catch (e) {
      // Expected
    }

    // 5. Assert
    expect(MockWorker.constructorCount).toBeGreaterThan(countAfterLoad);
    expect(transformersJsService.getState().status).toBe('idle');
  });

  it('should recreate worker when generateText fails with WebGPU Kernel error', async () => {
    const mockRemote = {
      loadModel: vi.fn().mockResolvedValue({ device: 'webgpu' }),
      generateText: vi.fn().mockRejectedValue(new Error('[WebGPU] Kernel failure during inference')),
    };
    (Comlink.wrap as any).mockReturnValue(mockRemote);

    const { transformersJsService } = await import('./transformers-js');
    await transformersJsService.loadModel('some-model');
    const countAfterLoad = MockWorker.constructorCount;

    try {
      await transformersJsService.generateText([], () => {});
    } catch (e) { /* Expected */ }

    expect(MockWorker.constructorCount).toBeGreaterThan(countAfterLoad);
    expect(transformersJsService.getState().status).toBe('idle');
  });
});
