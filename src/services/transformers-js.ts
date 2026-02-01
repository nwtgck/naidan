import * as Comlink from 'comlink';
import type { TransformersJsWorker, ProgressInfo } from './transformers-js.worker';
import type { ChatMessage, LmParameters } from '../models/types';

/**
 * Interface for FileSystemDirectoryHandle with entries() method.
 */
interface FileSystemDirectoryHandleWithEntries extends FileSystemDirectoryHandle {
  entries(): AsyncIterableIterator<[string, FileSystemHandle]>;
}

/**
 * Interface for FileSystemFileHandle with createWritable() method.
 */
interface FileSystemFileHandleWithWritable extends FileSystemFileHandle {
  createWritable(): Promise<FileSystemWritableFileStream>;
}

// Singleton state for UI
let activeModelId: string | null = null;
let loadingStatus: 'idle' | 'loading' | 'ready' | 'error' = 'idle';
let loadingProgress: number = 0;
let loadingError: string | null = null;
let isCached: boolean = false;
let isLoadingFromCache: boolean = false;
let currentDevice: string = 'wasm';

type ProgressListener = (status: typeof loadingStatus, progress: number, error: string | null, isCached: boolean, isLoadingFromCache: boolean) => void;
const listeners: Set<ProgressListener> = new Set();

function notify() {
  listeners.forEach(l => l(loadingStatus, loadingProgress, loadingError, isCached, isLoadingFromCache));
}

// Worker management
let worker: Worker | null = null;
let remote: any = null;

/**
 * Initializes or re-initializes the Web Worker.
 * 
 * WHY RESTART?
 * Transformers.js (ONNX Runtime) runs in WebAssembly. When a fatal error occurs
 * (like an Out-of-Memory or an incompatible kernel operation), the Wasm runtime
 * calls abort(). This puts the Wasm instance into a permanently "broken" state
 * that cannot be recovered from within the same execution context.
 * Re-creating the Worker is the only way to provide a clean slate and a 
 * fresh Wasm instance without requiring the user to reload the entire page.
 */
function initWorker() {
  if (worker) {
    worker.terminate();
  }
  worker = new Worker(
    new URL('./transformers-js.worker.ts', import.meta.url),
    { type: 'module' }
  );
  remote = Comlink.wrap<TransformersJsWorker>(worker);
}

// Initial setup
initWorker();

/**
 * Checks if an error message indicates a fatal state that requires a worker restart.
 */
function isFatalError(msg: string): boolean {
  return msg.includes('Aborted()') || 
         msg.includes('[WebGPU] Kernel') || 
         msg.includes('protobuf parsing failed');
}

