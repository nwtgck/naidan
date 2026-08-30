import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { WorkerToolDefinition } from '@/features/transformers-js/types';
import { MODEL_SUPPORT_INVESTIGATION_MULTIMODAL_FIXTURE } from '@/features/transformers-js/model-support-investigation/fixtures/synthetic-multimodal-image';

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
    supports: vi.fn(),
  },
  AutoModelForImageTextToText: {
    from_pretrained: vi.fn(),
    supports: vi.fn(),
  },
  TextStreamer: vi.fn(),
  RawImage: {
    read: vi.fn(),
  },
  InterruptableStoppingCriteria: class {
    reset = mockResetFn;
    interrupt = mockInterruptFn;
  },
  StoppingCriteriaList: class extends Array { },
  env: {
    backends: {
      onnx: {
        wasm: {},
        logLevel: 'error',
      },
    },
    allowLocalModels: false,
    allowRemoteModels: true,
    useBrowserCache: false,
    useCustomCache: false,
    customCache: null,
  },
}));

// Mock Comlink
vi.mock('comlink', () => ({
  expose: vi.fn(),
  proxy: vi.fn(x => x),
}));

// Mock Worker globals
vi.stubGlobal('self', {
  location: {
    origin: 'http://localhost:3000',
    href: 'http://localhost:3000/src/features/transformers-js/worker/entry.ts',
  },
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
    }),
  };
  return dir;
}

