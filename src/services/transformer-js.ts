import { pipeline, env, TextStreamer, type TextGenerationPipeline } from '@huggingface/transformers';
import type { ChatMessage, LmParameters } from '../models/types';

// Configure environment
env.allowLocalModels = false;
env.useBrowserCache = false; // Disable default Cache API storage

/**
 * Converts a remote URL or local identifier to an OPFS-friendly file path.
 */
function urlToPath(url: string): string {
  try {
    const parsed = new URL(url);
    const pathParts = parsed.pathname.split('/').filter(p => !!p);
    
    // Check if it's a Hugging Face URL pattern we want to redirect to our local storage
    // Pattern: https://huggingface.co/local/MODEL_NAME/resolve/main/FILE_NAME
    if (parsed.hostname === 'huggingface.co' && pathParts[0] === 'local') {
      // Remove 'resolve' and 'main' if they exist in the path (standard HF hub patterns)
      const cleanParts = pathParts.filter(p => p !== 'resolve' && p !== 'main');
      return `models/${cleanParts.join('/')}`;
    }

    // Standard mapping: models/hostname/path...
    const cleanPath = pathParts.join('/');
    return `models/${parsed.hostname}/${cleanPath}`;
  } catch {
    // If not a valid URL, it's likely a relative path or local identifier
    const parts = url.split('/').filter(p => !!p);
    
    // If it already starts with 'local/', don't double it
    if (parts[0] === 'local') {
      return `models/${parts.join('/')}`;
    }
    
    // Default to local namespace for other relative paths
    return `models/local/${parts.join('/')}`;
  }
}

/**
 * Custom cache implementation that uses OPFS.
 * Implements the match and put methods of the Web Cache API as required by Transformers.js.
 */
const opfsCache = {
  async match(request: string | Request): Promise<Response | undefined> {
    const urlString = typeof request === 'string' ? request : request.url;
    
    if (typeof request !== 'string' && request.method && request.method !== 'GET') {
      return undefined;
    }

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

      const fileHandle = await currentDir.getFileHandle(fileName);
      const file = await fileHandle.getFile();
      
      if (file.size === 0) {
        console.warn(`[opfsCache] Found 0-byte file, invalidating: ${path}`);
        await currentDir.removeEntry(fileName);
        return undefined;
      }

      console.log(`[opfsCache] HIT: ${path} (${file.size} bytes)`);
      
      // Update loading state if we are currently loading a model
      if (loadingStatus === 'loading') {
        isLoadingFromCache = true;
        notify();
      }
      
      return new Response(file, {
        headers: {
          'Content-Type': urlString.endsWith('.json') ? 'application/json' : 'application/octet-stream',
          'Content-Length': file.size.toString(),
          'X-Cache-Hit': 'OPFS'
        }
      });
    } catch {
      console.log(`[opfsCache] MISS: ${path}`);
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
        const writable = await (fileHandle as FileSystemFileHandle & { 
          createWritable: () => Promise<FileSystemWritableFileStream> 
        }).createWritable();
        try {
          if (response.body) {
            // Manual streaming: read chunks and write to OPFS
            // This avoids loading the entire file into memory (preventing OOM)
            const reader = response.body.getReader();
            let totalBytes = 0;
            
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              await writable.write(value);
              totalBytes += value.length;
            }
            
            await writable.close(); // Commit the file
            console.log(`[opfsCache] Successfully cached (streamed): ${path} (${totalBytes} bytes)`);
          } else {
            // Fallback for responses without body (e.g. created from ArrayBuffer)
            const buffer = await response.arrayBuffer();
            await writable.write(buffer);
            await writable.close();
            console.log(`[opfsCache] Successfully cached (buffer fallback): ${path} (${buffer.byteLength} bytes)`);
          }
        } catch (err) {
          await writable.abort();
          throw err;
        }
      } else {
        console.warn(`[opfsCache] createWritable not supported on this browser. Cannot cache ${path}`);
      }
    } catch (err) {
      console.error(`[opfsCache] Failed to save cache for ${path}:`, err);
    }
  }
};

