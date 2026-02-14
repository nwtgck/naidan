import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as Comlink from 'comlink';

// Mock Worker class
class MockWorker {
  terminate = vi.fn();
  postMessage = vi.fn();
  addEventListener = vi.fn();
  removeEventListener = vi.fn();
  constructor() {}
}

vi.stubGlobal('Worker', MockWorker);

// Mock Comlink
vi.mock('comlink', () => ({
  wrap: vi.fn(),
  proxy: vi.fn(x => x),
  expose: vi.fn(),
}));

// Helper to create a mock FileSystemDirectoryHandle
function createMockDir(entries: Record<string, any> = {}) {
  const dir = {
    kind: 'directory',
    getDirectoryHandle: vi.fn(async (name: string, options?: { create?: boolean }) => {
      if (entries[name] && entries[name].kind === 'directory') return entries[name];
      if (options?.create) {
        const newDir = createMockDir();
        entries[name] = newDir;
        return newDir;
      }
      throw new Error('Not found');
    }),
    getFileHandle: vi.fn(async (name: string, options?: { create?: boolean }) => {
      if (entries[name] && entries[name].kind === 'file') return entries[name];
      if (options?.create) {
        const newFile = createMockFile(0, Date.now());
        entries[name] = newFile;
        return newFile;
      }
      throw new Error('Not found');
    }),
    entries: vi.fn(async function* () {
      for (const [name, handle] of Object.entries(entries)) {
        yield [name, handle];
      }
    })
  };
  return dir;
}

function createMockFile(size: number, lastModified: number) {
  return {
    kind: 'file',
    getFile: vi.fn().mockResolvedValue({
      size,
      lastModified
    }),
    createWritable: vi.fn().mockResolvedValue({
      write: vi.fn(),
      close: vi.fn()
    })
  };
}