function createMockFile(initialSize: number) {
  let bytes = new Uint8Array(initialSize);
  return {
    kind: 'file',
    get size() {
      return bytes.byteLength;
    },
    getFile: vi.fn(async () => {
      const snapshot = new Uint8Array(bytes);
      return {
        size: snapshot.byteLength,
        stream: () => new ReadableStream<Uint8Array>({
          start: controller => {
            controller.enqueue(snapshot);
            controller.close();
          },
        }),
      };
    }),
    createWritable: vi.fn(async () => {
      const chunks: Uint8Array[] = [];
      return new WritableStream<Uint8Array>({
        write: chunk => {
          chunks.push(new Uint8Array(chunk));
        },
        close: () => {
          const byteLength = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
          const merged = new Uint8Array(byteLength);
          let offset = 0;
          for (const chunk of chunks) {
            merged.set(chunk, offset);
            offset += chunk.byteLength;
          }
          bytes = merged;
        },
      });
    }),
  };
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
      location: {
        origin: 'http://localhost:3000',
        href: 'http://localhost:3000/src/features/transformers-js/worker/entry.ts',
      } as any,
    } as any;

    mockRoot = createMockDir();
    vi.stubGlobal('navigator', {
      storage: {
        getDirectory: vi.fn().mockResolvedValue(mockRoot),
      },
      hardwareConcurrency: 4,
      userAgent: 'Mozilla/5.0 Chrome/140',
      vendor: 'Google Inc.',
    });

    const { AutoModelForCausalLM, AutoModelForImageTextToText } = await import('@huggingface/transformers');
    (AutoModelForCausalLM.supports as any).mockImplementation((modelType: string) => modelType !== 'gemma4');
    (AutoModelForImageTextToText.supports as any).mockImplementation((modelType: string) => modelType === 'gemma4');
  });

  it('should initialize with custom OPFS cache', async () => {
    const { env } = await import('@huggingface/transformers');
    await import('./entry');

    expect(env.useCustomCache).toBe(true);
    expect(env.customCache).toBeDefined();
    expect(env.customCache).toHaveProperty('match');
    expect(env.customCache).toHaveProperty('put');
    expect(env.backends.onnx.wasm).toBeDefined();
    expect(env.backends.onnx.wasm?.wasmPaths).toEqual({
      mjs: 'http://localhost:3000/transformers/ort-wasm-simd-threaded.asyncify.mjs',
      wasm: 'http://localhost:3000/transformers/ort-wasm-simd-threaded.asyncify.wasm',
    });
  }, 30000);

  it('opfsCache.match should return undefined for non-existent file', async () => {
    await import('./entry');
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
              '.model.onnx.complete': createMockFile(0),
            }),
          }),
        }),
      });
      throw new Error('Not found');
    });

    await import('./entry');
    const { env } = await import('@huggingface/transformers');
    const cache = (env as any).customCache;

    const response = await cache.match('https://huggingface.co/org/repo/model.onnx');
    expect(response).toBeDefined();
    expect(response.status).toBe(200);
    expect(response.headers.get('X-Cache-Hit')).toBe('OPFS');
  });

  it('opfsCache.put should save file to OPFS and create marker', async () => {
    await import('./entry');
    const { env } = await import('@huggingface/transformers');
    const cache = (env as any).customCache;

    const response = new Response('model data', {
      status: 200,
      headers: { 'Content-Type': 'application/octet-stream' },
    });

    await cache.put('https://huggingface.co/org/repo/model.onnx', response);
    expect(mockRoot.getDirectoryHandle).toHaveBeenCalledWith('models', { create: true });
  });

  it('opfsCache.put should throw error when storage write fails', async () => {
    await import('./entry');
    const { env } = await import('@huggingface/transformers');
    const cache = (env as any).customCache;

    // Force failure in createWritable deep inside the hierarchy
    const failingFile = {
      createWritable: vi.fn().mockRejectedValue(new Error('QuotaExceededError')),
    };

    const failingDir = createMockDir({
      'model.onnx': failingFile,
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
    await import('./entry');
    const { env } = await import('@huggingface/transformers');
    const cache = (env as any).customCache;

    const response = new Response('<html>Error</html>', {
      status: 200,
      headers: { 'Content-Type': 'text/html' },
    });

    await expect(cache.put('https://huggingface.co/org/repo/model.onnx', response))
      .rejects.toThrow('Detected HTML response');
  });

  it('loadModel should try tiered fallback from WebGPU to WASM', async () => {
    const comlink = await import('comlink');
    const { AutoModelForCausalLM, AutoTokenizer } = await import('@huggingface/transformers');
    await import('./entry');

    // Get the object that was passed to Comlink.expose
    const workerObj = (comlink.expose as any).mock.calls[0][0];

    (AutoModelForCausalLM.from_pretrained as any)
      .mockRejectedValueOnce(new Error('WebGPU q4f16 error'))
      .mockRejectedValueOnce(new Error('WebGPU q4 error'))
      .mockResolvedValueOnce({
        dispose: vi.fn(),
        device: 'wasm',
      });

    (AutoTokenizer.from_pretrained as any).mockResolvedValue({});

    const result = await workerObj.loadModel('org/repo', () => { });

    expect(result.device).toBe('wasm');
    expect(AutoModelForCausalLM.from_pretrained).toHaveBeenCalledTimes(3);
    expect(AutoModelForCausalLM.from_pretrained).toHaveBeenLastCalledWith('org/repo', expect.objectContaining({
      device: 'wasm',
      dtype: 'q4',
    }));
  });

  it('preserves the base public load options apart from the intentional quantized-only fallback set', async () => {
    const comlink = await import('comlink');
    const { AutoModelForCausalLM, AutoTokenizer } = await import('@huggingface/transformers');
    await import('./entry');
    const workerObj = (comlink.expose as any).mock.calls[0][0];

    (AutoModelForCausalLM.from_pretrained as any)
      .mockRejectedValueOnce(new Error('q4f16 failed'))
      .mockResolvedValueOnce({ dispose: vi.fn(), config: { model_type: 'example' } });
    (AutoTokenizer.from_pretrained as any).mockResolvedValue({});

    await workerObj.loadModel('org/repo', vi.fn());

    expect(AutoModelForCausalLM.from_pretrained).toHaveBeenNthCalledWith(1, 'org/repo', expect.objectContaining({
      device: 'webgpu',
      dtype: 'q4f16',
      local_files_only: false,
    }));
    expect(AutoModelForCausalLM.from_pretrained).toHaveBeenNthCalledWith(2, 'org/repo', expect.objectContaining({
      device: 'webgpu',
      dtype: 'q4',
      local_files_only: false,
    }));
    const firstOptions = (AutoModelForCausalLM.from_pretrained as any).mock.calls[0][1];
    const secondOptions = (AutoModelForCausalLM.from_pretrained as any).mock.calls[1][1];
    expect(firstOptions).not.toHaveProperty('revision');
    expect(secondOptions).not.toHaveProperty('revision');
    const tokenizerOptions = (AutoTokenizer.from_pretrained as any).mock.calls[0][1];
    expect(tokenizerOptions).toMatchObject({ local_files_only: false });
    expect(tokenizerOptions).not.toHaveProperty('revision');
  });

  it('runs a fixed-revision Production Lane scenario with one explicit candidate', async () => {
    const comlink = await import('comlink');
    const { AutoModelForCausalLM, AutoTokenizer } = await import('@huggingface/transformers');
    await import('./entry');
    const workerObj = (comlink.expose as any).mock.calls[0][0];
    const dispose = vi.fn();
    const decode = vi.fn()
      .mockReturnValueOnce('observed production output')
      .mockReturnValueOnce('continued output')
      .mockReturnValueOnce('tool result continuation output');
    const generate = vi.fn()
      .mockResolvedValueOnce({
        past_key_values: { layer_0: {} },
        sequences: { data: BigInt64Array.from([10n, 11n, 20n, 21n]) },
      })
      .mockResolvedValueOnce({
        past_key_values: { layer_0: {}, layer_1: {} },
        sequences: { data: BigInt64Array.from([10n, 11n, 20n, 21n, 30n, 40n]) },
      })
      .mockResolvedValueOnce({
        past_key_values: { tool_layer: {} },
        sequences: { data: BigInt64Array.from([50n, 51n, 52n, 60n]) },
      });
    (AutoModelForCausalLM.from_pretrained as any).mockResolvedValue({
      dispose,
      generate,
      config: {
        model_type: 'example',
        is_encoder_decoder: false,
      },
    });
    const templateInputs = [
      {
        input_ids: { data: BigInt64Array.from([10n, 11n]) },
        attention_mask: { data: BigInt64Array.from([1n, 1n]) },
      },
      {
        input_ids: { data: BigInt64Array.from([10n, 11n, 20n, 21n, 30n]) },
        attention_mask: { data: BigInt64Array.from([1n, 1n, 1n, 1n, 1n]) },
      },
      {
        input_ids: { data: BigInt64Array.from([50n, 51n, 52n]) },
        attention_mask: { data: BigInt64Array.from([1n, 1n, 1n]) },
      },
    ];
    const applyChatTemplate = vi.fn((_messages, options: { tokenize?: boolean, return_dict?: boolean } | undefined) => {
      if (options?.tokenize === false) return '<|im_start|>assistant\n';
      return templateInputs.shift();
    });
    (AutoTokenizer.from_pretrained as any).mockResolvedValue({
      apply_chat_template: applyChatTemplate,
      decode,
    });

    const observation = await workerObj.runModelSupportInvestigationScenario(
      {
        modelId: 'org/model',
        resolvedRevision: 'a'.repeat(40),
        candidate: { device: 'webgpu', dtype: 'q4' },
        messages: [{ role: 'user', content: 'hello' }],
        followUpMessage: { role: 'user', content: 'Continue with one short sentence.' },
        toolResultContinuation: {
          toolCall: { name: 'lookup_weather', arguments: '{"city":"Tokyo"}' },
          toolResultContent: '{"temperatureC":20,"condition":"clear"}',
          expectedInputTokenIds: [50, 51, 52],
          maxNewTokens: 16,
        },
        maxNewTokens: 16,
      },
      vi.fn(),
    );

    expect(AutoModelForCausalLM.from_pretrained).toHaveBeenCalledTimes(1);
    expect(AutoModelForCausalLM.from_pretrained).toHaveBeenCalledWith('org/model', expect.objectContaining({
      revision: 'a'.repeat(40),
      device: 'webgpu',
      dtype: 'q4',
    }));
    expect(AutoTokenizer.from_pretrained).toHaveBeenCalledWith('org/model', expect.objectContaining({
      revision: 'a'.repeat(40),
    }));
    expect(generate).toHaveBeenCalledTimes(3);
    expect(generate).toHaveBeenCalledWith(expect.objectContaining({
      max_new_tokens: 16,
      temperature: 0,
      top_p: 1,
      do_sample: false,
    }));
    expect(observation).toMatchObject({
      candidate: { device: 'webgpu', dtype: 'q4' },
      route: {
        autoClass: 'AutoModelForCausalLM',
        processor: 'tokenizer',
        strategy: 'standard',
        modelType: 'example',
      },
      inputTokenIds: [10, 11],
      generatedSequenceTokenIds: [10, 11, 20, 21],
      generatedTokenIds: [20, 21],
      generatedText: 'observed production output',
      pastKeyValuesProvided: false,
      inputPastKeyValuesSummary: { kind: 'nullish' },
      outputPastKeyValuesSummary: { kind: 'object', ownKeys: ['layer_0'] },
      continuity: {
        status: 'passed',
        assistantMessage: { role: 'assistant', content: 'observed production output' },
        followUpMessage: { role: 'user', content: 'Continue with one short sentence.' },
        secondTurn: {
          inputTokenIds: [10, 11, 20, 21, 30],
          generatedSequenceTokenIds: [10, 11, 20, 21, 30, 40],
          generatedTokenIds: [40],
          generatedText: 'continued output',
          pastKeyValuesProvided: false,
          outputPastKeyValuesSummary: { kind: 'object', ownKeys: ['layer_0', 'layer_1'] },
        },
        prefixComparison: {
          mode: 'full-input-prefix',
          expectedPrefixTokenIds: [10, 11, 20, 21],
          secondInputTokenIds: [10, 11, 20, 21, 30],
          exactPrefixMatch: true,
          firstMismatchIndex: undefined,
        },
      },
      toolResultContinuation: {
        status: 'passed',
        source: 'reference-parser-roundtrip',
        strategy: 'standard',
        expectedInputTokenIds: [50, 51, 52],
        inputTokenExactMatch: true,
        firstInputMismatchIndex: undefined,
        turn: {
          inputTokenIds: [50, 51, 52],
          generatedSequenceTokenIds: [50, 51, 52, 60],
          generatedTokenIds: [60],
          generatedText: 'tool result continuation output',
          pastKeyValuesProvided: false,
          outputPastKeyValuesSummary: { kind: 'object', ownKeys: ['tool_layer'] },
        },
      },
    });
    const tokenizedTemplateCalls = applyChatTemplate.mock.calls.filter(([, options]) => (
      options?.return_dict === true && options?.tokenize !== false
    ));
    expect(tokenizedTemplateCalls[1]).toEqual([
      [
        { role: 'user', content: 'hello', tool_calls: undefined, tool_call_id: undefined },
        { role: 'assistant', content: 'observed production output', tool_calls: undefined, tool_call_id: undefined },
        { role: 'user', content: 'Continue with one short sentence.', tool_calls: undefined, tool_call_id: undefined },
      ],
      expect.objectContaining({ add_generation_prompt: true }),
    ]);
    expect(tokenizedTemplateCalls[2]).toEqual([
      [
        { role: 'user', content: 'Use the weather tool for Tokyo.', tool_calls: undefined, tool_call_id: undefined },
        {
          role: 'assistant',
          content: '',
          tool_calls: [{
            id: 'call_model_support_probe_1',
            type: 'function',
            function: { name: 'lookup_weather', arguments: '{"city":"Tokyo"}' },
          }],
          tool_call_id: undefined,
        },
        {
          role: 'tool',
          tool_call_id: 'call_model_support_probe_1',
          content: '{"temperatureC":20,"condition":"clear"}',
          tool_calls: undefined,
        },
      ],
      expect.objectContaining({
        add_generation_prompt: true,
        tools: expect.arrayContaining([expect.objectContaining({
          function: expect.objectContaining({ name: 'lookup_weather' }),
        })]),
      }),
    ]);
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('loadModel should load the Gemma 4 processor and use its tokenizer', async () => {
    const comlink = await import('comlink');
    const { AutoModelForImageTextToText, AutoProcessor, AutoTokenizer } = await import('@huggingface/transformers');
    await import('./entry');
    const workerObj = (comlink.expose as any).mock.calls[0][0];

    (AutoModelForImageTextToText.from_pretrained as any).mockResolvedValue({
      dispose: vi.fn(),
      device: 'webgpu',
      config: {
        model_type: 'gemma4',
      },
    });
    (AutoProcessor.from_pretrained as any).mockResolvedValue({
      tokenizer: {
        apply_chat_template: vi.fn(),
      },
    });

    await workerObj.loadModel('onnx-community/gemma-4-E2B-it-ONNX', vi.fn());

    expect(AutoModelForImageTextToText.from_pretrained).toHaveBeenCalledWith('onnx-community/gemma-4-E2B-it-ONNX', expect.anything());
    expect(AutoProcessor.from_pretrained).toHaveBeenCalledWith('onnx-community/gemma-4-E2B-it-ONNX', expect.anything());
    expect(AutoTokenizer.from_pretrained).not.toHaveBeenCalled();
  });

  it('loadModel should fail early when the active runtime does not support gemma4', async () => {
    const comlink = await import('comlink');
    const { AutoModelForImageTextToText, AutoModelForCausalLM } = await import('@huggingface/transformers');
    await import('./entry');
    const workerObj = (comlink.expose as any).mock.calls[0][0];

    (AutoModelForImageTextToText.supports as any).mockReturnValueOnce(false);

    await expect(workerObj.loadModel('onnx-community/gemma-4-E2B-it-ONNX', vi.fn()))
      .rejects
      .toThrow('does not support gemma4');

    expect(AutoModelForImageTextToText.from_pretrained).not.toHaveBeenCalled();
    expect(AutoModelForCausalLM.from_pretrained).not.toHaveBeenCalled();
  });

  it('downloadModel should normalize various Hugging Face URL formats', async () => {
    const comlink = await import('comlink');
    const { AutoModelForCausalLM, AutoTokenizer } = await import('@huggingface/transformers');
    await import('./entry');
    const workerObj = (comlink.expose as any).mock.calls[0][0];

    (AutoTokenizer.from_pretrained as any).mockResolvedValue({});

    const testCases = [
      { input: 'hf.co/org/repo', expected: 'org/repo' },
      { input: 'https://huggingface.co/org/repo', expected: 'org/repo' },
      { input: 'user/my-model', expected: 'user/my-model' },
      { input: 'org/repo', expected: 'org/repo' },
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
    await import('./entry');
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
    await import('./entry');
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
    await import('./entry');
    const workerObj = (comlink.expose as any).mock.calls[0][0];

    const mockResponse = new Response(new Uint8Array([10, 20, 30, 40]), {
      status: 200,
      headers: { 'Content-Length': '4' },
    });
    originalFetchMock.mockResolvedValue(mockResponse);

    const progressUpdates: any[] = [];
    const progressCallback = (info: any) => progressUpdates.push(info);

    const result = await workerObj.prefetchUrls(['https://huggingface.co/org/repo/model.onnx'], progressCallback);

    expect(result).toEqual({
      requestedCount: 1,
      cachedCount: 0,
      downloadedCount: 1,
      failedCount: 0,
      complete: true,
      files: [{
        status: 'downloaded',
        url: 'https://huggingface.co/org/repo/model.onnx',
        path: 'models/huggingface.co/org/repo/model.onnx',
        byteLength: 4,
        expectedByteLength: 4,
      }],
    });
    expect(originalFetchMock).toHaveBeenCalledWith('https://huggingface.co/org/repo/model.onnx');
    expect(mockRoot.getDirectoryHandle).toHaveBeenCalledWith('models', { create: true });
    expect(progressUpdates.length).toBeGreaterThan(0);
    expect(progressUpdates[0]).toMatchObject({
      status: 'progress',
      file: 'model.onnx',
    });
  });

  it('prefetchUrls should report partial failures without exposing signed query parameters', async () => {
    const comlink = await import('comlink');
    await import('./entry');
    const workerObj = (comlink.expose as any).mock.calls[0][0];

    originalFetchMock
      .mockResolvedValueOnce(new Response(Uint8Array.from([1]), {
        status: 200,
        headers: { 'Content-Length': '1' },
      }))
      .mockResolvedValueOnce(new Response(null, {
        status: 503,
        statusText: 'Unavailable',
      }));

    const result = await workerObj.prefetchUrls([
      'https://huggingface.co/org/repo/a.onnx?token=secret',
      'https://huggingface.co/org/repo/b.onnx?token=secret',
    ], () => { });

    expect(result).toEqual({
      requestedCount: 2,
      cachedCount: 0,
      downloadedCount: 1,
      failedCount: 1,
      complete: false,
      files: [
        {
          status: 'downloaded',
          url: 'https://huggingface.co/org/repo/a.onnx',
          path: 'models/huggingface.co/org/repo/a.onnx',
          byteLength: 1,
          expectedByteLength: 1,
        },
        {
          status: 'failed',
          url: 'https://huggingface.co/org/repo/b.onnx',
          path: 'models/huggingface.co/org/repo/b.onnx',
          failureStage: 'response-status',
          httpStatus: 503,
          error: {
            name: 'Error',
            message: 'HTTP 503 Unavailable',
          },
        },
      ],
    });
  });

  describe('Fetch Interceptor', () => {
    it('should block requests to "user/" models with 404', async () => {
      await import('./entry');
      const interceptedFetch = self.fetch;

      const urls = [
        'https://example.com/models/user/my-model/config.json',
        'models/user/my-model/tokenizer.json',
        'user/my-model/model.onnx',
      ];

      for (const url of urls) {
        const res = await interceptedFetch(url);
        expect(res.status).toBe(404);
        expect(res.statusText).toContain('Local Only');
        expect(originalFetchMock).not.toHaveBeenCalled();
      }
    });

    it('should block requests to "local/" models with 404', async () => {
      await import('./entry');
      const interceptedFetch = self.fetch;

      const res = await interceptedFetch('local/test/model.bin');
      expect(res.status).toBe(404);
      expect(res.statusText).toContain('Local Only');
      expect(originalFetchMock).not.toHaveBeenCalled();
    });

    it('should convert HTML responses to 404 for model files (SPA fallback)', async () => {
      await import('./entry');
      const interceptedFetch = self.fetch;

      originalFetchMock.mockImplementation(async (input: RequestInfo | URL) => {
        const urlString = input.toString();
        // Simulate missing .gz file to force fallback to original
        if (urlString.endsWith('.gz')) {
          return new Response('Not Found', { status: 404 });
        }
        return new Response('<!DOCTYPE html>...', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        });
      });

      const modelFiles = [
        'https://hf.co/model/config.json',
        'https://hf.co/model/model.onnx',
        'https://hf.co/model/tokenizer.json',
        'https://hf.co/model/weights.bin',
        'https://hf.co/model/module.wasm',
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
      await import('./entry');
      const interceptedFetch = self.fetch;

      const mockRes = new Response('{}', { status: 200 });
      originalFetchMock.mockResolvedValue(mockRes);

      const url = 'https://hf.co/model/config.json';
      const res = await interceptedFetch(url);

      expect(res).toBe(mockRes);
      expect(res.status).toBe(200);
    });

    it('should allow normal HTML pages (not model files)', async () => {
      await import('./entry');
      const interceptedFetch = self.fetch;

      const mockRes = new Response('<html>ok</html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
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
    let mockGenerate: ReturnType<typeof vi.fn>;

    beforeEach(async () => {
      // Outer beforeEach already ran vi.resetModules() + vi.clearAllMocks()
      capturedCallback = undefined;
      tokensToEmit = [];

      const tfMock = await import('@huggingface/transformers');

      (tfMock.TextStreamer as any).mockImplementation(
        function(this: unknown, _tok: unknown, opts: { callback_function: (output: string) => void }) {
          capturedCallback = opts.callback_function;
        },
      );

      mockApplyTemplate = vi.fn().mockReturnValue({ input_ids: [1, 2, 3] });
      mockGenerate = vi.fn().mockImplementation(async () => {
        for (const token of tokensToEmit) capturedCallback?.(token);
        return { past_key_values: {} };
      });
      const mockModel = {
        generate: mockGenerate,
        dispose: vi.fn(),
        device: 'webgpu',
        config: {
          model_type: 'example',
          is_encoder_decoder: false,
          max_position_embeddings: 128_000,
        },
      };

      (tfMock.AutoModelForCausalLM.from_pretrained as any).mockResolvedValue(mockModel);
      (tfMock.AutoTokenizer.from_pretrained as any).mockResolvedValue({
        apply_chat_template: mockApplyTemplate,
      });

      await import('./entry');
      const comlink = await import('comlink');
      workerObj = (comlink.expose as any).mock.calls[0][0];
      await workerObj.loadModel('standard-model', vi.fn());
    });

    it('uses the remaining declared model context instead of a fixed 1024-token fallback', async () => {
      mockApplyTemplate.mockImplementation((_messages, options) => {
        if (options?.tokenize === false) return '<|im_start|>assistant\n';
        return { input_ids: { dims: [1, 2_048] } };
      });

      await workerObj.generateText([], vi.fn(), vi.fn(), undefined, undefined);

      expect(mockGenerate).toHaveBeenCalledWith(expect.objectContaining({
        max_new_tokens: 125_952,
      }));
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

    it('waits for the remote tool-call callback before resolving generation', async () => {
      const payload = JSON.stringify({ name: 'search', arguments: { query: 'hello' } });
      tokensToEmit = [`<tool_call>${payload}</tool_call>`];
      const tools: WorkerToolDefinition[] = [
        { type: 'function', function: { name: 'search', description: 'Search', parameters: {} } },
      ];

      let releaseToolCalls!: () => void;
      const toolCallsDelivered = new Promise<void>(resolve => {
        releaseToolCalls = resolve;
      });
      const onToolCalls = vi.fn(() => toolCallsDelivered);
      let generationResolved = false;

      const generation = workerObj
        .generateText([], vi.fn(), onToolCalls, undefined, tools)
        .then(() => {
          generationResolved = true;
        });

      await vi.waitFor(() => expect(onToolCalls).toHaveBeenCalledOnce());
      await Promise.resolve();
      expect(generationResolved).toBe(false);

      releaseToolCalls();
      await generation;
      expect(generationResolved).toBe(true);
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

    it('restores a prompt-owned <think> opening tag without model-specific routing', async () => {
      mockApplyTemplate.mockImplementation((_messages, options) => {
        if (options?.tokenize !== false) return { input_ids: [1, 2, 3] };
        if (options?.add_generation_prompt === false) {
          return `\
<|im_start|>user
question<|im_end|>
`;
        }
        return `\
<|im_start|>user
question<|im_end|>
<|im_start|>assistant
<think>
`;
      });
      tokensToEmit = ['reasoning', '</thi', 'nk>', 'answer'];

      const rawTokenLog = vi.spyOn(console, 'debug').mockImplementation(() => {});
      try {
        const onChunk = vi.fn();
        await workerObj.generateText([], onChunk, vi.fn(), undefined, undefined);

        const emitted = (onChunk.mock.calls as [string][]).map(([chunk]) => chunk).join('');
        expect(emitted).toBe('<think>reasoning</think>answer');
        const rawChunks = rawTokenLog.mock.calls
          .filter(([label]) => label === '[transformersJsWorker] raw token:')
          .map(([, chunk]) => chunk);
        expect(rawChunks).toEqual(tokensToEmit.map(token => JSON.stringify(token)));
        expect(rawChunks).not.toContain(JSON.stringify('<think>'));
      } finally {
        rawTokenLog.mockRestore();
      }
    });

    it('does not change standard output when the rendered generation prompt does not end in <think>', async () => {
      mockApplyTemplate.mockImplementation((_messages, options) => {
        if (options?.tokenize !== false) return { input_ids: [1, 2, 3] };
        if (options?.add_generation_prompt === false) {
          return `\
<|im_start|>user
literal <think> text<|im_end|>
`;
        }
        return `\
<|im_start|>user
literal <think> text<|im_end|>
<|im_start|>assistant
`;
      });
      tokensToEmit = ['ordinary ', 'answer'];

      const onChunk = vi.fn();
      await workerObj.generateText([], onChunk, vi.fn(), undefined, undefined);

      const emitted = (onChunk.mock.calls as [string][]).map(([chunk]) => chunk).join('');
      expect(emitted).toBe('ordinary answer');
    });

    it('falls back to the existing standard stream when prompt observation fails', async () => {
      mockApplyTemplate.mockImplementation((_messages, options) => {
        if (options?.tokenize === false) throw new Error('render observation unavailable');
        return { input_ids: [1, 2, 3] };
      });
      tokensToEmit = ['ordinary answer'];

      const onChunk = vi.fn();
      await workerObj.generateText([], onChunk, vi.fn(), undefined, undefined);

      expect(onChunk).toHaveBeenCalledOnce();
      expect(onChunk).toHaveBeenCalledWith('ordinary answer');
    });

    it('parses a template-declared delimited Pythonic tool protocol and preserves continuation shape', async () => {
      mockApplyTemplate.mockImplementation((messages, options) => {
        const messageList = messages as Array<Record<string, any>>;
        const probeToolCall = messageList
          .flatMap(message => Array.isArray(message['tool_calls']) ? message['tool_calls'] : [])
          .find(toolCall => toolCall?.function?.name === '__naidan_tool_protocol_probe__');

        if (options?.tokenize === false && probeToolCall) {
          return `\
<|startoftext|><|im_start|>assistant
<|tool_call_start|>[__naidan_tool_protocol_probe__(value='__naidan_tool_protocol_probe_value__')]<|tool_call_end|><|im_end|>
<|im_start|>tool
__naidan_tool_protocol_probe_result__<|im_end|>
<|im_start|>assistant
<think>
`;
        }
        if (options?.tokenize === false && options?.add_generation_prompt === false) {
          return `\
<|startoftext|><|im_start|>user
Use shell tools.<|im_end|>
`;
        }
        if (options?.tokenize === false) {
          return `\
<|startoftext|><|im_start|>user
Use shell tools.<|im_end|>
<|im_start|>assistant
<think>
`;
        }

        for (const message of messageList) {
          for (const toolCall of message['tool_calls'] ?? []) {
            if (typeof toolCall.function.arguments === 'string') {
              throw new Error('Tool call arguments must be a mapping');
            }
          }
        }
        return { input_ids: [1, 2, 3] };
      });

      tokensToEmit = [
        'The user wants shell access. ',
        "directory.</think><|tool_call_start|>[shell_execute(shell_script='ls ",
        '-la ',
        "/workspace'), ",
        "shell_execute(shell_script='ls ",
        '-la ',
        "/tmp')]<|tool_call_end|>",
      ];
      const tools: WorkerToolDefinition[] = [
        { type: 'function', function: { name: 'shell_execute', description: 'Run shell', parameters: {} } },
      ];
      const onChunk = vi.fn();
      const onToolCalls = vi.fn();
      const rawTokenLog = vi.spyOn(console, 'debug').mockImplementation(() => {});
      let rawGeneratedText = '';
      try {
        await workerObj.generateText(
          [{ role: 'user', content: 'Use shell tools.' }],
          onChunk,
          onToolCalls,
          undefined,
          tools,
        );
        rawGeneratedText = rawTokenLog.mock.calls
          .filter(([label]) => label === '[transformersJsWorker] raw token:')
          .map(([, chunk]) => JSON.parse(chunk as string) as string)
          .join('');
      } finally {
        rawTokenLog.mockRestore();
      }

      expect(rawGeneratedText).toContain("<|tool_call_start|>[shell_execute(shell_script='ls -la /workspace')");
      expect(rawGeneratedText).toContain('<|tool_call_end|>');
      expect(onToolCalls).toHaveBeenCalledOnce();
      const [calls] = onToolCalls.mock.calls[0]!;
      expect(calls.map((call: any) => ({
        name: call.function.name,
        arguments: JSON.parse(call.function.arguments),
      }))).toEqual([
        { name: 'shell_execute', arguments: { shell_script: 'ls -la /workspace' } },
        { name: 'shell_execute', arguments: { shell_script: 'ls -la /tmp' } },
      ]);
      const emitted = (onChunk.mock.calls as [string][]).map(([chunk]) => chunk).join('');
      expect(emitted).toBe('<think>The user wants shell access. directory.</think>');
      expect(emitted).not.toContain('<|tool_call_start|>');
      const firstTurnProtocolProbes = mockApplyTemplate.mock.calls.filter(([probeMessages]) => (
        (probeMessages as Array<Record<string, any>>).some(message => (
          (message['tool_calls'] as Array<Record<string, any>> | undefined)?.some(toolCall => (
            toolCall?.['function']?.['name'] === '__naidan_tool_protocol_probe__'
          ))
        ))
      ));
      expect(firstTurnProtocolProbes).toHaveLength(1);

      mockApplyTemplate.mockClear();
      tokensToEmit = ['final answer'];
      await workerObj.generateText(
        [
          { role: 'user', content: 'Use shell tools.' },
          { role: 'assistant', content: emitted, tool_calls: calls },
          { role: 'tool', tool_call_id: calls[0].id, content: 'workspace result' },
          { role: 'tool', tool_call_id: calls[1].id, content: 'tmp result' },
        ],
        vi.fn(),
        vi.fn(),
        undefined,
        tools,
      );

      const tokenizingCall = mockApplyTemplate.mock.calls.find(([, options]) => options?.tokenize !== false);
      expect(tokenizingCall).toBeDefined();
      const [continuationMessages] = tokenizingCall!;
      const continuationMessageList = continuationMessages as Array<Record<string, any>>;
      expect(continuationMessageList.some(message => (
        (message['tool_calls'] as Array<Record<string, any>> | undefined)?.some(toolCall => (
          toolCall?.['function']?.['name'] === '__naidan_tool_protocol_probe__'
        ))
      ))).toBe(false);
      const assistantMessage = continuationMessageList.find(message => message['role'] === 'assistant');
      expect(assistantMessage?.['tool_calls']).toEqual([
        expect.objectContaining({ function: { name: 'shell_execute', arguments: { shell_script: 'ls -la /workspace' } } }),
        expect.objectContaining({ function: { name: 'shell_execute', arguments: { shell_script: 'ls -la /tmp' } } }),
      ]);
      expect(continuationMessageList.filter(message => message['role'] === 'tool')).toEqual([
        expect.objectContaining({ tool_call_id: calls[0].id, content: 'workspace result' }),
        expect.objectContaining({ tool_call_id: calls[1].id, content: 'tmp result' }),
      ]);
    });

    it('passes tools to apply_chat_template for standard models', async () => {
      tokensToEmit = [];
      const tools: WorkerToolDefinition[] = [
        { type: 'function', function: { name: 'fn', description: 'Fn', parameters: {} } },
      ];

      await workerObj.generateText([], vi.fn(), vi.fn(), undefined, tools);

      const actualGenerationCall = mockApplyTemplate.mock.calls.find(([, options]) => options?.return_dict === true);
      expect(actualGenerationCall).toBeDefined();
      expect(actualGenerationCall?.[1]).toMatchObject({ tools });
    });
  });

  describe('generateText — Qwen3.5 model tool calls', () => {
    let workerObj: any;
    let capturedCallback: ((output: string) => void) | undefined;
    let tokensToEmit: string[];
    let mockApplyTemplate: ReturnType<typeof vi.fn>;
    let mockCallableTokenizer: ReturnType<typeof vi.fn>;
    let mockProcessor: ReturnType<typeof vi.fn>;
    let mockModel: {
      generate: ReturnType<typeof vi.fn>,
      dispose: ReturnType<typeof vi.fn>,
      device: string,
      config: {
        model_type: string,
      },
    };

    beforeEach(async () => {
      capturedCallback = undefined;
      tokensToEmit = [];

      const tfMock = await import('@huggingface/transformers');

      (tfMock.TextStreamer as any).mockImplementation(
        function(this: unknown, _tok: unknown, opts: { callback_function: (output: string) => void }) {
          capturedCallback = opts.callback_function;
        },
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
        { apply_chat_template: mockApplyTemplate },
      );
      mockProcessor = Object.assign(
        vi.fn().mockResolvedValue({
          input_ids: [7, 8, 9],
          attention_mask: [1, 1, 1],
        }),
        {
          tokenizer: mockCallableTokenizer,
          batch_decode: vi.fn().mockReturnValue(['prompt-history']),
        },
      );
      (tfMock.AutoProcessor.from_pretrained as any).mockResolvedValue(mockProcessor);

      await import('./entry');
      const comlink = await import('comlink');
      workerObj = (comlink.expose as any).mock.calls[0][0];
      await workerObj.loadModel('onnx-community/Qwen3.5-2B-ONNX', vi.fn());
    });

    it('observes the existing Qwen3.5 reasoning effort prompt differential', async () => {
      Object.assign(mockCallableTokenizer, {
        decode: vi.fn(() => 'reasoning output'),
      });
      mockProcessor.mockImplementation(async (prompt: string) => {
        if (prompt.includes(`\
<think>

</think>`)) {
          return {
            input_ids: { data: BigInt64Array.from([7n, 0n]) },
            attention_mask: { data: BigInt64Array.from([1n, 1n]) },
          };
        }
        if (prompt.includes('<think>\n')) {
          return {
            input_ids: { data: BigInt64Array.from([7n, 1n]) },
            attention_mask: { data: BigInt64Array.from([1n, 1n]) },
          };
        }
        return {
          input_ids: { data: BigInt64Array.from([7n, 2n]) },
          attention_mask: { data: BigInt64Array.from([1n, 1n]) },
        };
      });
      mockModel.generate.mockImplementation(async (inputs: { input_ids: { data: BigInt64Array } }) => ({
        past_key_values: { kv: true },
        sequences: { data: BigInt64Array.from([...inputs.input_ids.data, 99n]) },
      }));

      const observation = await workerObj.runModelSupportInvestigationScenario(
        {
          modelId: 'onnx-community/Qwen3.5-2B-ONNX',
          resolvedRevision: 'a'.repeat(40),
          candidate: { device: 'webgpu', dtype: 'q4' },
          messages: [{ role: 'user', content: 'Answer briefly.' }],
          followUpMessage: { role: 'user', content: 'Continue.' },
          toolResultContinuation: undefined,
          maxNewTokens: 16,
        },
        vi.fn(),
      );

      expect(observation.reasoning).toMatchObject({
        status: 'observed',
        source: 'existing-production-strategy',
        strategy: 'qwen3_5',
        disabledEffort: 'none',
        enabledEffort: 'high',
        disabledTurn: {
          inputTokenIds: [7, 0],
          generatedTokenIds: [99],
          effectiveGenerationConfig: expect.objectContaining({ maxNewTokens: 1 }),
        },
        enabledTurn: {
          inputTokenIds: [7, 1],
          generatedTokenIds: [99],
          effectiveGenerationConfig: expect.objectContaining({ maxNewTokens: 1 }),
        },
        inputTokenExactMatch: false,
        firstInputMismatchIndex: 1,
      });
      const prompts = mockProcessor.mock.calls.map(call => String(call[0]));
      expect(prompts.some(prompt => prompt.includes(`\
<think>

</think>`))).toBe(true);
      expect(prompts.some(prompt => prompt.includes('<think>\n') && !prompt.includes('</think>'))).toBe(true);
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

    it('parses Qwen3.5 relaxed JSON-like tool calls', async () => {
      tokensToEmit = [
        '<tool_call>\n',
        '{"name": shell_execute, "arguments": {"shell_script": "ls -la /tmp/sample-dir | head -5", "stdout_limit": 1024, "stderr_limit": 1024, "timeout_ms": 5000}}\n',
        '</tool_call>',
      ];

      const onChunk = vi.fn();
      const onToolCalls = vi.fn();
      const tools: WorkerToolDefinition[] = [
        { type: 'function', function: { name: 'shell_execute', description: 'Run shell', parameters: {} } },
      ];

      await workerObj.generateText([], onChunk, onToolCalls, undefined, tools);

      expect(onToolCalls).toHaveBeenCalledOnce();
      const [calls] = onToolCalls.mock.calls[0]!;
      expect(calls).toHaveLength(1);
      expect(calls[0].function.name).toBe('shell_execute');
      expect(JSON.parse(calls[0].function.arguments)).toEqual({
        shell_script: 'ls -la /tmp/sample-dir | head -5',
        stdout_limit: 1024,
        stderr_limit: 1024,
        timeout_ms: 5000,
      });
      expect(onChunk).not.toHaveBeenCalledWith(expect.stringContaining('<tool_call>'));
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
        tools,
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
        tools,
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
        tools,
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
            content: `\
Exit Code: 0
STDOUT:
file-a
`,
          },
        ],
        vi.fn(),
        vi.fn(),
        undefined,
        tools,
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
        undefined,
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
        undefined,
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
        undefined,
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
        undefined,
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
        tools,
      );

      const emitted = (onChunk.mock.calls as [string][]).map(([chunk]) => chunk).join('');
      expect(emitted).toBe('helloworld');
    });
  });

  describe('generateText — Gemma 4 multimodal chat', () => {
    let workerObj: any;
    let capturedCallback: ((output: string) => void) | undefined;
    let tokensToEmit: string[];
    let mockProcessor: ReturnType<typeof vi.fn> & {
      tokenizer: {
        apply_chat_template: ReturnType<typeof vi.fn>,
        decode: ReturnType<typeof vi.fn>,
      },
      apply_chat_template: ReturnType<typeof vi.fn>,
    };
    let mockModel: {
      generate: ReturnType<typeof vi.fn>,
      dispose: ReturnType<typeof vi.fn>,
      device: string,
      config: {
        model_type: string,
        is_encoder_decoder: boolean,
      },
    };

    beforeEach(async () => {
      capturedCallback = undefined;
      tokensToEmit = [];

      const tfMock = await import('@huggingface/transformers');

      (tfMock.TextStreamer as any).mockImplementation(
        function(this: unknown, _tok: unknown, opts: { callback_function: (output: string) => void }) {
          capturedCallback = opts.callback_function;
        },
      );
      (tfMock.RawImage.read as any).mockResolvedValue({ kind: 'raw-image' });

      mockModel = {
        generate: vi.fn().mockImplementation(async () => {
          for (const token of tokensToEmit) capturedCallback?.(token);
          return { past_key_values: {} };
        }),
        dispose: vi.fn(),
        device: 'webgpu',
        config: {
          model_type: 'gemma4',
          is_encoder_decoder: false,
        },
      };

      mockProcessor = Object.assign(
        vi.fn().mockResolvedValue({
          input_ids: [7, 8, 9],
          attention_mask: [1, 1, 1],
          pixel_values: ['pixels'],
          image_position_ids: ['positions'],
        }),
        {
          tokenizer: {
            apply_chat_template: vi.fn(),
            decode: vi.fn(() => 'synthetic image output'),
          },
          apply_chat_template: vi.fn().mockReturnValue('gemma4 prompt'),
        },
      );

      (tfMock.AutoModelForImageTextToText.from_pretrained as any).mockResolvedValue(mockModel);
      (tfMock.AutoProcessor.from_pretrained as any).mockResolvedValue(mockProcessor);

      await import('./entry');
      const comlink = await import('comlink');
      workerObj = (comlink.expose as any).mock.calls[0][0];
      await workerObj.loadModel('onnx-community/gemma-4-E2B-it-ONNX', vi.fn());
    });

    it('uses the processor chat template and forwards multimodal inputs to model.generate', async () => {
      tokensToEmit = ['hello'];

      await workerObj.generateText(
        [{
          role: 'user',
          content: [
            { type: 'text', text: 'Describe this image' },
            { type: 'image_url', image_url: { url: 'https://example.com/cat.png' } },
          ],
        }],
        vi.fn(),
        vi.fn(),
        undefined,
        undefined,
      );

      expect(mockProcessor.apply_chat_template).toHaveBeenCalledWith(
        [{
          role: 'user',
          content: [
            { type: 'text', text: 'Describe this image' },
            { type: 'image' },
          ],
        }],
        { add_generation_prompt: true },
      );
      expect(mockProcessor).toHaveBeenCalledWith(
        'gemma4 prompt',
        [{ kind: 'raw-image' }],
        null,
        { add_special_tokens: false },
      );
      expect(mockModel.generate).toHaveBeenCalledWith(expect.objectContaining({
        input_ids: [7, 8, 9],
        attention_mask: [1, 1, 1],
        pixel_values: ['pixels'],
        image_position_ids: ['positions'],
        past_key_values: null,
      }));
    });

    it('runs the fixed synthetic image through the existing Gemma 4 Production strategy', async () => {
      const tfMock = await import('@huggingface/transformers');
      const fixtureImageBytes = Uint8Array.from(
        atob(MODEL_SUPPORT_INVESTIGATION_MULTIMODAL_FIXTURE.dataUrl.split(',')[1]!),
        character => character.charCodeAt(0),
      );
      originalFetchMock.mockResolvedValue(new Response(fixtureImageBytes, {
        status: 200,
        headers: { 'Content-Type': 'image/png' },
      }));
      const tensor = ({ data, type, dims, location }: {
        data: BigInt64Array | Float32Array,
        type: string,
        dims: number[],
        location: string,
      }) => ({ data, type, dims, location });
      mockProcessor.mockResolvedValue({
        input_ids: tensor({ data: BigInt64Array.from([7n, 8n]), type: 'int64', dims: [1, 2], location: 'cpu' }),
        attention_mask: tensor({ data: BigInt64Array.from([1n, 1n]), type: 'int64', dims: [1, 2], location: 'cpu' }),
        pixel_values: tensor({ data: Float32Array.from([0]), type: 'float32', dims: [1, 3, 1, 1], location: 'gpu-buffer' }),
      });
      mockModel.generate.mockImplementation(async (inputs: { input_ids: { data: BigInt64Array } }) => ({
        past_key_values: {},
        sequences: { data: BigInt64Array.from([...inputs.input_ids.data, 99n]) },
      }));

      const observation = await workerObj.runModelSupportInvestigationScenario(
        {
          modelId: 'onnx-community/gemma-4-E2B-it-ONNX',
          resolvedRevision: 'a'.repeat(40),
          candidate: { device: 'webgpu', dtype: 'q4' },
          messages: [{ role: 'user', content: 'Answer briefly.' }],
          followUpMessage: { role: 'user', content: 'Continue.' },
          toolResultContinuation: undefined,
          multimodalFixture: MODEL_SUPPORT_INVESTIGATION_MULTIMODAL_FIXTURE,
          maxNewTokens: 16,
        },
        vi.fn(),
      );

      expect(tfMock.RawImage.read).toHaveBeenCalledOnce();
      const rawImageBlob = vi.mocked(tfMock.RawImage.read).mock.calls[0]?.[0];
      expect(rawImageBlob).toBeDefined();
      expect(rawImageBlob).toMatchObject({
        size: MODEL_SUPPORT_INVESTIGATION_MULTIMODAL_FIXTURE.byteLength,
        type: MODEL_SUPPORT_INVESTIGATION_MULTIMODAL_FIXTURE.mimeType,
      });
      expect(observation.multimodal).toMatchObject({
        status: 'observed',
        source: 'fixed-synthetic-fixture-and-existing-production-strategy',
        strategy: 'gemma4',
        fixture: {
          fixtureId: 'single-transparent-pixel-png-v1',
          sha256: MODEL_SUPPORT_INVESTIGATION_MULTIMODAL_FIXTURE.sha256,
          byteLength: 68,
          maxNewTokens: 1,
        },
        turn: {
          inputKeys: ['attention_mask', 'input_ids', 'pixel_values'],
          inputTensors: [
            { name: 'attention_mask', dtype: 'int64', dims: [1, 2], location: 'cpu' },
            { name: 'input_ids', dtype: 'int64', dims: [1, 2], location: 'cpu' },
            { name: 'pixel_values', dtype: 'float32', dims: [1, 3, 1, 1], location: 'gpu-buffer' },
          ],
          generatedTokenIds: [99],
          effectiveGenerationConfig: { maxNewTokens: 1 },
        },
      });
      expect(observation.multimodal).not.toHaveProperty('fixture.dataUrl');
    });

    it('does not inject tool definitions into the Gemma 4 chat template', async () => {
      const tools: WorkerToolDefinition[] = [
        { type: 'function', function: { name: 'shell_execute', description: 'Run shell', parameters: {} } },
      ];

      await workerObj.generateText(
        [{ role: 'user', content: 'list files' }],
        vi.fn(),
        vi.fn(),
        undefined,
        tools,
      );

      expect(mockProcessor.apply_chat_template).toHaveBeenCalledWith(
        [{ role: 'user', content: 'list files' }],
        { add_generation_prompt: true },
      );
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
        },
      );

      mockApplyTemplate = vi.fn().mockReturnValue({ input_ids: [1, 2, 3] });
      // GPT-OSS tokenizer must be callable for buildGptOssToolResultTokens
      mockCallableTokenizer = Object.assign(
        vi.fn().mockReturnValue({ input_ids: [1] }),
        { apply_chat_template: mockApplyTemplate },
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

      await import('./entry');
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
        [SIMPLE_TOOL],
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
        [SIMPLE_TOOL],
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
        expect.objectContaining({ add_special_tokens: false }),
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