// Enable custom cache
env.useCustomCache = true;
env.customCache = opfsCache;

// Point to local WASM binaries bundled via vite.config.ts to avoid CDN downloads
// This works in both dev mode and production builds.
if (env.backends.onnx.wasm) {
  env.backends.onnx.wasm.wasmPaths = '/transformers/';
}

// Singleton state
let generator: TextGenerationPipeline | null = null;
let activeModelId: string | null = null;
let loadingStatus: 'idle' | 'loading' | 'ready' | 'error' = 'idle';
let loadingProgress: number = 0;
let loadingError: string | null = null;
let isCached: boolean = false;
let isLoadingFromCache: boolean = false;

type ProgressListener = (status: typeof loadingStatus, progress: number, error: string | null, isCached: boolean, isLocal: boolean) => void;
const listeners: Set<ProgressListener> = new Set();

function notify() {
  listeners.forEach(l => l(loadingStatus, loadingProgress, loadingError, isCached, isLoadingFromCache));
}

export const transformerService = {
  subscribe(listener: ProgressListener) {
    listeners.add(listener);
    listener(loadingStatus, loadingProgress, loadingError, isCached, isLoadingFromCache);
    return () => listeners.delete(listener);
  },

  getState() {
    // @ts-expect-error - access internal device property if exists
    const device = (generator?.processor as unknown as { model?: { device?: string } })?.model?.device || 'wasm';
    return { status: loadingStatus, progress: loadingProgress, error: loadingError, activeModelId, device, isCached, isLoadingFromCache };
  },

  /**
   * Lists models imported into the local OPFS storage.
   */
  async listLocalModels(): Promise<string[]> {
    try {
      const root = await navigator.storage.getDirectory();
      const modelsDir = await root.getDirectoryHandle('models', { create: true });
      const localDir = await modelsDir.getDirectoryHandle('local', { create: true });
      
      const models: string[] = [];
      // @ts-expect-error - entries() is part of the FileSystemDirectoryHandle API
      for await (const [name, handle] of localDir.entries()) {
        if (handle.kind === 'directory') {
          models.push(`local/${name}`);
        }
      }
      return models;
    } catch (err) {
      console.warn('Failed to list local models:', err);
      return [];
    }
  },

  /**
   * Saves a file into the local OPFS cache.
   */
  async importFile(modelName: string, fileName: string, data: ArrayBuffer | ReadableStream) {
    const root = await navigator.storage.getDirectory();
    const modelsDir = await root.getDirectoryHandle('models', { create: true });
    const localDir = await modelsDir.getDirectoryHandle('local', { create: true });
    const modelDir = await localDir.getDirectoryHandle(modelName, { create: true });
    
    // Handle subfolders (like 'onnx/model.onnx')
    const parts = fileName.split('/').filter(p => !!p);
    let currentDir = modelDir;
    
    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i];
      if (part) {
        currentDir = await currentDir.getDirectoryHandle(part, { create: true });
      }
    }
    
    const lastPart = parts[parts.length - 1];
    if (!lastPart) throw new Error('Invalid file name');
    
    const fileHandle = await currentDir.getFileHandle(lastPart, { create: true });
    
    if (!('createWritable' in fileHandle)) {
      throw new Error('FileSystemFileHandle.createWritable is not supported in this browser.');
    }

    const writable = await (fileHandle as FileSystemFileHandle & { 
      createWritable: () => Promise<FileSystemWritableFileStream> 
    }).createWritable();
    
    if (data instanceof ReadableStream) {
      await data.pipeTo(writable);
    } else {
      await writable.write(data);
      await writable.close();
    }
  },

  /**
   * Deletes a locally imported model from OPFS.
   */
  async deleteModel(modelName: string) {
    const root = await navigator.storage.getDirectory();
    const modelsDir = await root.getDirectoryHandle('models', { create: true });
    const localDir = await modelsDir.getDirectoryHandle('local', { create: true });
    
    // Remove 'local/' prefix if present
    const cleanName = modelName.startsWith('local/') ? modelName.substring(6) : modelName;
    await localDir.removeEntry(cleanName, { recursive: true });
  },

  async loadModel(modelId: string) {
    if (activeModelId === modelId && loadingStatus === 'ready') return;
    
    if (loadingStatus === 'loading') {
      throw new Error('Another model is currently loading');
    }

    try {
      loadingStatus = 'loading';
      loadingProgress = 0;
      loadingError = null;
      isCached = false;
      isLoadingFromCache = false;
      notify();

      if (generator) {
        await generator.dispose();
        generator = null;
      }

      const task = modelId.toLowerCase().includes('t5') ? 'text2text-generation' : 'text-generation';
      const isLocal = modelId.startsWith('local/');

      // @ts-expect-error - pipeline is overloaded and can be tricky with specific task types
      generator = (await pipeline(task, modelId, {
        device: 'webgpu', // Use hardware acceleration if available
        dtype: 'q4', // Explicitly use 4-bit quantization for browser efficiency
        local_files_only: isLocal, // Don't try HF Hub for manually imported models
        progress_callback: (x: { status: string, progress?: number }) => {
          if (x.status === 'progress') {
            if (typeof x.progress === 'number') {
              loadingProgress = Math.round(x.progress); 
              notify();
            }
          } else if (x.status === 'cached') {
            isCached = true;
            notify();
          } else if (x.status === 'init') {
            // Model is loaded, now initializing (compiling shaders etc)
            loadingProgress = 100;
            notify();
          }
        },
      })) as TextGenerationPipeline;

      activeModelId = modelId;
      loadingStatus = 'ready';
      notify();
    } catch (e) {
      loadingStatus = 'error';
      loadingError = e instanceof Error ? e.message : String(e);
      activeModelId = null;
      notify();
      throw e;
    }
  },

  async generate(
    messages: ChatMessage[], 
    onChunk: (chunk: string) => void,
    params?: LmParameters,
    signal?: AbortSignal
  ) {
    if (!generator || loadingStatus !== 'ready') {
      throw new Error('Model not loaded');
    }

    let prompt: string | unknown = '';
    
    const tokenizer = generator.tokenizer;

    if (tokenizer && typeof tokenizer.apply_chat_template === 'function') {
      try {
        // @ts-expect-error - messages format matches expected structure but type alignment is tricky
        const formatted = await tokenizer.apply_chat_template(messages, { tokenize: false, add_generation_prompt: true });
        prompt = formatted;
      } catch (e) {
        console.warn('Failed to apply chat template, falling back to manual construction', e);
        prompt = (messages as ChatMessage[]).map(m => `<|im_start|>${m.role}\n${m.content}<|im_end|>`).join('\n') + '\n<|im_start|>assistant\n';
      }
    } else {
      prompt = (messages as ChatMessage[]).map(m => `${m.role}: ${m.content}`).join('\n') + '\nassistant:';
    }

    const streamer = new TextStreamer(tokenizer, {
      skip_prompt: true,
      callback_function: (text: string) => {
        onChunk(text);
      }
    });

    if (signal) {
      if (signal.aborted) throw new Error('Aborted');
    }

    const maxNewTokens = params?.maxCompletionTokens || 1024;
    const temperature = params?.temperature ?? 0.6;
    const topP = params?.topP ?? 0.9;
    
    await generator(prompt as string, {
      max_new_tokens: maxNewTokens,
      temperature: temperature,
      top_p: topP,
      do_sample: temperature > 0,
      repetition_penalty: 1.15, // Reduce repetition in small models
      streamer: streamer,
    });
  }
};