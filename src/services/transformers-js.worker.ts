import * as Comlink from 'comlink';
import {
  AutoProcessor,
  AutoTokenizer,
  AutoModelForCausalLM,
  InterruptableStoppingCriteria,
  env,
  type PreTrainedModel,
  type PreTrainedTokenizer,
} from '@huggingface/transformers';
import type { ChatMessage, LmParameters, ToolCall } from '@/models/types';
import type { ProgressInfo, ModelLoadResult, ITransformersJsWorker, WorkerToolDefinition } from './transformers-js.types';
import {
  isQwen3_5Model,
} from './transformers-js-qwen3_5';
import {
  selectGenerationStrategy,
  type WorkerGenerationRuntimeState,
} from './transformers-js-generation-strategies';
import { urlToPath, writeToOpfs } from './transformers-js.utils';

/**
 * Internal interface for properties found on Transformers.js model instances
 */
interface ModelInternals {
  device?: string;
  config?: {
    model_type?: string;
  };
}

interface Qwen3_5ProcessorLike {
  (text: string): Promise<Record<string, unknown>>;
  tokenizer: PreTrainedTokenizer;
  batch_decode(sequences: unknown, options: { skip_special_tokens: boolean }): string[];
}

const QWEN_DEBUG_PREFIX = '[naidan-qwen-debug]';

// Intercept fetch to handle SPA 404 fallback and enforce local-only constraints
const originalFetch = self.fetch;
self.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  let urlString = '';
  if (typeof input === 'string') {
    urlString = input;
  } else if (input instanceof Request) {
    urlString = input.url;
  } else if (input instanceof URL) {
    urlString = input.toString();
  } else {
    urlString = String(input);
  }

  // 1. Enforce "No Fetch" for local user models
  // These should exist in OPFS. If we are here, they are missing from OPFS.
  // We strictly return 404 without hitting the server/network.
  if (/(^|\/)models\/(user|local)\//.test(urlString) || /^(user|local)\//.test(urlString)) {
    console.debug(`[transformers-worker] Blocking fetch for local model: ${urlString}`);
    return new Response(null, { status: 404, statusText: 'Not Found (Local Only)' });
  }

  // 2. Perform actual fetch (with .wasm.gz fallback for Cloudflare Pages 26MB limit)
  if (urlString.endsWith('.wasm')) {
    try {
      // Try fetching the .gz version first
      const gzUrl = `${urlString}.gz`;
      console.debug(`[transformers-worker] Attempting to fetch gzipped WASM: ${gzUrl}`);
      const gzResponse = await originalFetch(gzUrl, init);

      if (gzResponse.ok) {
        console.debug(`[transformers-worker] Successfully fetched gzipped WASM: ${gzUrl}`);
        const ds = new DecompressionStream('gzip');
        const decompressedStream = gzResponse.body?.pipeThrough(ds);

        // Create new headers, stripping Content-Length/Encoding as they change
        const headers = new Headers(gzResponse.headers);
        headers.set('Content-Type', 'application/wasm');
        headers.delete('Content-Length');
        headers.delete('Content-Encoding');

        return new Response(decompressedStream, {
          status: 200,
          statusText: 'OK',
          headers
        });
      }
    } catch (e) {
      console.warn(`[transformers-worker] Failed to fetch gzipped WASM, falling back to original:`, e);
    }
  }

  const response = await originalFetch(input, init);

  // 3. Handle SPA 404 Fallback (Server returning HTML for JSON/Binary)
  // This helps when transformers.js checks for local existence of remote models via relative paths.
  if (response.status === 200) {
    const contentType = response.headers.get('content-type');
    if (contentType && contentType.includes('text/html')) {
      // If we are requesting a JSON/Binary file but got HTML, it's a 404 fallback
      if (urlString.includes('/models/') ||
          urlString.endsWith('.json') ||
          urlString.endsWith('.onnx') ||
          urlString.endsWith('.bin') ||
          urlString.endsWith('.wasm')) {

        // Double check it's not actually an HTML file we wanted
        if (!urlString.endsWith('.html')) {
          console.warn(`[transformers-worker] Intercepted HTML response for ${urlString}. Treating as 404.`);
          return new Response(null, { status: 404, statusText: 'Not Found' });
        }
      }
    }
  }
  return response;
};

