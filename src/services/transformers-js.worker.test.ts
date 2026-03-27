import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { WorkerToolDefinition } from './transformers-js.types';

// Hoisted spies for the module-level InterruptableStoppingCriteria singleton
const mockInterruptFn = vi.hoisted(() => vi.fn());
const mockResetFn = vi.hoisted(() => vi.fn());

// Mock @huggingface/transformers
vi.mock('@huggingface/transformers', () => ({
  AutoProcessor: {
    from_pretrained: vi.fn(),
  },
  AutoTokenizer: {
    from_pretrained: vi.fn(),
  },
  AutoModelForCausalLM: {
    from_pretrained: vi.fn(),
  },
  TextStreamer: vi.fn(),
  InterruptableStoppingCriteria: class {
    reset = mockResetFn;
    interrupt = mockInterruptFn;
  },
  StoppingCriteriaList: class extends Array { },
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
      const err = new Error('Not found');
      err.name = 'NotFoundError';
      throw err;
    }),
    getFileHandle: vi.fn(async (name: string, options?: { create?: boolean }) => {
      if (entries[name]) return entries[name];
      if (options?.create) {
        entries[name] = createMockFile(0);
        return entries[name];
      }
      const err = new Error('Not found');
      err.name = 'NotFoundError';
      throw err;
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
    createWritable: vi.fn().mockResolvedValue(new WritableStream({
      write: vi.fn(),
      close: vi.fn()
    }))
  };
  return file;
}

describe('transformers-js.worker', () => {
  let mockRoot: any;
  let originalFetchMock: any;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();

    originalFetchMock = vi.fn();
    vi.stubGlobal('fetch', originalFetchMock);
    global.self = {
      ...global.self,
      fetch: originalFetchMock,
      location: { origin: 'http://localhost:3000' } as any
    } as any;

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

  it('opfsCache.put should throw error when storage write fails', async () => {
    await import('./transformers-js.worker');
    const { env } = await import('@huggingface/transformers');
    const cache = (env as any).customCache;

    // Force failure in createWritable deep inside the hierarchy
    const failingFile = {
      createWritable: vi.fn().mockRejectedValue(new Error('QuotaExceededError'))
    };

    const failingDir = createMockDir({
      'model.onnx': failingFile
    });

    mockRoot.getDirectoryHandle.mockResolvedValue(failingDir);

    const response = new Response('model data', { status: 200 });

    // The URL 'https://huggingface.co/org/repo/model.onnx' maps to
    // models/huggingface.co/org/repo/model.onnx
    // So it will call getDirectoryHandle('models'), then 'huggingface.co', etc.
    // Our mock above handles the first 'models' call, but we need it to handle the others or be recursive.
    // Let's make it simpler: just mock getDirectoryHandle to always return a dir that has what's needed.
    const deepDir = createMockDir();
    deepDir.getFileHandle = vi.fn().mockResolvedValue(failingFile);
    deepDir.getDirectoryHandle.mockResolvedValue(deepDir);
    mockRoot.getDirectoryHandle.mockResolvedValue(deepDir);

    await expect(cache.put('https://huggingface.co/org/repo/model.onnx', response))
      .rejects.toThrow('QuotaExceededError');
  });

  it('opfsCache.put should throw error when HTML response is received', async () => {
    await import('./transformers-js.worker');
    const { env } = await import('@huggingface/transformers');
    const cache = (env as any).customCache;

    const response = new Response('<html>Error</html>', {
      status: 200,
      headers: { 'Content-Type': 'text/html' }
    });

    await expect(cache.put('https://huggingface.co/org/repo/model.onnx', response))
      .rejects.toThrow('Detected HTML response');
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

    const result = await workerObj.loadModel('org/repo', () => { });

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

    (AutoTokenizer.from_pretrained as any).mockResolvedValue({});

    const testCases = [
      { input: 'hf.co/org/repo', expected: 'org/repo' },
      { input: 'https://huggingface.co/org/repo', expected: 'org/repo' },
      { input: 'user/my-model', expected: 'user/my-model' },
      { input: 'org/repo', expected: 'org/repo' }
    ];

    for (const { input, expected } of testCases) {
      await workerObj.downloadModel(input, () => { });
      expect(AutoTokenizer.from_pretrained).toHaveBeenCalledWith(expected, expect.anything());
    }
    expect(AutoModelForCausalLM.from_pretrained).not.toHaveBeenCalled();
  });

  it('downloadModel should disable local model lookup for remote models', async () => {
    const comlink = await import('comlink');
    const { AutoModelForCausalLM, AutoTokenizer, env } = await import('@huggingface/transformers');
    await import('./transformers-js.worker');
    const workerObj = (comlink.expose as any).mock.calls[0][0];

    (AutoTokenizer.from_pretrained as any).mockImplementation(async () => {
      expect(env.allowLocalModels).toBe(false);
      return {};
    });

    await workerObj.downloadModel('mlx-community/Qwen3.5-2B-4bit', () => { });
    expect(env.allowLocalModels).toBe(true);
    expect(AutoModelForCausalLM.from_pretrained).not.toHaveBeenCalled();
  });

  it('downloadModel should keep local model lookup enabled for user models', async () => {
    const comlink = await import('comlink');
    const { AutoModelForCausalLM, AutoTokenizer, env } = await import('@huggingface/transformers');
    await import('./transformers-js.worker');
    const workerObj = (comlink.expose as any).mock.calls[0][0];

    (AutoTokenizer.from_pretrained as any).mockImplementation(async () => {
      expect(env.allowLocalModels).toBe(true);
      return {};
    });

    await workerObj.downloadModel('user/my-local-model', () => { });
    expect(env.allowLocalModels).toBe(true);
    expect(AutoModelForCausalLM.from_pretrained).not.toHaveBeenCalled();
  });

  it('prefetchUrls should stream files to OPFS and report progress', async () => {
    const comlink = await import('comlink');
    await import('./transformers-js.worker');
    const workerObj = (comlink.expose as any).mock.calls[0][0];

    const mockResponse = new Response(new Uint8Array([10, 20, 30, 40]), {
      status: 200,
      headers: { 'Content-Length': '4' }
    });
    originalFetchMock.mockResolvedValue(mockResponse);

    const progressUpdates: any[] = [];
    const progressCallback = (info: any) => progressUpdates.push(info);

    await workerObj.prefetchUrls(['https://huggingface.co/org/repo/model.onnx'], progressCallback);

    expect(originalFetchMock).toHaveBeenCalledWith('https://huggingface.co/org/repo/model.onnx');
    expect(mockRoot.getDirectoryHandle).toHaveBeenCalledWith('models', { create: true });
    expect(progressUpdates.length).toBeGreaterThan(0);
    expect(progressUpdates[0]).toMatchObject({
      status: 'progress',
      file: 'model.onnx'
    });
  });

  describe('Fetch Interceptor', () => {
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

      originalFetchMock.mockImplementation(async (input: RequestInfo | URL) => {
        const urlString = input.toString();
        // Simulate missing .gz file to force fallback to original
        if (urlString.endsWith('.gz')) {
          return new Response('Not Found', { status: 404 });
        }
        return new Response('<!DOCTYPE html>...', {
          status: 200,
          headers: { 'content-type': 'text/html' }
        });
      });

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

  // ---------------------------------------------------------------------------
  // generateText with tools
  // ---------------------------------------------------------------------------

  describe('generateText — standard model tool calls', () => {
    let workerObj: ReturnType<typeof vi.fn> extends never ? never : any;
    let capturedCallback: ((output: string) => void) | undefined;
    let tokensToEmit: string[];
    let mockApplyTemplate: ReturnType<typeof vi.fn>;

    beforeEach(async () => {
      // Outer beforeEach already ran vi.resetModules() + vi.clearAllMocks()
      capturedCallback = undefined;
      tokensToEmit = [];

      const tfMock = await import('@huggingface/transformers');

      (tfMock.TextStreamer as any).mockImplementation(
        function(this: unknown, _tok: unknown, opts: { callback_function: (output: string) => void }) {
          capturedCallback = opts.callback_function;
        }
      );

      mockApplyTemplate = vi.fn().mockReturnValue({ input_ids: [1, 2, 3] });
      const mockModel = {
        generate: vi.fn().mockImplementation(async () => {
          for (const token of tokensToEmit) capturedCallback?.(token);
          return { past_key_values: {} };
        }),
        dispose: vi.fn(),
        device: 'webgpu',
      };

      (tfMock.AutoModelForCausalLM.from_pretrained as any).mockResolvedValue(mockModel);
      (tfMock.AutoTokenizer.from_pretrained as any).mockResolvedValue({
        apply_chat_template: mockApplyTemplate,
      });

      await import('./transformers-js.worker');
      const comlink = await import('comlink');
      workerObj = (comlink.expose as any).mock.calls[0][0];
      await workerObj.loadModel('standard-model', vi.fn());
    });

    it('emits tool calls when <tool_call> tags appear in output', async () => {
      const payload = JSON.stringify({ name: 'search', arguments: { query: 'hello' } });
      tokensToEmit = [`<tool_call>${payload}</tool_call>`];

      const onChunk = vi.fn();
      const onToolCalls = vi.fn();
      const tools: WorkerToolDefinition[] = [
        { type: 'function', function: { name: 'search', description: 'Search', parameters: {} } },
      ];

      await workerObj.generateText([], onChunk, onToolCalls, undefined, tools);

      expect(onToolCalls).toHaveBeenCalledOnce();
      const [calls] = onToolCalls.mock.calls[0]!;
      expect(calls).toHaveLength(1);
      expect(calls[0].function.name).toBe('search');
      expect(JSON.parse(calls[0].function.arguments)).toEqual({ query: 'hello' });
    });

    it('streams non-tool text through onChunk', async () => {
      const payload = JSON.stringify({ name: 'fn', arguments: {} });
      tokensToEmit = ['before ', `<tool_call>${payload}</tool_call>`, ' after'];

      const onChunk = vi.fn();
      const tools: WorkerToolDefinition[] = [
        { type: 'function', function: { name: 'fn', description: 'Fn', parameters: {} } },
      ];

      await workerObj.generateText([], onChunk, vi.fn(), undefined, tools);

      const emitted = (onChunk.mock.calls as [string][]).map(([t]) => t).join('');
      expect(emitted).toContain('before ');
      expect(emitted).toContain(' after');
      expect(emitted).not.toContain('<tool_call>');
    });

    it('streams all output via onChunk when no tools are provided', async () => {
      tokensToEmit = ['hello ', 'world'];

      const onChunk = vi.fn();
      await workerObj.generateText([], onChunk, vi.fn(), undefined, undefined);

      expect(onChunk).toHaveBeenCalledWith('hello ');
      expect(onChunk).toHaveBeenCalledWith('world');
    });

    it('passes tools to apply_chat_template for standard models', async () => {
      tokensToEmit = [];
      const tools: WorkerToolDefinition[] = [
        { type: 'function', function: { name: 'fn', description: 'Fn', parameters: {} } },
      ];

      await workerObj.generateText([], vi.fn(), vi.fn(), undefined, tools);

      const [, templateOptions] = mockApplyTemplate.mock.calls[0]!;
      expect(templateOptions).toMatchObject({ tools });
    });
  });

  describe('generateText — Qwen3.5 model tool calls', () => {
    let workerObj: any;
    let capturedCallback: ((output: string) => void) | undefined;
    let tokensToEmit: string[];
    let mockApplyTemplate: ReturnType<typeof vi.fn>;
    let mockCallableTokenizer: ReturnType<typeof vi.fn>;
    let mockModel: {
      generate: ReturnType<typeof vi.fn>;
      dispose: ReturnType<typeof vi.fn>;
      device: string;
      config: {
        model_type: string;
      };
    };

    beforeEach(async () => {
      capturedCallback = undefined;
      tokensToEmit = [];

      const tfMock = await import('@huggingface/transformers');

      (tfMock.TextStreamer as any).mockImplementation(
        function(this: unknown, _tok: unknown, opts: { callback_function: (output: string) => void }) {
          capturedCallback = opts.callback_function;
        }
      );

      mockModel = {
        generate: vi.fn().mockImplementation(async () => {
          for (const token of tokensToEmit) capturedCallback?.(token);
          return { past_key_values: {} };
        }),
        dispose: vi.fn(),
        device: 'webgpu',
        config: {
          model_type: 'qwen3_5',
        },
      };

      (tfMock.AutoModelForCausalLM.from_pretrained as any).mockResolvedValue(mockModel);
      mockApplyTemplate = vi.fn().mockReturnValue({
        input_ids: [1, 2, 3],
        attention_mask: [1, 1, 1],
        image_grid_thw: 'grid-state',
      });
      mockCallableTokenizer = Object.assign(
        vi.fn().mockReturnValue({ input_ids: [9, 9, 9] }),
        { apply_chat_template: mockApplyTemplate }
      );
      (tfMock.AutoProcessor.from_pretrained as any).mockResolvedValue(Object.assign(
        vi.fn().mockResolvedValue({
          input_ids: [7, 8, 9],
          attention_mask: [1, 1, 1],
        }),
        {
          tokenizer: mockCallableTokenizer,
          batch_decode: vi.fn().mockReturnValue(['prompt-history']),
        },
      ));

      await import('./transformers-js.worker');
      const comlink = await import('comlink');
      workerObj = (comlink.expose as any).mock.calls[0][0];
      await workerObj.loadModel('onnx-community/Qwen3.5-2B-ONNX', vi.fn());
    });

    it('parses Qwen3.5 XML-like tool calls', async () => {
      tokensToEmit = [
        '<tool_call>\n',
        '<function=shell_execute>\n',
        '<parameter=shell_script>\n',
        'ls -la /home/user/codex-main\n',
        '</parameter>\n',
        '<parameter=stdout_limit>\n',
        '20\n',
        '</parameter>\n',
        '<parameter=stderr_limit>\n',
        '20\n',
        '</parameter>\n',
        '</function>\n',
        '</tool_call>',
      ];

      const onToolCalls = vi.fn();
      const tools: WorkerToolDefinition[] = [
        { type: 'function', function: { name: 'shell_execute', description: 'Run shell', parameters: {} } },
      ];

      await workerObj.generateText([], vi.fn(), onToolCalls, undefined, tools);

      expect(onToolCalls).toHaveBeenCalledOnce();
      const [calls] = onToolCalls.mock.calls[0]!;
      expect(calls).toHaveLength(1);
      expect(calls[0].function.name).toBe('shell_execute');
      expect(JSON.parse(calls[0].function.arguments)).toEqual({
        shell_script: 'ls -la /home/user/codex-main',
        stdout_limit: 20,
        stderr_limit: 20,
      });
    });

    it('injects Qwen3.5 tool instructions via system prompt instead of template tools', async () => {
      const tools: WorkerToolDefinition[] = [
        { type: 'function', function: { name: 'shell_execute', description: 'Run shell', parameters: {} } },
      ];

      await workerObj.generateText(
        [{ role: 'user', content: 'list files' }],
        vi.fn(),
        vi.fn(),
        undefined,
        tools
      );

      const processorMock = (await import('@huggingface/transformers')).AutoProcessor.from_pretrained as any;
      const processor = await processorMock.mock.results[0]?.value;
      expect(processor).toHaveBeenCalledOnce();
      expect(processor.mock.calls[0]?.[0]).toContain('# Tools');
      expect(processor.mock.calls[0]?.[0]).toContain('"name":"shell_execute"');
      expect(mockApplyTemplate).not.toHaveBeenCalled();
    });

    it('serializes Qwen3.5 assistant tool call arguments as JSON objects in prompts', async () => {
      const tools: WorkerToolDefinition[] = [
        { type: 'function', function: { name: 'shell_execute', description: 'Run shell', parameters: {} } },
      ];

      await workerObj.generateText(
        [
          { role: 'user', content: 'list files' },
          {
            role: 'assistant',
            content: '',
            tool_calls: [{
              id: 'call_1',
              type: 'function',
              function: {
                name: 'shell_execute',
                arguments: '{"shell_script":"ls -la","stdout_limit":100}',
              },
            }],
          },
          { role: 'tool', tool_call_id: 'call_1', content: 'Exit Code: 0\n' },
        ],
        vi.fn(),
        vi.fn(),
        undefined,
        tools
      );

      const processorMock = (await import('@huggingface/transformers')).AutoProcessor.from_pretrained as any;
      const processor = await processorMock.mock.results[0]?.value;
      expect(processor.mock.calls[0]?.[0]).toContain('"arguments":{"shell_script":"ls -la","stdout_limit":100}');
    });

    it('uses full prompts without Qwen3.5 tool continuation past_key_values reuse', async () => {
      const tools: WorkerToolDefinition[] = [
        { type: 'function', function: { name: 'shell_execute', description: 'Run shell', parameters: {} } },
      ];

      await workerObj.generateText(
        [{ role: 'user', content: 'list files' }],
        vi.fn(),
        vi.fn(),
        undefined,
        tools
      );

      mockApplyTemplate.mockClear();
      mockModel.generate.mockClear();

      await workerObj.generateText(
        [
          { role: 'user', content: 'list files' },
          {
            role: 'assistant',
            content: '',
            tool_calls: [{
              id: 'call_1',
              type: 'function',
              function: {
                name: 'shell_execute',
                arguments: '{"shell_script":"ls -la /tmp","stdout_limit":100}',
              },
            }],
          },
          {
            role: 'tool',
            tool_call_id: 'call_1',
            content: 'Exit Code: 0\nSTDOUT:\nfile-a\n',
          },
        ],
        vi.fn(),
        vi.fn(),
        undefined,
        tools
      );

      expect(mockModel.generate).toHaveBeenCalledOnce();
      expect(mockModel.generate).toHaveBeenCalledWith(expect.objectContaining({
        input_ids: [7, 8, 9],
        attention_mask: [1, 1, 1],
        past_key_values: null,
      }));
      expect(mockModel.generate.mock.calls[0]?.[0]).not.toHaveProperty('pixel_values');
      expect(mockApplyTemplate).not.toHaveBeenCalled();
    });

    it('clears Qwen3.5 no-tool continuation state when resetCache is called', async () => {
      mockModel.generate
        .mockResolvedValueOnce({ past_key_values: { kv: 1 }, sequences: ['first'] })
        .mockResolvedValueOnce({ past_key_values: { kv: 2 }, sequences: ['second'] });

      await workerObj.generateText(
        [{ role: 'user', content: 'hello' }],
        vi.fn(),
        vi.fn(),
        undefined,
        undefined
      );

      await workerObj.resetCache();

      mockModel.generate.mockClear();

      await workerObj.generateText(
        [
          { role: 'user', content: 'hello' },
          { role: 'assistant', content: 'hi' },
          { role: 'user', content: 'again' },
        ],
        vi.fn(),
        vi.fn(),
        undefined,
        undefined
      );

      expect(mockModel.generate).toHaveBeenCalledWith(expect.objectContaining({
        past_key_values: null,
      }));
    });

    it('does not reuse past_key_values when Qwen3.5 no-tool continuation shape does not match', async () => {
      mockModel.generate
        .mockResolvedValueOnce({ past_key_values: { kv: 1 }, sequences: ['first'] })
        .mockResolvedValueOnce({ past_key_values: { kv: 2 }, sequences: ['second'] });

      await workerObj.generateText(
        [{ role: 'user', content: 'hello' }],
        vi.fn(),
        vi.fn(),
        undefined,
        undefined
      );

      mockModel.generate.mockClear();

      await workerObj.generateText(
        [
          { role: 'user', content: 'hello' },
          { role: 'assistant', content: 'hi' },
          { role: 'user', content: 'again' },
        ],
        vi.fn(),
        vi.fn(),
        undefined,
        undefined
      );

      expect(mockModel.generate).toHaveBeenCalledWith(expect.objectContaining({
        past_key_values: null,
      }));
    });

    it('sanitizes visible Qwen3.5 control tokens from streamed output', async () => {
      const tools: WorkerToolDefinition[] = [
        { type: 'function', function: { name: 'shell_execute', description: 'Run shell', parameters: {} } },
      ];

      tokensToEmit = ['hello', '<|im_end|>', '\nworld'];
      const onChunk = vi.fn();

      await workerObj.generateText(
        [{ role: 'user', content: 'list files' }],
        onChunk,
        vi.fn(),
        undefined,
        tools
      );

      const emitted = (onChunk.mock.calls as [string][]).map(([chunk]) => chunk).join('');
      expect(emitted).toBe('helloworld');
    });
  });

  describe('generateText — GPT-OSS model tool calls', () => {
    let workerObj: any;
    let capturedCallback: ((output: string) => void) | undefined;
    let tokensToEmit: string[];
    let mockApplyTemplate: ReturnType<typeof vi.fn>;
    let mockCallableTokenizer: ReturnType<typeof vi.fn>;

    beforeEach(async () => {
      capturedCallback = undefined;
      tokensToEmit = [];

      const tfMock = await import('@huggingface/transformers');

      (tfMock.TextStreamer as any).mockImplementation(
        function(this: unknown, _tok: unknown, opts: { callback_function: (output: string) => void }) {
          capturedCallback = opts.callback_function;
        }
      );

      mockApplyTemplate = vi.fn().mockReturnValue({ input_ids: [1, 2, 3] });
      // GPT-OSS tokenizer must be callable for buildGptOssToolResultTokens
      mockCallableTokenizer = Object.assign(
        vi.fn().mockReturnValue({ input_ids: [1] }),
        { apply_chat_template: mockApplyTemplate }
      );

      const mockModel = {
        generate: vi.fn().mockImplementation(async () => {
          for (const token of tokensToEmit) capturedCallback?.(token);
          return { past_key_values: {} };
        }),
        dispose: vi.fn(),
        device: 'webgpu',
      };

      (tfMock.AutoModelForCausalLM.from_pretrained as any).mockResolvedValue(mockModel);
      (tfMock.AutoTokenizer.from_pretrained as any).mockResolvedValue(mockCallableTokenizer);

      await import('./transformers-js.worker');
      const comlink = await import('comlink');
      workerObj = (comlink.expose as any).mock.calls[0][0];
      await workerObj.loadModel('my-gpt-oss-model', vi.fn());
    });

    const GPT_OSS_TOOL_CALL_TOKENS = [
      '<|start|>',
      'assistant to=functions.my_tool',
      '<|channel|>',
      'commentary',
      '<|message|>',
      '{"query":"test"}',
      '<|call|>',
    ];

    const SIMPLE_TOOL: WorkerToolDefinition = {
      type: 'function',
      function: {
        name: 'my_tool',
        description: 'Search the web',
        parameters: {
          type: 'object',
          properties: { query: { type: 'string' } },
          required: ['query'],
        },
      },
    };

    it('emits tool calls on Harmony <|call|> token', async () => {
      tokensToEmit = GPT_OSS_TOOL_CALL_TOKENS;

      const onToolCalls = vi.fn();
      await workerObj.generateText([], vi.fn(), onToolCalls, undefined, [SIMPLE_TOOL]);

      expect(onToolCalls).toHaveBeenCalledOnce();
      const [calls] = onToolCalls.mock.calls[0]!;
      expect(calls).toHaveLength(1);
      expect(calls[0].function.name).toBe('my_tool');
      expect(JSON.parse(calls[0].function.arguments)).toEqual({ query: 'test' });
    });

    it('calls stoppingCriteria.interrupt() on <|call|>', async () => {
      tokensToEmit = GPT_OSS_TOOL_CALL_TOKENS;

      await workerObj.generateText([], vi.fn(), vi.fn(), undefined, [SIMPLE_TOOL]);

      expect(mockInterruptFn).toHaveBeenCalled();
    });

    it('does NOT call stoppingCriteria.interrupt() when no tool call is made', async () => {
      tokensToEmit = ['<|start|>', 'assistant', '<|channel|>', 'final', '<|message|>', 'Hello!', '<|end|>'];

      await workerObj.generateText([], vi.fn(), vi.fn(), undefined, [SIMPLE_TOOL]);

      expect(mockInterruptFn).not.toHaveBeenCalled();
    });

    it('streams analysis channel content as think tags', async () => {
      tokensToEmit = [
        '<|start|>',
        'assistant',
        '<|channel|>',
        'analysis',
        '<|message|>',
        'private reasoning',
        '<|end|>',
        '<|start|>',
        'assistant',
        '<|channel|>',
        'final',
        '<|message|>',
        'Visible answer',
        '<|return|>',
      ];

      const onChunk = vi.fn();
      await workerObj.generateText([], onChunk, vi.fn(), undefined, [SIMPLE_TOOL]);

      const emitted = (onChunk.mock.calls as [string][]).map(([t]) => t).join('');
      expect(emitted).toBe('<think>private reasoning</think>Visible answer');
    });

    it('prepends a developer message with TypeScript namespace tool definitions', async () => {
      tokensToEmit = [];

      await workerObj.generateText(
        [{ role: 'user', content: 'hi' }],
        vi.fn(),
        vi.fn(),
        undefined,
        [SIMPLE_TOOL]
      );

      const [formattedMessages] = mockApplyTemplate.mock.calls[0]!;
      expect(formattedMessages[0]).toMatchObject({
        role: 'developer',
        content: expect.stringContaining('namespace functions {'),
      });
      expect(formattedMessages[0].content).toContain('type my_tool');
      expect(formattedMessages[0].content).toContain('query: string');
    });

    it('skips apply_chat_template and calls tokenizer directly for GPT-OSS continuation', async () => {
      tokensToEmit = [];

      await workerObj.generateText(
        [{ role: 'user', content: 'run it' }],
        vi.fn(),
        vi.fn(),
        undefined,
        [SIMPLE_TOOL]
      );

      mockApplyTemplate.mockClear();
      mockCallableTokenizer.mockClear();

      const messages = [
        { role: 'user', content: 'run it' },
        {
          role: 'assistant',
          content: '',
          tool_calls: [{ id: 'call_1', type: 'function' as const, function: { name: 'my_tool', arguments: '{}' } }],
        },
        { role: 'tool', content: 'done', tool_call_id: 'call_1' },
      ];

      await workerObj.generateText(messages, vi.fn(), vi.fn(), undefined, [SIMPLE_TOOL]);

      expect(mockApplyTemplate).not.toHaveBeenCalled();
      // The callable tokenizer should have been invoked with the Harmony-formatted text
      expect(mockCallableTokenizer).toHaveBeenCalledWith(
        expect.stringContaining('<|start|>my_tool to=assistant'),
        expect.objectContaining({ add_special_tokens: false })
      );
    });

    it('does not treat stale historical tool results as a continuation', async () => {
      tokensToEmit = [];

      const messages = [
        {
          role: 'assistant',
          content: '',
          tool_calls: [{ id: 'call_1', type: 'function' as const, function: { name: 'my_tool', arguments: '{}' } }],
        },
        { role: 'tool', content: 'done', tool_call_id: 'call_1' },
        { role: 'user', content: 'thanks' },
      ];

      await workerObj.generateText(messages, vi.fn(), vi.fn(), undefined, [SIMPLE_TOOL]);

      expect(mockApplyTemplate).toHaveBeenCalledOnce();
      expect(mockCallableTokenizer).not.toHaveBeenCalled();
    });
  });
});