describe('transformersJsService', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();

    // Default navigator mock
    vi.stubGlobal('navigator', {
      storage: {
        getDirectory: vi.fn().mockRejectedValue(new Error('No storage'))
      }
    });
  });

  it('should return empty list when no models directory exists', async () => {
    const { transformersJsService } = await import('./transformers-js');
    const models = await transformersJsService.listCachedModels();
    expect(models).toEqual([]);
  });

  it('should list cached models from OPFS', async () => {
    const mockHuggingFaceDir = createMockDir({
      'onnx-community': createMockDir({
        'phi-3': createMockDir({
          'model.onnx': createMockFile(1000, 123456789),
          '.model.onnx.complete': createMockFile(0, 123456789)
        })
      })
    });

    const mockUserDir = createMockDir({
      'my-custom-model': createMockDir({
        'weights.onnx': createMockFile(2000, 987654321),
        '.weights.onnx.complete': createMockFile(0, 987654321)
      })
    });

    const mockModelsDir = createMockDir({
      'huggingface.co': mockHuggingFaceDir,
      'user': mockUserDir
    });

    vi.stubGlobal('navigator', {
      storage: {
        getDirectory: vi.fn().mockResolvedValue(createMockDir({
          'models': mockModelsDir
        }))
      }
    });

    const { transformersJsService } = await import('./transformers-js');
    const models = await transformersJsService.listCachedModels();

    expect(models).toContainEqual(expect.objectContaining({
      id: 'hf.co/onnx-community/phi-3',
      isLocal: false,
      size: 1000,
      isComplete: true
    }));
    expect(models).toContainEqual(expect.objectContaining({
      id: 'user/my-custom-model',
      isLocal: true,
      size: 2000,
      isComplete: true
    }));
  });

  it('should include models even without completion marker but as incomplete', async () => {
    const mockLocalDir = createMockDir({
      'incomplete-model': createMockDir({
        'weights.onnx': createMockFile(2000, 987654321)
        // missing .weights.onnx.complete
      })
    });

    vi.stubGlobal('navigator', {
      storage: {
        getDirectory: vi.fn().mockResolvedValue(createMockDir({
          'models': createMockDir({
            'local': mockLocalDir
          })
        }))
      }
    });

    const { transformersJsService } = await import('./transformers-js');
    const models = await transformersJsService.listCachedModels();
    expect(models).toContainEqual(expect.objectContaining({
      id: 'user/incomplete-model',
      isComplete: false
    }));
  });

  it('should transition state correctly during loadModel', async () => {
    const mockRemote = {
      loadModel: vi.fn().mockImplementation(async (_id, cb) => {
        cb({ status: 'progress', progress: 50 });
        return { device: 'webgpu' };
      })
    };
    (Comlink.wrap as any).mockReturnValue(mockRemote);

    const { transformersJsService } = await import('./transformers-js');

    // Subscribe to track status changes
    const statuses: string[] = [];
    transformersJsService.subscribe((status) => {
      statuses.push(status);
    });

    await transformersJsService.loadModel('some-model');

    expect(mockRemote.loadModel).toHaveBeenCalledWith('some-model', expect.any(Function));
    expect(transformersJsService.getState().status).toBe('ready');
    expect(transformersJsService.getState().device).toBe('webgpu');
    expect(statuses).toContain('loading');
    expect(statuses).toContain('ready');
  });

  it('should prevent concurrent loading', async () => {
    const mockRemote = {
      loadModel: vi.fn().mockImplementation(() => new Promise(resolve => {
        setTimeout(() => resolve({ device: 'wasm' }), 100);
      }))
    };
    (Comlink.wrap as any).mockReturnValue(mockRemote);

    const { transformersJsService } = await import('./transformers-js');

    // Start first load
    const firstLoad = transformersJsService.loadModel('model-1');

    // Wait for the status to become 'loading'
    // In our implementation, it becomes 'loading' after listCachedModels()
    // We give it a tiny bit of time
    await new Promise(resolve => setTimeout(resolve, 0));

    // Attempt second load immediately
    await expect(transformersJsService.loadModel('model-2')).rejects.toThrow('Another model is currently loading');

    await firstLoad;
  });

  it('should call interrupt when AbortSignal is triggered during generation', async () => {
    const mockRemote = {
      loadModel: vi.fn().mockResolvedValue({ device: 'wasm' }),
      generateText: vi.fn().mockResolvedValue(undefined),
      interrupt: vi.fn().mockResolvedValue(undefined)
    };
    (Comlink.wrap as any).mockReturnValue(mockRemote);

    const { transformersJsService } = await import('./transformers-js');
    await transformersJsService.loadModel('some-model');

    const controller = new AbortController();
    const genPromise = transformersJsService.generateText([], () => {}, {}, controller.signal);

    controller.abort();
    await genPromise;

    expect(mockRemote.interrupt).toHaveBeenCalled();
  });

  it('should create correct directory structure during importFile', async () => {
    const mockRoot = createMockDir();

    vi.stubGlobal('navigator', {
      storage: {
        getDirectory: vi.fn().mockResolvedValue(mockRoot)
      }
    });

    const { transformersJsService } = await import('./transformers-js');
    const data = new ArrayBuffer(10);

    await transformersJsService.importFile('my-model', 'onnx/model.onnx', data);

    // Verify directory structure was created through the root mock
    const models = await mockRoot.getDirectoryHandle('models');
    const user = await models.getDirectoryHandle('user');
    const model = await user.getDirectoryHandle('my-model');
    const onnx = await model.getDirectoryHandle('onnx');

    expect(onnx.getFileHandle).toHaveBeenCalledWith('model.onnx', { create: true });
  });

  it('should handle loadModel errors', async () => {
    const mockRemote = {
      loadModel: vi.fn().mockRejectedValue(new Error('Failed to load'))
    };
    (Comlink.wrap as any).mockReturnValue(mockRemote);

    const { transformersJsService } = await import('./transformers-js');

    await expect(transformersJsService.loadModel('bad-model')).rejects.toThrow('Failed to load');
    expect(transformersJsService.getState().status).toBe('error');
    expect(transformersJsService.getState().error).toBe('Failed to load');
  });
});