// Configure environment
env.allowLocalModels = true;
env.allowRemoteModels = true;
env.useBrowserCache = false;
if (env.backends.onnx.wasm) {
  env.backends.onnx.wasm.simd = true;
  // Use more threads if available, but cap it to avoid excessive memory usage
  env.backends.onnx.wasm.numThreads = Math.min(4, navigator.hardwareConcurrency || 1);
  // Disable proxy to avoid extra worker overhead since we are already in a worker
  env.backends.onnx.wasm.proxy = false;
}

// Reduce log verbosity for performance
env.backends.onnx.logLevel = 'error';

/**
 * Custom cache implementation that uses OPFS inside Worker.
 */
const opfsCache = {
  async match(request: string | Request): Promise<Response | undefined> {
    const urlString = typeof request === 'string' ? request : request.url;
    if (typeof request !== 'string' && request.method && request.method !== 'GET') return undefined;

    const path = urlToPath({ url: urlString });
    if (!path) return undefined;

    const pathParts = path.split('/');
    const fileName = pathParts.pop()!;

    try {
      const root = await navigator.storage.getDirectory();
      let currentDir = root;
      for (const part of pathParts) {
        if (!part) continue;
        currentDir = await currentDir.getDirectoryHandle(part, { create: false });
      }

      // Check for completion marker first
      const markerName = `.${fileName}.complete`;
      await currentDir.getFileHandle(markerName, { create: false });

      const fileHandle = await currentDir.getFileHandle(fileName);
      const file = await fileHandle.getFile();

      if (file.size === 0) {
        await currentDir.removeEntry(fileName);
        await currentDir.removeEntry(markerName);
        return undefined;
      }

      console.log(`[opfsCache] CACHE HIT: ${path} (${file.size} bytes)`);
      return new Response(file.stream(), {
        headers: {
          'Content-Type': urlString.endsWith('.json') ? 'application/json' : 'application/octet-stream',
          'Content-Length': file.size.toString(),
          'X-Cache-Hit': 'OPFS'
        }
      });
    } catch {
      console.log(`[opfsCache] CACHE MISS: ${path}`);
      return undefined;
    }
  },

  async put(request: string | Request, response: Response): Promise<void> {
    const urlString = typeof request === 'string' ? request : request.url;
    const path = urlToPath({ url: urlString });
    if (!path) return;

    if (response.status !== 200) {
      console.warn(`[opfsCache] SKIPPING CACHE (status ${response.status}): ${urlString}`);
      return;
    }

    const contentType = response.headers.get('Content-Type') || '';
    if (contentType.includes('text/html')) {
      const msg = `[opfsCache] ERROR: Detected HTML response for model request! Possible 404 fallback from server. URL: ${urlString}`;
      console.error(msg);
      throw new Error(msg);
    }

    try {
      console.log(`[opfsCache] WRITING: ${path}...`);
      await writeToOpfs({ path, response });
      console.log(`[opfsCache] COMPLETED: ${path}`);
    } catch (err) {
      console.error(`[opfsCache] FAILED TO SAVE: ${path}:`, err);
      throw err;
    }
  }
};

// Enable custom cache
env.useCustomCache = true;
env.customCache = opfsCache;

if (env.backends.onnx.wasm) {
  env.backends.onnx.wasm.wasmPaths = '/transformers/';
}