export const transformersJsService = {
  subscribe(listener: ProgressListener) {
    listeners.add(listener);
    listener(loadingStatus, loadingProgress, loadingError, isCached, isLoadingFromCache);
    return () => listeners.delete(listener);
  },

  getState() {
    return { status: loadingStatus, progress: loadingProgress, error: loadingError, activeModelId, device: currentDevice, isCached, isLoadingFromCache };
  },

  /**
   * Hard reset of the underlying engine worker.
   */
  async restart() {
    initWorker();
    activeModelId = null;
    loadingStatus = 'idle';
    loadingProgress = 0;
    loadingError = null;
    notify();
  },

  async listCachedModels(): Promise<Array<{ id: string; isLocal: boolean; size: number; fileCount: number; lastModified: number }>> {
    const results: Array<{ id: string; isLocal: boolean; size: number; fileCount: number; lastModified: number }> = [];
    try {
      const root = await navigator.storage.getDirectory();
      let modelsDir: FileSystemDirectoryHandle;
      try {
        modelsDir = await root.getDirectoryHandle('models', { create: false });
      } catch {
        return [];
      }

      // Helper to calculate directory stats and check for marker
      const getDirStats = async (dir: FileSystemDirectoryHandle): Promise<{ size: number; fileCount: number; lastModified: number; hasConfig: boolean }> => {
        let size = 0;
        let fileCount = 0;
        let lastModified = 0;
        let hasConfig = false;

        const scan = async (d: FileSystemDirectoryHandle) => {
          // @ts-expect-error: entries()
          for await (const [name, handle] of d.entries()) {
            if (handle.kind === 'file') {
              const file = await (handle as FileSystemFileHandle).getFile();
              size += file.size;
              fileCount++;
              if (file.lastModified > lastModified) lastModified = file.lastModified;
              if (name === '.config.json.complete') hasConfig = true;
            } else if (handle.kind === 'directory') {
              await scan(handle as FileSystemDirectoryHandle);
            }
          }
        };

        await scan(dir);
        return { size, fileCount, lastModified, hasConfig };
      };

      try {
        const localDir = await modelsDir.getDirectoryHandle('local', { create: false }) as FileSystemDirectoryHandleWithEntries;
        for await (const [name, handle] of localDir.entries()) {
          if (handle.kind === 'directory') {
            const stats = await getDirStats(handle as FileSystemDirectoryHandle);
            if (stats.hasConfig) {
              results.push({ id: `local/${name}`, isLocal: true, size: stats.size, fileCount: stats.fileCount, lastModified: stats.lastModified });
            }
          }
        }
      } catch (e) { /* ignore */ }

      try {
        const hfDir = await modelsDir.getDirectoryHandle('huggingface.co', { create: false }) as FileSystemDirectoryHandleWithEntries;
        for await (const [orgName, orgHandle] of hfDir.entries()) {
          if (orgHandle.kind === 'directory') {
            const orgDir = orgHandle as FileSystemDirectoryHandleWithEntries;
            for await (const [repoName, repoHandle] of orgDir.entries()) {
              if (repoHandle.kind === 'directory') {
                const stats = await getDirStats(repoHandle as FileSystemDirectoryHandle);
                if (stats.hasConfig) {
                  results.push({ id: `hf.co/${orgName}/${repoName}`, isLocal: false, size: stats.size, fileCount: stats.fileCount, lastModified: stats.lastModified });
                }
              }
            }
          }
        }
      } catch (e) { /* ignore */ }
    } catch (err) {
      console.warn('Failed to list cached models:', err);
    }
    return results;
  },

  async importFile(modelName: string, fileName: string, data: ArrayBuffer | ReadableStream) {
    const root = await navigator.storage.getDirectory();
    const modelsDir = await root.getDirectoryHandle('models', { create: true });
    const localDir = await modelsDir.getDirectoryHandle('local', { create: true });
    const modelDir = await localDir.getDirectoryHandle(modelName, { create: true });
    
    const parts = fileName.split('/').filter(p => !!p);
    let currentDir = modelDir;
    for (let i = 0; i < parts.length - 1; i++) {
      currentDir = await currentDir.getDirectoryHandle(parts[i]!, { create: true });
    }
    
    const lastPart = parts[parts.length - 1]!;
    const fileHandle = await currentDir.getFileHandle(lastPart, { create: true });
    
    if (!('createWritable' in fileHandle)) {
      throw new Error('FileSystemFileHandle.createWritable is not supported');
    }

    const writable = await (fileHandle as unknown as FileSystemFileHandleWithWritable).createWritable();
    
    if (data instanceof ReadableStream) {
      await data.pipeTo(writable);
    } else {
      await writable.write(data);
      await writable.close();
    }

    // Create per-file completion marker
    await currentDir.getFileHandle(`.${lastPart}.complete`, { create: true });
  },

  async deleteModel(modelId: string) {
    const root = await navigator.storage.getDirectory();
    const modelsDir = await root.getDirectoryHandle('models', { create: true });
    
    if (modelId.startsWith('local/')) {
      const localDir = await modelsDir.getDirectoryHandle('local', { create: true });
      await localDir.removeEntry(modelId.substring(6), { recursive: true });
    } else if (modelId.startsWith('hf.co/')) {
      const hfDir = await modelsDir.getDirectoryHandle('huggingface.co', { create: true });
      const parts = modelId.substring(6).split('/');
      if (parts.length >= 1) {
        // We usually want to delete the organization or the specific repo.
        // For simplicity, if it's org/repo, we delete the repo entry inside the org folder.
        const [org, repo] = parts;
        if (org && repo) {
          const orgDir = await hfDir.getDirectoryHandle(org, { create: false });
          await orgDir.removeEntry(repo, { recursive: true });
          
          // Clean up empty org directory
          let hasMore = false;
          for await (const _ of (orgDir as any).entries()) { hasMore = true; break; }
          if (!hasMore) await hfDir.removeEntry(org);
        } else if (org) {
          await hfDir.removeEntry(org, { recursive: true });
        }
      }
    } else {
      // Fallback for clean names without prefix
      try {
        const localDir = await modelsDir.getDirectoryHandle('local', { create: true });
        await localDir.removeEntry(modelId, { recursive: true });
      } catch {
        const hfDir = await modelsDir.getDirectoryHandle('huggingface.co', { create: true });
        await hfDir.removeEntry(modelId, { recursive: true });
      }
    }
  },

  async loadModel(modelId: string) {
    if (activeModelId === modelId && loadingStatus === 'ready') return;
    if (loadingStatus === 'loading') throw new Error('Another model is currently loading');

    try {
      // 1. Check cache FIRST before changing status to avoid UI flicker
      const cached = await this.listCachedModels();
      const hfId = modelId.startsWith('hf.co/') ? modelId : `hf.co/${modelId}`;
      const isLocal = modelId.startsWith('local/');
      isLoadingFromCache = isLocal || cached.some(m => m.id === modelId || m.id === hfId);

      // 2. Now set loading state
      loadingStatus = 'loading';
      loadingProgress = 0;
      loadingError = null;
      isCached = false;
      notify();

      const progress_callback = Comlink.proxy((x: ProgressInfo) => {
        if (x.status === 'progress' && typeof x.progress === 'number') {
          loadingProgress = Math.round(x.progress);
          notify();
        } else if (x.status === 'cached') {
          isCached = true;
          notify();
        }
      });

      const result = await remote.loadModel(modelId, progress_callback);
      currentDevice = result.device;

      activeModelId = modelId;
      loadingStatus = 'ready';
      notify();
    } catch (e) {
      console.error('[transformersJsService] Failed to load model:', modelId, e);
      const errorMsg = e instanceof Error ? e.message : String(e);
      
      // If the error is fatal, the worker is likely dead/poisoned and needs to be restarted
      if (isFatalError(errorMsg)) {
        console.warn(`[transformersJsService] Fatal error detected. Re-initializing worker...`);
        initWorker();
      }

      loadingStatus = 'error';
      loadingError = errorMsg;
      activeModelId = null;
      notify();
      throw e;
    }
  },

  async downloadModel(modelId: string) {
    if (loadingStatus === 'loading') throw new Error('Another operation is in progress');

    try {
      // 1. Cleanup: If directory exists but is not complete, delete it first
      const cached = await this.listCachedModels();
      const hfId = modelId.startsWith('hf.co/') ? modelId : `hf.co/${modelId}`;
      const isActuallyComplete = cached.some(m => m.id === modelId || m.id === hfId);

      if (!isActuallyComplete) {
        // Try to delete if any partial directory exists
        try {
          await this.deleteModel(modelId);
        } catch { /* ignore if doesn't exist */ }
      }

      loadingStatus = 'loading';
      loadingProgress = 0;
      loadingError = null;
      isCached = false;
      isLoadingFromCache = false;
      notify();

      const progress_callback = Comlink.proxy((x: ProgressInfo) => {
        if (x.status === 'progress' && typeof x.progress === 'number') {
          loadingProgress = Math.round(x.progress);
          notify();
        }
      });

      await remote.downloadModel(modelId, progress_callback);

      loadingStatus = 'idle'; 
      loadingProgress = 0;
      notify();
    } catch (e) {
      console.error('[transformersJsService] Failed to download model:', modelId, e);
      const errorMsg = e instanceof Error ? e.message : String(e);

      if (isFatalError(errorMsg)) {
        console.warn('[transformersJsService] Fatal error detected during download. Re-initializing worker...');
        initWorker();
      }

      loadingStatus = 'error';
      loadingError = errorMsg;
      notify();
      throw e;
    }
  },

  async unloadModel() {
    try {
      if (remote) {
        await remote.unloadModel();
      }
      activeModelId = null;
      loadingStatus = 'idle';
      loadingProgress = 0;
      loadingError = null;
      isCached = false;
      isLoadingFromCache = false;
      notify();
    } catch (e) {
      console.error('[transformersJsService] Failed to unload model:', e);
      // If unload fails, it's likely the worker is dead anyway
      initWorker();
      activeModelId = null;
      loadingStatus = 'idle';
      notify();
    }
  },

  async interrupt() {
    if (remote) {
      await remote.interrupt();
    }
  },

  async resetCache() {
    if (remote) {
      await remote.resetCache();
    }
  },

  /**
   * Generates text through the worker.
   */
  async generateText(
    messages: ChatMessage[], 
    onChunk: (chunk: string) => void,
    params?: LmParameters,
    signal?: AbortSignal
  ) {
    if (loadingStatus !== 'ready') throw new Error('Model not loaded');

    if (signal) {
      signal.addEventListener('abort', () => {
        this.interrupt().catch(console.error);
      });
    }

    try {
      await remote.generateText(
        messages, 
        Comlink.proxy(onChunk), 
        params
      );
    } catch (e) {
      const errorMsg = e instanceof Error ? e.message : String(e);
      if (isFatalError(errorMsg)) {
        console.warn(`[transformersJsService] Fatal error detected during generation. Re-initializing worker...`);
        initWorker();
        activeModelId = null;
        loadingStatus = 'idle';
        notify();
      }
      throw e;
    }
  }
};
