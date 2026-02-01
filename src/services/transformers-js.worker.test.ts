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
      { input: 'user/my-model', expected: 'user/my-model' },
      { input: 'org/repo', expected: 'org/repo' }
    ];

    for (const { input, expected } of testCases) {
      await workerObj.downloadModel(input, () => {});
      expect(AutoTokenizer.from_pretrained).toHaveBeenCalledWith(expected, expect.anything());
    }
  });

  describe('Fetch Interceptor', () => {
    let originalFetchMock: any;

    beforeEach(() => {
      originalFetchMock = vi.fn();
      // Ensure self.fetch is mockable before importing worker
      global.fetch = originalFetchMock;
      if (!global.self) {
        // @ts-expect-error: Mock global self for worker context
        global.self = global;
      }
      self.fetch = originalFetchMock;
    });

    it('should block requests to "user/" models with 404', async () => {
      await import('./transformers-js.worker');
      const interceptedFetch = self.fetch;

      const urls = [
        'https://example.com/models/user/my-model/config.json',
        'models/user/my-model/tokenizer.json',
        'user/my-model/model.onnx'
      ];

      for (const url of urls) {
        const res = await interceptedFetch(url);
        expect(res.status).toBe(404);
        expect(res.statusText).toContain('Local Only');
        expect(originalFetchMock).not.toHaveBeenCalled();
      }
    });

    it('should block requests to "local/" models with 404', async () => {
      await import('./transformers-js.worker');
      const interceptedFetch = self.fetch;

      const res = await interceptedFetch('local/test/model.bin');
      expect(res.status).toBe(404);
      expect(res.statusText).toContain('Local Only');
      expect(originalFetchMock).not.toHaveBeenCalled();
    });

    it('should convert HTML responses to 404 for model files (SPA fallback)', async () => {
      await import('./transformers-js.worker');
      const interceptedFetch = self.fetch;

      originalFetchMock.mockResolvedValue(new Response('<!DOCTYPE html>...', {
        status: 200,
        headers: { 'content-type': 'text/html' }
      }));

      const modelFiles = [
        'https://hf.co/model/config.json',
        'https://hf.co/model/model.onnx',
        'https://hf.co/model/tokenizer.json',
        'https://hf.co/model/weights.bin',
        'https://hf.co/model/module.wasm'
      ];

      for (const url of modelFiles) {
        const res = await interceptedFetch(url);
        expect(originalFetchMock).toHaveBeenCalledWith(url, undefined);
        expect(res.status).toBe(404);
        expect(res.statusText).toBe('Not Found');
        originalFetchMock.mockClear();
      }
    });

    it('should allow normal JSON/Binary responses', async () => {
      await import('./transformers-js.worker');
      const interceptedFetch = self.fetch;

      const mockRes = new Response('{}', { status: 200 });
      originalFetchMock.mockResolvedValue(mockRes);

      const url = 'https://hf.co/model/config.json';
      const res = await interceptedFetch(url);

      expect(res).toBe(mockRes);
      expect(res.status).toBe(200);
    });

    it('should allow normal HTML pages (not model files)', async () => {
      await import('./transformers-js.worker');
      const interceptedFetch = self.fetch;

      const mockRes = new Response('<html>ok</html>', { 
        status: 200, 
        headers: { 'content-type': 'text/html' } 
      });
      originalFetchMock.mockResolvedValue(mockRes);

      const url = 'https://example.com/docs.html';
      const res = await interceptedFetch(url);

      expect(res).toBe(mockRes);
      expect(res.status).toBe(200);
    });
  });
});