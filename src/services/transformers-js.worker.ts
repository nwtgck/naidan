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
  type ModelOutput,
  type Tensor
} from '@huggingface/transformers';
import type { ChatMessage, LmParameters } from '../models/types';

/**
 * Interface for progress callback information from Transformers.js
 */
export interface ProgressInfo {
  status: string;
  progress?: number;
  loaded?: number;
  total?: number;
  name?: string;
  file?: string;
}

/**
 * Interface to extend FileSystemFileHandle with the non-standard createWritable method.
 */
interface FileSystemFileHandleWithWritable extends FileSystemFileHandle {
  createWritable(): Promise<FileSystemWritableFileStream>;
}

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

// Configure environment
env.allowLocalModels = false;
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
 * Converts a remote URL or local identifier to an OPFS-friendly file path.
 */
function urlToPath(url: string): string {
  try {
    const parsed = new URL(url);
    const pathParts = parsed.pathname.split('/').filter(p => !!p);
    
    // For huggingface.co, we keep the full path but ensure it's under models/huggingface.co
    const cleanPath = pathParts.join('/');
    return `models/${parsed.hostname}/${cleanPath}`;
  } catch {
    const parts = url.split('/').filter(p => !!p);
    if (parts[0] === 'local') {
      return `models/${parts.join('/')}`;
    }
    return `models/local/${parts.join('/')}`;
  }
}

/**
 * Custom cache implementation that uses OPFS inside Worker.
 */
const opfsCache = {
  async match(request: string | Request): Promise<Response | undefined> {
    const urlString = typeof request === 'string' ? request : request.url;
    if (typeof request !== 'string' && request.method && request.method !== 'GET') return undefined;

    const path = urlToPath(urlString);
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

      return new Response(file.stream(), {
        headers: {
          'Content-Type': urlString.endsWith('.json') ? 'application/json' : 'application/octet-stream',
          'Content-Length': file.size.toString(),
          'X-Cache-Hit': 'OPFS'
        }
      });
    } catch {
      return undefined;
    }
  },

  async put(request: string | Request, response: Response): Promise<void> {
    const urlString = typeof request === 'string' ? request : request.url;
    const path = urlToPath(urlString);
    const pathParts = path.split('/');
    const fileName = pathParts.pop()!;

    try {
      const root = await navigator.storage.getDirectory();
      let currentDir = root;
      for (const part of pathParts) {
        if (!part) continue;
        currentDir = await currentDir.getDirectoryHandle(part, { create: true });
      }

      const fileHandle = await currentDir.getFileHandle(fileName, { create: true });
      if ('createWritable' in fileHandle) {
        const writable = await (fileHandle as unknown as FileSystemFileHandleWithWritable).createWritable();
        if (response.body) {
          await response.body.pipeTo(writable);
        } else {
          const buffer = await response.arrayBuffer();
          await writable.write(buffer);
          await writable.close();
        }

        // Create completion marker after successful write/close
        await currentDir.getFileHandle(`.${fileName}.complete`, { create: true });
      }
    } catch (err) {
      console.error(`[opfsCache] Failed to save cache for ${path}:`, err);
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
const stoppingCriteria = new InterruptableStoppingCriteria();

const transformersJsWorker = {
  async downloadModel(modelId: string, progressCallback: (x: ProgressInfo) => void) {
    console.log('[transformersJsWorker] Starting downloadModel:', modelId);
    let cleanModelId = modelId;
    if (cleanModelId.startsWith('hf.co/')) cleanModelId = cleanModelId.substring(6);
    else if (cleanModelId.startsWith('https://huggingface.co/')) cleanModelId = cleanModelId.substring(23);

    const isLocal = cleanModelId.startsWith('local/');

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

  async loadModel(modelId: string, progressCallback: (x: ProgressInfo) => void) {
    console.log('[transformersJsWorker] Starting loadModel:', modelId);
    
    await this.unloadModel();

    let cleanModelId = modelId;
    if (cleanModelId.startsWith('hf.co/')) cleanModelId = cleanModelId.substring(6);
    else if (cleanModelId.startsWith('https://huggingface.co/')) cleanModelId = cleanModelId.substring(23);

    const isLocal = cleanModelId.startsWith('local/');

    try {
      // 1. Load Model
      // We try several combinations of device and dtype to find what works on this hardware/model
      const tryLoad = async (device: 'webgpu' | 'wasm', dtype: 'q4f16' | 'q4') => {
        console.log(`[transformersJsWorker] Attempting load: device=${device}, dtype=${dtype}`);
        return await AutoModelForCausalLM.from_pretrained(cleanModelId, {
          dtype,
          device,
          progress_callback: progressCallback,
          local_files_only: isLocal,
        });
      };

      try {
        model = await tryLoad('webgpu', 'q4f16');
      } catch (err) {
        console.warn('[transformersJsWorker] First attempt (webgpu, q4f16) failed:', err);
        try {
          // If q4f16 fails, try standard q4 on WebGPU
          model = await tryLoad('webgpu', 'q4');
        } catch (err2) {
          console.warn('[transformersJsWorker] Second attempt (webgpu, q4) failed:', err2);
          // Last resort: standard q4 on CPU (wasm)
          model = await tryLoad('wasm', 'q4');
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

    const streamer = new TextStreamer(tokenizer, {
      skip_prompt: true,
      skip_special_tokens: true,
      callback_function: onChunk,
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

      pastKeyValues = (result as GenerationResult).past_key_values;
    } catch (err) {
      console.error('[transformersJsWorker] Generation error:', err);
      throw err;
    }
  }
};

Comlink.expose(transformersJsWorker);
export type TransformersJsWorker = typeof transformersJsWorker;