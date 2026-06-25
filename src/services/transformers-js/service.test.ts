/* eslint-disable no-restricted-imports -- Service test verifies transformers.js model registry support directly. */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EMPTY_LM_PARAMETERS } from '@/models/types';
import * as Comlink from 'comlink';
import { isProxy, reactive } from 'vue';
import { AutoModelForCausalLM } from '@huggingface/transformers';

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
vi.mock('comlink', () => {
  const releaseProxy = Symbol('releaseProxy');
  return {
    wrap: vi.fn(_worker => {
      const proxy = {
        [releaseProxy]: vi.fn(),
      };
      return proxy;
    }),
    proxy: vi.fn(x => x),
    expose: vi.fn(),
    releaseProxy,
  };
});

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
    }),
  };
  return dir;
}

function createMockFile(size: number, lastModified: number) {
  return {
    kind: 'file',
    getFile: vi.fn().mockResolvedValue({
      size,
      lastModified,
    }),
    createWritable: vi.fn().mockResolvedValue({
      write: vi.fn(),
      close: vi.fn(),
    }),
  };
}

describe('transformersJsService', () => {
  it('should support qwen3_5 causal LM models', () => {
    expect((AutoModelForCausalLM as any).supports('qwen3_5')).toBe(true);
  });

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();

    // Default navigator mock
    vi.stubGlobal('navigator', {
      storage: {
        getDirectory: vi.fn().mockRejectedValue(new Error('No storage')),
      },
    });
  });

  it('should return empty list when no models directory exists', async () => {
    const { transformersJsService } = await import('./index');
    const models = await transformersJsService.listCachedModels();
    expect(models).toEqual([]);
  });

  it('should list cached models from OPFS', async () => {
    const mockHuggingFaceDir = createMockDir({
      'onnx-community': createMockDir({
        'phi-3': createMockDir({
          'model.onnx': createMockFile(1000, 123456789),
          '.model.onnx.complete': createMockFile(0, 123456789),
        }),
      }),
    });

    const mockUserDir = createMockDir({
      'my-custom-model': createMockDir({
        'weights.onnx': createMockFile(2000, 987654321),
        '.weights.onnx.complete': createMockFile(0, 987654321),
      }),
    });

    const mockModelsDir = createMockDir({
      'huggingface.co': mockHuggingFaceDir,
      'user': mockUserDir,
    });

    vi.stubGlobal('navigator', {
      storage: {
        getDirectory: vi.fn().mockResolvedValue(createMockDir({
          'models': mockModelsDir,
        })),
      },
    });

    const { transformersJsService } = await import('./index');
    const models = await transformersJsService.listCachedModels();

    expect(models).toContainEqual(expect.objectContaining({
      id: 'hf.co/onnx-community/phi-3',
      isLocal: false,
      size: 1000,
      isComplete: true,
    }));
    expect(models).toContainEqual(expect.objectContaining({
      id: 'user/my-custom-model',
      isLocal: true,
      size: 2000,
      isComplete: true,
    }));
  });

  it('should include models even without completion marker but as incomplete', async () => {
    const mockLocalDir = createMockDir({
      'incomplete-model': createMockDir({
        'weights.onnx': createMockFile(2000, 987654321),
        // missing .weights.onnx.complete
      }),
    });

    vi.stubGlobal('navigator', {
      storage: {
        getDirectory: vi.fn().mockResolvedValue(createMockDir({
          'models': createMockDir({
            'local': mockLocalDir,
          }),
        })),
      },
    });

    const { transformersJsService } = await import('./index');
    const models = await transformersJsService.listCachedModels();
    expect(models).toContainEqual(expect.objectContaining({
      id: 'user/incomplete-model',
      isComplete: false,
    }));
  });

  it('should transition state correctly during loadModel', async () => {
    const mockRemote = {
      loadModel: vi.fn().mockImplementation(async (_id, cb) => {
        cb({ status: 'progress', progress: 50 });
        return { device: 'webgpu' };
      }),
      prefetchUrls: vi.fn().mockResolvedValue(undefined),
    };
    (Comlink.wrap as any).mockImplementation((_worker: any) => {
      // Return a mock object that supports both engine and scanner worker interfaces
      return Object.assign(mockRemote, {
        [Comlink.releaseProxy]: vi.fn(),
        scanModel: vi.fn().mockResolvedValue({
          files: [{ url: 'https://hf.co/m/model.onnx' }],
        }),
      });
    });

    const { transformersJsService } = await import('./index');

    // Subscribe to track status changes
    const statuses: string[] = [];
    transformersJsService.subscribe({ listener: ({ status }) => {
      statuses.push(status);
    } });

    await transformersJsService.loadModel({ modelId: 'some-model' });

    expect(mockRemote.loadModel).toHaveBeenCalledWith('some-model', expect.any(Function));
    expect(mockRemote.prefetchUrls).toHaveBeenCalledWith(['https://hf.co/m/model.onnx'], expect.any(Function));
    expect(transformersJsService.getState().status).toBe('ready');
    expect(transformersJsService.getState().device).toBe('webgpu');
    expect(statuses).toContain('loading');
    expect(statuses).toContain('ready');
  });

  it('should include a processor scan task for Gemma 4 models', async () => {
    const mockRemote = {
      loadModel: vi.fn().mockResolvedValue({ device: 'webgpu' }),
      prefetchUrls: vi.fn().mockResolvedValue(undefined),
    };
    const scanModel = vi.fn().mockResolvedValue({
      files: [
        { url: 'https://hf.co/m/processor_config.json' },
        { url: 'https://hf.co/m/model.onnx' },
      ],
    });
    (Comlink.wrap as any).mockImplementation((_worker: any) => {
      return Object.assign(mockRemote, {
        [Comlink.releaseProxy]: vi.fn(),
        scanModel,
      });
    });

    const { transformersJsService } = await import('./index');
    await transformersJsService.loadModel({ modelId: 'hf.co/onnx-community/gemma-4-E2B-it-ONNX' });

    expect(scanModel).toHaveBeenCalledWith({
      tasks: [
        { type: 'tokenizer', modelId: 'onnx-community/gemma-4-E2B-it-ONNX', options: {} },
        { type: 'processor', modelId: 'onnx-community/gemma-4-E2B-it-ONNX', options: {} },
        { type: 'image-text-to-text', modelId: 'onnx-community/gemma-4-E2B-it-ONNX', options: { dtype: 'q4f16', device: 'wasm' } },
      ],
    });
  });

  it('should fail downloadModel when pre-download discovers no files', async () => {
    const mockRemote = {
      loadModel: vi.fn().mockResolvedValue({ device: 'webgpu' }),
      prefetchUrls: vi.fn().mockResolvedValue(undefined),
      downloadModel: vi.fn().mockResolvedValue(undefined),
    };
    const scanModel = vi.fn().mockResolvedValue({
      files: [],
    });
    (Comlink.wrap as any).mockImplementation((_worker: any) => {
      return Object.assign(mockRemote, {
        [Comlink.releaseProxy]: vi.fn(),
        scanModel,
      });
    });

    const { transformersJsService } = await import('./index');

    await expect(transformersJsService.downloadModel({ modelId: 'onnx-community/gemma-4-E2B-it-ONNX' }))
      .rejects
      .toThrow('Pre-download did not discover any model files');

    expect(mockRemote.downloadModel).not.toHaveBeenCalled();
  });

  it('should skip scanner/prefetch when loading a fully cached model', async () => {
    const mockHuggingFaceDir = createMockDir({
      'some-org': createMockDir({
        'some-model': createMockDir({
          'model.onnx': createMockFile(1000, 123456789),
          '.model.onnx.complete': createMockFile(0, 123456789),
        }),
      }),
    });

    vi.stubGlobal('navigator', {
      storage: {
        getDirectory: vi.fn().mockResolvedValue(createMockDir({
          'models': createMockDir({
            'huggingface.co': mockHuggingFaceDir,
          }),
        })),
      },
    });

    const mockRemote = {
      loadModel: vi.fn().mockResolvedValue({ device: 'webgpu' }),
      prefetchUrls: vi.fn().mockResolvedValue(undefined),
    };
    const scanModel = vi.fn().mockResolvedValue({
      files: [{ url: 'https://hf.co/m/model.onnx' }],
    });

    (Comlink.wrap as any).mockImplementation((_worker: any) => {
      return Object.assign(mockRemote, {
        [Comlink.releaseProxy]: vi.fn(),
        scanModel,
      });
    });

    const { transformersJsService } = await import('./index');
    await transformersJsService.loadModel({ modelId: 'hf.co/some-org/some-model' });

    expect(mockRemote.loadModel).toHaveBeenCalledWith('hf.co/some-org/some-model', expect.any(Function));
    expect(scanModel).not.toHaveBeenCalled();
    expect(mockRemote.prefetchUrls).not.toHaveBeenCalled();
  });

  it('should prevent concurrent loading', async () => {
    const mockRemote = {
      loadModel: vi.fn().mockImplementation(() => new Promise(resolve => {
        setTimeout(() => resolve({ device: 'wasm' }), 100);
      })),
    };
    (Comlink.wrap as any).mockImplementation(() => {
      return Object.assign(mockRemote, { [Comlink.releaseProxy]: vi.fn() });
    });

    const { transformersJsService } = await import('./index');

    // Start first load
    const firstLoad = transformersJsService.loadModel({ modelId: 'model-1' });

    // Wait for the status to become 'loading'
    // In our implementation, it becomes 'loading' after listCachedModels()
    // We give it a tiny bit of time
    await new Promise(resolve => setTimeout(resolve, 0));

    // Attempt second load immediately
    await expect(transformersJsService.loadModel({ modelId: 'model-2' })).rejects.toThrow('Another model is currently loading');

    await firstLoad;
  });

  it('should call interrupt when AbortSignal is triggered during generation', async () => {
    const mockRemote = {
      loadModel: vi.fn().mockResolvedValue({ device: 'wasm' }),
      generateText: vi.fn().mockResolvedValue(undefined),
      interrupt: vi.fn().mockResolvedValue(undefined),
    };
    (Comlink.wrap as any).mockImplementation(() => {
      return Object.assign(mockRemote, { [Comlink.releaseProxy]: vi.fn() });
    });

    const { transformersJsService } = await import('./index');
    await transformersJsService.loadModel({ modelId: 'some-model' });

    const controller = new AbortController();
    const genPromise = transformersJsService.generateText({
      messages: [],
      onChunk: () => {},
      onToolCalls: () => {},
      params: EMPTY_LM_PARAMETERS,
      tools: undefined,
      signal: controller.signal,
    });

    controller.abort();
    await genPromise;

    expect(mockRemote.interrupt).toHaveBeenCalled();
  });

  it('should clone lmParameters before sending them to the worker', async () => {
    const mockRemote = {
      loadModel: vi.fn().mockResolvedValue({ device: 'wasm' }),
      generateText: vi.fn().mockResolvedValue(undefined),
    };
    (Comlink.wrap as any).mockImplementation(() => {
      return Object.assign(mockRemote, { [Comlink.releaseProxy]: vi.fn() });
    });

    const { transformersJsService } = await import('./index');
    await transformersJsService.loadModel({ modelId: 'some-model' });

    const reactiveParams = reactive({
      ...EMPTY_LM_PARAMETERS,
      stop: ['END'],
      reasoning: { effort: 'high' as const },
    });

    await transformersJsService.generateText({
      messages: [],
      onChunk: () => {},
      onToolCalls: () => {},
      params: reactiveParams,
      tools: undefined,
      signal: undefined,
    });

    const workerParams = mockRemote.generateText.mock.calls[0]?.[3];
    expect(workerParams).toEqual({
      ...EMPTY_LM_PARAMETERS,
      stop: ['END'],
      reasoning: { effort: 'high' },
    });
    expect(workerParams).not.toBe(reactiveParams);
    expect(isProxy(workerParams)).toBe(false);
    expect(isProxy(workerParams.reasoning)).toBe(false);
    expect(workerParams.stop).not.toBe(reactiveParams.stop);
  });

  it('should clone messages and tools before sending them to the worker', async () => {
    const mockRemote = {
      loadModel: vi.fn().mockResolvedValue({ device: 'wasm' }),
      generateText: vi.fn().mockResolvedValue(undefined),
    };
    (Comlink.wrap as any).mockImplementation(() => {
      return Object.assign(mockRemote, { [Comlink.releaseProxy]: vi.fn() });
    });

    const { transformersJsService } = await import('./index');
    await transformersJsService.loadModel({ modelId: 'some-model' });

    const reactiveMessages = reactive([{
      role: 'assistant',
      content: 'tool call',
      tool_calls: reactive([{
        id: 'call_1',
        type: 'function' as const,
        function: {
          name: 'my_tool',
          arguments: '{"input":"hello"}',
        },
      }]),
    }]);
    const reactiveTools = reactive([{
      type: 'function' as const,
      function: {
        name: 'my_tool',
        description: 'test tool',
        parameters: reactive({
          type: 'object',
          properties: {
            input: { type: 'string' },
          },
        }),
      },
    }]);

    await transformersJsService.generateText({
      messages: reactiveMessages as any,
      onChunk: () => {},
      onToolCalls: () => {},
      params: undefined,
      tools: reactiveTools as any,
      signal: undefined,
    });

    const workerMessages = mockRemote.generateText.mock.calls[0]?.[0];
    const workerTools = mockRemote.generateText.mock.calls[0]?.[4];

    expect(workerMessages).toEqual([{
      role: 'assistant',
      content: 'tool call',
      tool_calls: [{
        id: 'call_1',
        type: 'function',
        function: {
          name: 'my_tool',
          arguments: '{"input":"hello"}',
        },
      }],
      tool_call_id: undefined,
    }]);
    expect(isProxy(workerMessages)).toBe(false);
    expect(isProxy(workerMessages[0])).toBe(false);
    expect(isProxy(workerMessages[0].tool_calls)).toBe(false);
    expect(isProxy(workerMessages[0].tool_calls?.[0])).toBe(false);

    expect(workerTools).toEqual([{
      type: 'function',
      function: {
        name: 'my_tool',
        description: 'test tool',
        parameters: {
          type: 'object',
          properties: {
            input: { type: 'string' },
          },
        },
      },
    }]);
    expect(isProxy(workerTools)).toBe(false);
    expect(isProxy(workerTools[0])).toBe(false);
    expect(isProxy(workerTools[0].function.parameters)).toBe(false);
  });

  it('should create correct directory structure during importFile', async () => {
    const mockRoot = createMockDir();

    vi.stubGlobal('navigator', {
      storage: {
        getDirectory: vi.fn().mockResolvedValue(mockRoot),
      },
    });

    const { transformersJsService } = await import('./index');
    const data = new ArrayBuffer(10);

    await transformersJsService.importFile({ modelName: 'my-model', fileName: 'onnx/model.onnx', data });

    // Verify directory structure was created through the root mock
    const models = await mockRoot.getDirectoryHandle('models');
    const user = await models.getDirectoryHandle('user');
    const model = await user.getDirectoryHandle('my-model');
    const onnx = await model.getDirectoryHandle('onnx');

    expect(onnx.getFileHandle).toHaveBeenCalledWith('model.onnx', { create: true });
  });

  it('should handle loadModel errors', async () => {
    const mockRemote = {
      loadModel: vi.fn().mockRejectedValue(new Error('Failed to load')),
    };
    (Comlink.wrap as any).mockImplementation(() => {
      return Object.assign(mockRemote, { [Comlink.releaseProxy]: vi.fn() });
    });

    const { transformersJsService } = await import('./index');

    await expect(transformersJsService.loadModel({ modelId: 'bad-model' })).rejects.toThrow('Failed to load');
    expect(transformersJsService.getState().status).toBe('error');
    expect(transformersJsService.getState().error).toBe('Failed to load');
  });
});
