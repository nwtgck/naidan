import * as Comlink from 'comlink';
import {
  AutoTokenizer,
  AutoModelForCausalLM,
  TextStreamer,
  InterruptableStoppingCriteria,
  StoppingCriteriaList,
  env,
  type PreTrainedModel,
  type PreTrainedTokenizer,
  type Tensor
} from '@huggingface/transformers';
import type { ChatMessage, LmParameters } from '../models/types';
import type { ProgressInfo, ModelLoadResult, ITransformersJsWorker } from './transformers-js.types';
import { HarmonyStreamParser as GptOssHarmonyStreamParser } from '../utils/gpt-oss-harmony';
import { urlToPath, writeToOpfs } from './transformers-js.utils';

type ModelOutput = Record<string, unknown>;

/**
 * Internal interface for properties found on Transformers.js model instances
 */
interface ModelInternals {
  device?: string;
}

/**
 * Interface for the result of a generation call
 */
interface GenerationResult {
  past_key_values: unknown;
  sequences?: unknown;
}

/**
 * Interface for models that support text generation
 */
interface TextGenerationModel extends PreTrainedModel {
  generate(inputs: Record<string, unknown>): Promise<GenerationResult & (ModelOutput | Tensor)>;
}

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
let pastKeyValues: unknown = null;
let activeModelId: string | null = null;
const stoppingCriteria = new InterruptableStoppingCriteria();

const transformersJsWorker: ITransformersJsWorker = {
  async downloadModel(modelId: string, progressCallback: (x: ProgressInfo) => void) {
    console.log('[transformersJsWorker] Starting downloadModel:', modelId);
    let cleanModelId = modelId;
    if (cleanModelId.startsWith('hf.co/')) cleanModelId = cleanModelId.substring(6);
    else if (cleanModelId.startsWith('https://huggingface.co/')) cleanModelId = cleanModelId.substring(23);

    const isLocal = cleanModelId.startsWith('user/');

    // 1. Download Tokenizer
    await AutoTokenizer.from_pretrained(cleanModelId, {
      progress_callback: progressCallback,
      local_files_only: isLocal
    });

    // 2. Download Model weights (using same dtype to ensure correct files are cached)
    // We use device: 'wasm' here to purely fetch files without triggering WebGPU issues.
    const tempModel = await AutoModelForCausalLM.from_pretrained(cleanModelId, {
      dtype: 'q4f16' as const,
      device: 'wasm' as const,
      progress_callback: progressCallback,
      local_files_only: isLocal,
    });
    await tempModel.dispose();
    console.log('[transformersJsWorker] Download complete and model disposed.');
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

    let cleanModelId = modelId;
    if (cleanModelId.startsWith('hf.co/')) cleanModelId = cleanModelId.substring(6);
    else if (cleanModelId.startsWith('https://huggingface.co/')) cleanModelId = cleanModelId.substring(23);

    const isLocal = cleanModelId.startsWith('user/');

    try {
      // 1. Load Model
      // We try several combinations of device and dtype to find what works on this hardware/model
      const tryLoad = async (device: 'webgpu' | 'wasm', dtype: 'q4f16' | 'q4' | undefined) => {
        console.log(`[transformersJsWorker] Attempting load: device=${device}, dtype=${dtype || 'default'}`);
        try {
          return await AutoModelForCausalLM.from_pretrained(cleanModelId, {
            dtype,
            device,
            progress_callback: progressCallback,
            local_files_only: isLocal,
          });
        } catch (err) {
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
      console.log('[transformersJsWorker] Loading tokenizer...');
      tokenizer = await AutoTokenizer.from_pretrained(cleanModelId, {
        progress_callback: progressCallback,
        local_files_only: isLocal
      });
      console.log('[transformersJsWorker] Tokenizer loaded.');

      return {
        device: (model as unknown as ModelInternals)?.device || 'wasm'
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
    tokenizer = null;
    pastKeyValues = null;
    activeModelId = null;
    stoppingCriteria.reset();
  },

  async interrupt() {
    stoppingCriteria.interrupt();
  },

  async resetCache() {
    pastKeyValues = null;
    stoppingCriteria.reset();
  },

  async generateText(
    messages: ChatMessage[],
    onChunk: (chunk: string) => void,
    params?: LmParameters
  ): Promise<void> {
    if (!model || !tokenizer) throw new Error('Model not loaded');

    stoppingCriteria.reset();

    const formattedMessages = messages.map(m => ({
      role: m.role,
      content: typeof m.content === 'string' ? m.content : ''
    }));

    const inputs = tokenizer.apply_chat_template(formattedMessages, {
      add_generation_prompt: true,
      return_dict: true,
    }) as Record<string, unknown>;

    const isGptOss = activeModelId?.toLowerCase().includes('gpt-oss') ?? false;
    console.log(`[transformersJsWorker] generateText: activeModelId='${activeModelId}', isGptOss=${isGptOss}`);

    let parser: GptOssHarmonyStreamParser | null = null;
    let currentChannel = '';

    if (isGptOss) {
      parser = new GptOssHarmonyStreamParser();
    }

    const streamer = new TextStreamer(tokenizer, {
      skip_prompt: true,
      skip_special_tokens: !isGptOss, // Only skip if NOT using parser, so we catch <|channel|> etc.
      callback_function: (output: string) => {
        if (isGptOss && parser) {
          // Simple heuristic: if we see raw tokens that look like Harmony protocol, try parsing
          // Otherwise pass through. But since we need stateful parsing, we always push to parser.
          const delta = parser.push(output);

          if (!delta) return;

          switch (delta.type) {
          case 'content': {
            const msg = parser.messages[delta.messageIndex];
            const channel = msg?.channel || '';
            // Handle channel switching
            if (channel !== currentChannel) {
              if (currentChannel === 'analysis') {
                onChunk('</think>');
              }
              if (channel === 'analysis') {
                onChunk('<think>');
              }
              currentChannel = channel;
            }
            onChunk(delta.textDelta);
            break;
          }
          case 'done':
            if (currentChannel === 'analysis') {
              onChunk('</think>');
              currentChannel = '';
            }
            break;

          case 'new_message':
            break;
          default: {
            const _ex: never = delta;
            throw new Error(`Unhandled path part: ${_ex}`);
          }
          }
        } else {
          // Standard passthrough
          onChunk(output);
        }
      },
    });

    const maxNewTokens = params?.maxCompletionTokens || 1024;
    const temperature = params?.temperature ?? 0.6;
    const topP = params?.topP ?? 0.9;

    const stopping_criteria = new StoppingCriteriaList();
    stopping_criteria.push(stoppingCriteria);

    try {
      const result = await (model as unknown as TextGenerationModel).generate({
        ...inputs,
        past_key_values: pastKeyValues,
        max_new_tokens: maxNewTokens,
        temperature: temperature,
        top_p: topP,
        do_sample: temperature > 0,
        streamer,
        stopping_criteria,
        return_dict_in_generate: true,
      });

      // Ensure we close any open tags at the end
      if (currentChannel === 'analysis') {
        onChunk('</think>');
      }

      pastKeyValues = (result as GenerationResult).past_key_values;
    } catch (err) {
      console.error('[transformersJsWorker] Generation error:', err);
      throw err;
    }
  }
};

Comlink.expose(transformersJsWorker);
export type { ITransformersJsWorker as TransformersJsWorker };