// Singleton state
let model: PreTrainedModel | null = null;
let tokenizer: PreTrainedTokenizer | null = null;
let qwen3_5Processor: Qwen3_5ProcessorLike | null = null;
let activeModelId: string | null = null;
const generationRuntimeState: WorkerGenerationRuntimeState = {
  activeModelId: null,
  qwen3_5Processor: null,
  gptOssPastKeyValues: null,
  qwen3_5PastKeyValues: null,
  qwen3_5ConversationState: undefined,
};
const stoppingCriteria = new InterruptableStoppingCriteria();

async function withModelAccessMode<T>({
  isLocal,
  run,
}: {
  isLocal: boolean;
  run: () => Promise<T>;
}): Promise<T> {
  const previousAllowLocalModels = env.allowLocalModels;
  env.allowLocalModels = isLocal;
  try {
    return await run();
  } finally {
    env.allowLocalModels = previousAllowLocalModels;
  }
}

function debugLog({ event, details }: { event: string; details: Record<string, unknown> }): void {
  console.log(`${QWEN_DEBUG_PREFIX} ${event}`, {
    at: new Date().toISOString(),
    ...details,
  });
}

function clearQwen3_5ContinuationState(): void {
  generationRuntimeState.qwen3_5ConversationState = undefined;
}

// ---------------------------------------------------------------------------

