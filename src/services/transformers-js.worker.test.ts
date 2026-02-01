import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock @huggingface/transformers
vi.mock('@huggingface/transformers', () => ({
  AutoTokenizer: {
    from_pretrained: vi.fn(),
  },
  AutoModelForCausalLM: {
    from_pretrained: vi.fn(),
  },
  TextStreamer: vi.fn(),
  InterruptableStoppingCriteria: class {
    reset = vi.fn();
    interrupt = vi.fn();
  },
  StoppingCriteriaList: class extends Array {},
  env: {
    backends: {
      onnx: {
        wasm: {},
        logLevel: 'error'
      }
    },
    allowLocalModels: false,
    allowRemoteModels: true,
    useBrowserCache: false,
    useCustomCache: false,
    customCache: null
  }
}));

// Mock Comlink
vi.mock('comlink', () => ({
  expose: vi.fn(),
  proxy: vi.fn(x => x),
}));

// Mock Worker globals
vi.stubGlobal('self', {
  location: {
    origin: 'http://localhost:3000'
  }
});

// Helper to create a mock FileSystemDirectoryHandle
function createMockDir(entries: Record<string, any> = {}) {
  const dir = {
    kind: 'directory',
    getDirectoryHandle: vi.fn(async (name: string, options?: { create?: boolean }) => {
      if (entries[name]) return entries[name];
      if (options?.create) {
        entries[name] = createMockDir();
        return entries[name];
      }
      throw new Error('Not found');
    }),
    getFileHandle: vi.fn(async (name: string, options?: { create?: boolean }) => {
      if (entries[name]) return entries[name];
      if (options?.create) {
        entries[name] = createMockFile(0);
        return entries[name];
      }
      throw new Error('Not found');
    }),
    removeEntry: vi.fn(async (name: string) => {
      delete entries[name];
    })
  };
  return dir;
}

function createMockFile(size: number) {
  const file = {
    kind: 'file',
    size,
    getFile: vi.fn().mockResolvedValue({
      size,
      stream: vi.fn().mockReturnValue(new ReadableStream())
    }),
    createWritable: vi.fn().mockResolvedValue({
      write: vi.fn(),
      close: vi.fn()
    })
  };
  return file;
}

describe('transformers-js.worker', () => {
  let mockRoot: any;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    
    mockRoot = createMockDir();
    vi.stubGlobal('navigator', {
      storage: {
        getDirectory: vi.fn().mockResolvedValue(mockRoot)
      },
      hardwareConcurrency: 4
    });
  });

  it('should initialize with custom OPFS cache', async () => {
    const { env } = await import('@huggingface/transformers');
    await import('./transformers-js.worker');
    
    expect(env.useCustomCache).toBe(true);
    expect(env.customCache).toBeDefined();
    expect(env.customCache).toHaveProperty('match');
    expect(env.customCache).toHaveProperty('put');
  });

  it('opfsCache.match should return undefined for non-existent file', async () => {
    await import('./transformers-js.worker');
    const { env } = await import('@huggingface/transformers');
    const cache = (env as any).customCache;

    const response = await cache.match('https://huggingface.co/org/repo/model.onnx');
    expect(response).toBeUndefined();
  });

  it('opfsCache.match should return Response when file exists and is complete', async () => {
    // Setup existing complete file in mock OPFS
    mockRoot.getDirectoryHandle.mockImplementation(async (name: string) => {
      if (name === 'models') return createMockDir({
        'huggingface.co': createMockDir({
          'org': createMockDir({
            'repo': createMockDir({
              'model.onnx': createMockFile(100),
              '.model.onnx.complete': createMockFile(0)
            })
          })
        })
      });
      throw new Error('Not found');
    });

    await import('./transformers-js.worker');
    const { env } = await import('@huggingface/transformers');
    const cache = (env as any).customCache;

    const response = await cache.match('https://huggingface.co/org/repo/model.onnx');
    expect(response).toBeDefined();
    expect(response.status).toBe(200);
    expect(response.headers.get('X-Cache-Hit')).toBe('OPFS');
  });

  it('opfsCache.put should save file to OPFS and create marker', async () => {
    await import('./transformers-js.worker');
    const { env } = await import('@huggingface/transformers');
    const cache = (env as any).customCache;

    const response = new Response('model data', {
      status: 200,
      headers: { 'Content-Type': 'application/octet-stream' }
    });

    await cache.put('https://huggingface.co/org/repo/model.onnx', response);
    expect(mockRoot.getDirectoryHandle).toHaveBeenCalledWith('models', { create: true });
  });

  it('loadModel should try tiered fallback from WebGPU to WASM', async () => {
    const comlink = await import('comlink');
    const { AutoModelForCausalLM, AutoTokenizer } = await import('@huggingface/transformers');
    await import('./transformers-js.worker');
    
    // Get the object that was passed to Comlink.expose
    const workerObj = (comlink.expose as any).mock.calls[0][0];

    (AutoModelForCausalLM.from_pretrained as any)
      .mockRejectedValueOnce(new Error('WebGPU q4f16 error'))
      .mockRejectedValueOnce(new Error('WebGPU q4 error'))
      .mockRejectedValueOnce(new Error('WebGPU default error'))
      .mockResolvedValueOnce({ 
        dispose: vi.fn(),
        device: 'wasm'
      });
    
    (AutoTokenizer.from_pretrained as any).mockResolvedValue({});

    const result = await workerObj.loadModel('org/repo', () => {});
    
    expect(result.device).toBe('wasm');
    expect(AutoModelForCausalLM.from_pretrained).toHaveBeenCalledTimes(4);
    expect(AutoModelForCausalLM.from_pretrained).toHaveBeenLastCalledWith('org/repo', expect.objectContaining({
      device: 'wasm'
    }));
  });

  it('downloadModel should normalize various Hugging Face URL formats', async () => {
    const comlink = await import('comlink');
    const { AutoModelForCausalLM, AutoTokenizer } = await import('@huggingface/transformers');
    await import('./transformers-js.worker');
    const workerObj = (comlink.expose as any).mock.calls[0][0];

    (AutoModelForCausalLM.from_pretrained as any).mockResolvedValue({ dispose: vi.fn() });
    (AutoTokenizer.from_pretrained as any).mockResolvedValue({});

    const testCases = [
      { input: 'hf.co/org/repo', expected: 'org/repo' },
      { input: 'https://huggingface.co/org/repo', expected: 'org/repo' },
      { input: 'org/repo', expected: 'org/repo' }
    ];

    for (const { input, expected } of testCases) {
      await workerObj.downloadModel(input, () => {});
      expect(AutoTokenizer.from_pretrained).toHaveBeenCalledWith(expected, expect.anything());
    }
  });
});