const transformersJsWorker: ITransformersJsWorker = {
  async downloadModel(modelId: string, progressCallback: (x: ProgressInfo) => void) {
    console.log('[transformersJsWorker] Starting downloadModel:', modelId);
    let cleanModelId = modelId;
    if (cleanModelId.startsWith('hf.co/')) cleanModelId = cleanModelId.substring(6);
    else if (cleanModelId.startsWith('https://huggingface.co/')) cleanModelId = cleanModelId.substring(23);

    const isLocal = cleanModelId.startsWith('user/');

    await withModelAccessMode({
      isLocal,
      run: async () => {
        // Downloading should only warm the cache. Session creation during download
        // can poison the active runtime if ORT rejects a model/operator combination.
        await AutoTokenizer.from_pretrained(cleanModelId, {
          progress_callback: progressCallback,
          local_files_only: isLocal
        });
      }
    });
    console.log('[transformersJsWorker] Download complete.');
  },

  /**
   * Directly downloads model files to OPFS via streaming fetch, bypassing
   * transformers.js's internal loader to prevent Out-of-Memory (OOM) errors
   * for large assets. This is called after the scanner has identified
   * all necessary URLs.
   */
  async prefetchUrls(urls: string[], progressCallback: (x: ProgressInfo) => void): Promise<void> {
    console.log(`[transformersJsWorker] Starting prefetch of ${urls.length} URLs.`);

    for (const url of urls) {
      const path = urlToPath({ url });
      if (!path) continue;

      // Check if already in cache and complete
      try {
        const pathParts = path.split('/');
        const fileName = pathParts.pop()!;
        const root = await navigator.storage.getDirectory();
        let currentDir = root;
        for (const part of pathParts) {
          if (!part) continue;
          currentDir = await currentDir.getDirectoryHandle(part, { create: false });
        }
        await currentDir.getFileHandle(`.${fileName}.complete`, { create: false });
        console.debug(`[transformersJsWorker] Already cached: ${path}`);
        continue;
      } catch (err: unknown) {
        if (err instanceof Error && err.name !== 'NotFoundError') {
          console.warn(`[transformersJsWorker] Unexpected error checking cache for ${path}:`, err);
        }
        // Not cached or incomplete, proceed to fetch
      }

      console.log(`[transformersJsWorker] Prefetching: ${url}`);
      try {
        const response = await originalFetch(url);
        if (!response.ok) {
          console.warn(`[transformersJsWorker] Failed to fetch ${url}: ${response.statusText}`);
          continue;
        }

        const contentLength = response.headers.get('content-length');
        const total = contentLength ? parseInt(contentLength, 10) : undefined;
        let loaded = 0;

        // Create a custom stream to track progress
        const transformStream = new TransformStream({
          transform(chunk, controller) {
            loaded += chunk.length;
            progressCallback({
              status: 'progress',
              file: url.split('/').pop(),
              loaded,
              total
            });
            controller.enqueue(chunk);
          }
        });

        const progressResponse = new Response(response.body?.pipeThrough(transformStream), {
          headers: response.headers
        });

        await writeToOpfs({ path, response: progressResponse });
        console.log(`[transformersJsWorker] Prefetched and saved: ${path}`);
      } catch (err) {
        console.error(`[transformersJsWorker] Prefetch failed for ${url}:`, err);
      }
    }
  },

  async loadModel(modelId: string, progressCallback: (x: ProgressInfo) => void): Promise<ModelLoadResult> {
    console.log('[transformersJsWorker] Starting loadModel:', modelId);

    await this.unloadModel();
    activeModelId = modelId;
    generationRuntimeState.activeModelId = modelId;

    let cleanModelId = modelId;
    if (cleanModelId.startsWith('hf.co/')) cleanModelId = cleanModelId.substring(6);
    else if (cleanModelId.startsWith('https://huggingface.co/')) cleanModelId = cleanModelId.substring(23);

    const isLocal = cleanModelId.startsWith('user/');
    let loadedDevice: 'webgpu' | 'wasm' = 'wasm';

    try {
      await withModelAccessMode({
        isLocal,
        run: async () => {
          // 1. Load Model
          // We try several combinations of device and dtype to find what works on this hardware/model
          const tryLoad = async (device: 'webgpu' | 'wasm', dtype: 'q4f16' | 'q4' | undefined) => {
            const startedAt = performance.now();
            debugLog({
              event: 'worker tryLoad start',
              details: {
                activeModelId: cleanModelId,
                device,
                dtype: dtype || 'default',
              },
            });
            try {
              const loadedModel = await AutoModelForCausalLM.from_pretrained(cleanModelId, {
                dtype,
                device,
                progress_callback: progressCallback,
                local_files_only: isLocal,
              });
              loadedDevice = device;
              debugLog({
                event: 'worker tryLoad success',
                details: {
                  activeModelId: cleanModelId,
                  device,
                  dtype: dtype || 'default',
                  elapsedMs: Math.round(performance.now() - startedAt),
                },
              });
              return loadedModel;
            } catch (err) {
              debugLog({
                event: 'worker tryLoad failure',
                details: {
                  activeModelId: cleanModelId,
                  device,
                  dtype: dtype || 'default',
                  elapsedMs: Math.round(performance.now() - startedAt),
                  error: err instanceof Error ? err.message : String(err),
                },
              });
              // Wrap numeric errors so they can be handled by the retry logic
              if (typeof err === 'number') {
                throw new Error(`Numeric error ${err}`);
              }
              throw err;
            }
          };

          try {
            model = await tryLoad('webgpu', 'q4f16');
          } catch (err) {
            console.warn('[transformersJsWorker] webgpu/q4f16 failed:', err);
            try {
              model = await tryLoad('webgpu', 'q4');
            } catch (err2) {
              console.warn('[transformersJsWorker] webgpu/q4 failed:', err2);
              try {
                // Try without forced dtype (let library decide, e.g. use original fp32/fp16)
                model = await tryLoad('webgpu', undefined);
              } catch (err3) {
                console.warn('[transformersJsWorker] webgpu/default failed, falling back to wasm:', err3);
                // Last resort: standard CPU execution
                model = await tryLoad('wasm', undefined);
              }
            }
          }
          console.log('[transformersJsWorker] Model loaded successfully.');

          // 2. Load Tokenizer
          if (isQwen3_5Model({
            modelType: (model as ModelInternals | null)?.config?.model_type,
            activeModelId: cleanModelId,
          })) {
            console.log('[transformersJsWorker] Loading Qwen3.5 processor...');
            qwen3_5Processor = await AutoProcessor.from_pretrained(cleanModelId, {
              progress_callback: progressCallback,
              local_files_only: isLocal,
            }) as unknown as Qwen3_5ProcessorLike;
            generationRuntimeState.qwen3_5Processor = qwen3_5Processor;
            tokenizer = qwen3_5Processor.tokenizer;
            console.log('[transformersJsWorker] Qwen3.5 processor loaded.');
          } else {
            console.log('[transformersJsWorker] Loading tokenizer...');
            tokenizer = await AutoTokenizer.from_pretrained(cleanModelId, {
              progress_callback: progressCallback,
              local_files_only: isLocal
            });
            console.log('[transformersJsWorker] Tokenizer loaded.');
          }
        }
      });

      return {
        device: loadedDevice,
      };
    } catch (err) {
      const errorMsg = typeof err === 'number'
        ? `Low-level engine error (code ${err}). This usually means memory allocation failed or the model format is incompatible.`
        : (err instanceof Error ? err.message : String(err));

      console.error('[transformersJsWorker] Detailed load error:', err, errorMsg);
      throw new Error(errorMsg);
    }
  },

  async unloadModel() {
    if (model) {
      await model.dispose();
      model = null;
    }
    qwen3_5Processor = null;
    generationRuntimeState.qwen3_5Processor = null;
    tokenizer = null;
    generationRuntimeState.gptOssPastKeyValues = null;
    generationRuntimeState.qwen3_5PastKeyValues = null;
    clearQwen3_5ContinuationState();
    activeModelId = null;
    generationRuntimeState.activeModelId = null;
    stoppingCriteria.reset();
  },

  async interrupt() {
    stoppingCriteria.interrupt();
  },

  async resetCache() {
    generationRuntimeState.gptOssPastKeyValues = null;
    generationRuntimeState.qwen3_5PastKeyValues = null;
    clearQwen3_5ContinuationState();
    stoppingCriteria.reset();
  },

  async generateText(
    messages: ChatMessage[],
    onChunk: (chunk: string) => void,
    onToolCalls: (toolCalls: ToolCall[]) => void,
    params?: LmParameters,
    tools?: WorkerToolDefinition[]
  ): Promise<void> {
    if (!model || !tokenizer) throw new Error('Model not loaded');

    stoppingCriteria.reset();
    const generationStart = performance.now();
    const strategy = selectGenerationStrategy({
      modelType: (model as ModelInternals | null)?.config?.model_type,
      activeModelId,
      hasTools: !!tools?.length,
    });
    debugLog({
      event: 'tool routing',
      details: {
        activeModelId,
        strategy: strategy.kind,
        hasTools: !!tools?.length,
        messageRoles: messages.map(message => ({
          role: message.role,
          hasToolCalls: !!message.tool_calls?.length,
          hasToolCallId: !!message.tool_call_id,
        })),
      },
    });

    try {
      debugLog({
        event: 'calling model.generate',
        details: {
          activeModelId,
          strategy: strategy.kind,
          elapsedMs: Math.round(performance.now() - generationStart),
        },
      });
      await strategy.generate({
        model,
        tokenizer,
        messages,
        onChunk: (chunk) => {
          console.debug('[transformersJsWorker] raw token:', JSON.stringify(chunk));
          onChunk(chunk);
        },
        onToolCalls,
        params,
        tools,
        runtimeState: generationRuntimeState,
        stoppingCriteria,
        debugLog,
      });
      debugLog({
        event: 'generation complete',
        details: {
          activeModelId,
          strategy: strategy.kind,
          elapsedMs: Math.round(performance.now() - generationStart),
        },
      });
    } catch (err) {
      clearQwen3_5ContinuationState();
      generationRuntimeState.gptOssPastKeyValues = null;
      generationRuntimeState.qwen3_5PastKeyValues = null;
      console.error('[transformersJsWorker] Generation error:', err);
      throw err;
    }
  }
};

Comlink.expose(transformersJsWorker);
export type { ITransformersJsWorker as TransformersJsWorker };
