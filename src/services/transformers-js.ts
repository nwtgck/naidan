import * as Comlink from 'comlink';
import type { ChatMessage, LmParameters } from '../models/types';
import { createTransformersWorker } from './transformers-js-loader';
import type { ITransformersJsWorker, ProgressInfo } from './transformers-js.types';

/**
 * Interface for FileSystemFileHandle with createWritable() method.
 */
interface FileSystemFileHandleWithWritable extends FileSystemFileHandle {
  createWritable(): Promise<FileSystemWritableFileStream>;
}

// Singleton state for UI
let activeModelId: string | undefined = undefined;
let loadingStatus: 'idle' | 'loading' | 'ready' | 'error' = 'idle';
let loadingProgress: number = 0;
let progressItems: Record<string, ProgressInfo> = {};
let heavyFileDetectedAt: number = 0;
let totalLoadedAmount: number = 0;
let totalSizeAmount: number = 0;
let loadingError: string | undefined = undefined;
let isCached: boolean = false;
let isLoadingFromCache: boolean = false;
let currentDevice: string = 'wasm';

type ProgressListener = (
  status: typeof loadingStatus,
  progress: number,
  error: string | undefined,
  isCached: boolean,
  isLoadingFromCache: boolean,
  progressItems: Record<string, ProgressInfo>
) => void;
const listeners: Set<ProgressListener> = new Set();

type ModelListListener = () => void;
const modelListListeners: Set<ModelListListener> = new Set();

function notify() {
  listeners.forEach(l => l(loadingStatus, loadingProgress, loadingError, isCached, isLoadingFromCache, progressItems));
}

function updateProgress({ info }: { info: ProgressInfo }) {
  const file = info.file || info.name;

  // 1. Handle generic (non-file) progress events
  if (!file) {
    if (typeof info.progress === 'number') {
      if (info.progress < 100) {
        loadingProgress = Math.max(loadingProgress, Math.round(info.progress));
      }
    }
    return;
  }

  // 2. Track per-file progress (Immutable update for Vue reactivity)
  const currentItem = progressItems[file] || { progress: 0, loaded: 0 };
  const newItem = { ...currentItem, ...info };

  if (info.status === 'done') {
    newItem.progress = 100;
    if (newItem.total === undefined || newItem.total === 0) {
      newItem.total = info.loaded;
    }
  }

  progressItems = {
    ...progressItems,
    [file]: newItem
  };

  // 3. Calculate metrics and detect phases
  let currentTotalLoaded = 0;
  let currentTotalSize = 0;
  let hasHeavyFile = false;

  for (const item of Object.values(progressItems)) {
    const name = item.file || item.name || '';
    // Identify heavy assets (weights, split data)
    const isHeavy = /\.(onnx|safetensors|bin|pth|model|data)$/i.test(name) ||
                    name.includes('_data') ||
                    (item.total || 0) > 5 * 1024 * 1024;

    if (isHeavy) {
      hasHeavyFile = true;
      if (heavyFileDetectedAt === 0) heavyFileDetectedAt = Date.now();
    }

    if (item.loaded !== undefined) {
      currentTotalLoaded += item.loaded;
    }
    if (item.total !== undefined && item.total > 0) {
      currentTotalSize += item.total;
    }
  }

  // 4. Multi-phase Progress Calculation

  // Use a conservative floor of 200MB for byte display to keep it realistic
  const effectiveTotalSize = Math.max(currentTotalSize, 200 * 1024 * 1024);
  totalLoadedAmount = currentTotalLoaded;
  totalSizeAmount = effectiveTotalSize;

  let calculatedProgress = 0;
  const timeSinceHeavy = heavyFileDetectedAt ? Date.now() - heavyFileDetectedAt : 0;

  // Phase 1: Metadata Only (No heavy files yet)
  if (!hasHeavyFile) {
    const metadataProgress = (currentTotalLoaded / (2 * 1024 * 1024)) * 5;
    calculatedProgress = Math.min(5, metadataProgress);
  } else if (timeSinceHeavy < 3000 && currentTotalSize < 100 * 1024 * 1024) {
    // Phase 2: Discovery Settling (Heavy files found, but waiting for all shards to appear)
    // We stay capped at 15% for the first 3 seconds of heavy downloading,
    // OR until we've recognized at least 100MB of total size.
    const discoveryProgress = 5 + (currentTotalLoaded / (10 * 1024 * 1024)) * 10;
    calculatedProgress = Math.min(15, discoveryProgress);
  } else {
    // Phase 3: Active Downloading
    // Use the pessimistic denominator to prevent jumps if more shards appear later
    const byteProgress = (currentTotalLoaded / effectiveTotalSize) * 100;
    calculatedProgress = byteProgress;
  }

  // 5. Ensure monotonicity and cap at 99% until fully ready
  let nextProgress = Math.max(loadingProgress, Math.round(calculatedProgress));

  if (nextProgress >= 100) {
    nextProgress = 99;
  }

  loadingProgress = nextProgress;
}

function notifyModelListChange() {
  modelListListeners.forEach(l => l());
}

// Worker management
let worker: Worker | null = null;
let remote: Comlink.Remote<ITransformersJsWorker> | null = null;

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
  if (typeof Worker === 'undefined') return;

  if (worker) {
    worker.terminate();
  }

  worker = createTransformersWorker();
  if (worker) {
    remote = Comlink.wrap<ITransformersJsWorker>(worker);
  }
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
    listener(loadingStatus, loadingProgress, loadingError, isCached, isLoadingFromCache, progressItems);
    return () => listeners.delete(listener);
  },

  subscribeModelList(listener: ModelListListener) {
    modelListListeners.add(listener);
    return () => modelListListeners.delete(listener);
  },

  getState() {
    return {
      status: loadingStatus,
      progress: loadingProgress,
      error: loadingError,
      activeModelId,
      device: currentDevice,
      isCached,
      isLoadingFromCache,
      progressItems,
      totalLoadedAmount,
      totalSizeAmount
    };
  },

  /**
   * Hard reset of the underlying engine worker.
   */
  async restart() {
    initWorker();
    activeModelId = undefined;
    loadingStatus = 'idle';
    loadingProgress = 0;
    progressItems = {};
    heavyFileDetectedAt = 0;
    totalLoadedAmount = 0;
    totalSizeAmount = 0;
    loadingError = undefined;
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
      const getDirStats = async (dir: FileSystemDirectoryHandle): Promise<{ size: number; fileCount: number; lastModified: number; isComplete: boolean }> => {
        let size = 0;
        let fileCount = 0;
        let lastModified = 0;

        const files = new Set<string>();
        const markers = new Set<string>();
        let hasWeights = false;

        const scan = async (d: FileSystemDirectoryHandle, path: string = '') => {
          for await (const [name, handle] of d.entries()) {
            const h = handle as FileSystemHandle;
            const fullPath = path ? `${path}/${name}` : name;

            switch (h.kind) {
            case 'file': {
              if (name.startsWith('.') && name.endsWith('.complete')) {
                markers.add(fullPath);
              } else {
                files.add(fullPath);
                const file = await (h as FileSystemFileHandle).getFile();
                size += file.size;
                fileCount++;
                if (file.lastModified > lastModified) lastModified = file.lastModified;
              }
              break;
            }
            case 'directory':
              await scan(h as FileSystemDirectoryHandle, fullPath);
              break;
            default: {
              const _ex: never = h.kind as never;
              throw new Error(`Unhandled handle kind: ${_ex}`);
            }
            }
          }
        };
        await scan(dir);

        // A model is considered complete if:
        // 1. Every file present has a corresponding .complete marker
        // 2. There is at least one weight file and it is complete
        let allFilesComplete = true;
        for (const file of files) {
          const pathParts = file.split('/');
          const fileName = pathParts.pop()!;
          const dirPath = pathParts.join('/');
          const markerPath = dirPath ? `${dirPath}/.${fileName}.complete` : `.${fileName}.complete`;

          if (!markers.has(markerPath)) {
            allFilesComplete = false;
            break;
          }

          // Weight detection (similar to updateProgress logic)
          if (/\.(onnx|safetensors|bin|pth|model|data)$/i.test(fileName) || fileName.includes('_data')) {
            hasWeights = true;
          }
        }

        return {
          size,
          fileCount,
          lastModified,
          isComplete: files.size > 0 && allFilesComplete && hasWeights
        };
      };

      // Try 'user' directory (new)
      try {
        const userDir = await modelsDir.getDirectoryHandle('user', { create: false });
        for await (const [name, handle] of userDir.entries()) {
          const h = handle as FileSystemHandle;
          switch (h.kind) {
          case 'directory': {
            const stats = await getDirStats(h as FileSystemDirectoryHandle);
            if (stats.isComplete) {
              results.push({ id: `user/${name}`, isLocal: true, size: stats.size, fileCount: stats.fileCount, lastModified: stats.lastModified });
            }
            break;
          }
          case 'file':
            break;
          default: {
            const _ex: never = h.kind;
            return _ex;
          }
          }
        }
      } catch (e) { /* ignore */ }

      // Try 'local' directory (old/fallback for migration)
      try {
        const localDir = await modelsDir.getDirectoryHandle('local', { create: false });
        for await (const [name, handle] of localDir.entries()) {
          const h = handle as FileSystemHandle;
          switch (h.kind) {
          case 'directory': {
            const stats = await getDirStats(h as FileSystemDirectoryHandle);
            if (stats.isComplete) {
              // We still label it as 'user/' to the rest of the app
              results.push({ id: `user/${name}`, isLocal: true, size: stats.size, fileCount: stats.fileCount, lastModified: stats.lastModified });
            }
            break;
          }
          case 'file':
            break;
          default: {
            const _ex: never = h.kind;
            return _ex;
          }
          }
        }
      } catch (e) { /* ignore */ }

      try {
        const hfDir = await modelsDir.getDirectoryHandle('huggingface.co', { create: false });
        for await (const [orgName, orgHandle] of hfDir.entries()) {
          const oh = orgHandle as FileSystemHandle;
          switch (oh.kind) {
          case 'directory': {
            const orgDir = oh as FileSystemDirectoryHandle;
            for await (const [repoName, repoHandle] of orgDir.entries()) {
              const rh = repoHandle as FileSystemHandle;
              switch (rh.kind) {
              case 'directory': {
                const stats = await getDirStats(rh as FileSystemDirectoryHandle);
                if (stats.isComplete) {
                  results.push({ id: `hf.co/${orgName}/${repoName}`, isLocal: false, size: stats.size, fileCount: stats.fileCount, lastModified: stats.lastModified });
                }
                break;
              }
              case 'file':
                break;
              default: {
                const _ex: never = rh.kind as never;
                throw new Error(`Unhandled handle kind: ${_ex}`);
              }
              }
            }
            break;
          }
          case 'file':
            break;
          default: {
            const _ex: never = oh.kind as never;
            throw new Error(`Unhandled handle kind: ${_ex}`);
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
    const userDir = await modelsDir.getDirectoryHandle('user', { create: true });
    const modelDir = await userDir.getDirectoryHandle(modelName, { create: true });

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
    notifyModelListChange();
  },

  async deleteModel(modelId: string) {
    const root = await navigator.storage.getDirectory();
    const modelsDir = await root.getDirectoryHandle('models', { create: true });

    if (modelId.startsWith('user/')) {
      const name = modelId.substring(5);
      try {
        const userDir = await modelsDir.getDirectoryHandle('user', { create: true });
        await userDir.removeEntry(name, { recursive: true });
      } catch {
        // Fallback for old 'local' directory
        try {
          const localDir = await modelsDir.getDirectoryHandle('local', { create: true });
          await localDir.removeEntry(name, { recursive: true });
        } catch { /* ignore if both fail */ }
      }
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
          for await (const _ of orgDir.entries()) {
            hasMore = true; break;
          }
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
    notifyModelListChange();
  },

  async loadModel(modelId: string) {
    if (activeModelId === modelId && loadingStatus === 'ready') return;

    switch (loadingStatus) {
    case 'loading':
      throw new Error('Another model is currently loading');
    case 'idle':
    case 'ready':
    case 'error':
      break;
    default: {
      const _ex: never = loadingStatus;
      throw new Error(`Unhandled loading status: ${_ex}`);
    }
    }

    try {
      if (!remote) throw new Error('Worker not initialized');      // 1. Check cache FIRST before changing status to avoid UI flicker
      const cached = await this.listCachedModels();
      const hfId = modelId.startsWith('hf.co/') ? modelId : `hf.co/${modelId}`;
      const isLocal = modelId.startsWith('user/');
      isLoadingFromCache = isLocal || cached.some(m => m.id === modelId || m.id === hfId);

      // 2. Now set loading state
      loadingStatus = 'loading';
      loadingProgress = 0;
      progressItems = {};
      heavyFileDetectedAt = 0;
      loadingError = undefined;
      isCached = false;
      notify();

      let lastProgressNotify = 0;
      const progress_callback = Comlink.proxy((info: ProgressInfo) => {
        updateProgress({ info });
        if (info.status === 'cached') {
          isCached = true;
        }

        const now = Date.now();
        // Throttle 'progress' updates to 150ms, but allow others (done, cached, etc.) immediately
        if (info.status !== 'progress' || now - lastProgressNotify > 150) {
          notify();
          lastProgressNotify = now;
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
      activeModelId = undefined;
      notify();
      throw e;
    }
  },

  async downloadModel(modelId: string) {
    switch (loadingStatus) {
    case 'loading':
      throw new Error('Another operation is in progress');
    case 'idle':
    case 'ready':
    case 'error':
      break;
    default: {
      const _ex: never = loadingStatus;
      throw new Error(`Unhandled loading status: ${_ex}`);
    }
    }

    try {
      if (!remote) throw new Error('Worker not initialized');      // 1. Cleanup: If directory exists but is not complete, delete it first
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
      progressItems = {};
      heavyFileDetectedAt = 0;
      loadingError = undefined;
      isCached = false;
      isLoadingFromCache = false;
      notify();

      let lastProgressNotify = 0;
      const progress_callback = Comlink.proxy((info: ProgressInfo) => {
        updateProgress({ info });

        const now = Date.now();
        if (info.status !== 'progress' || now - lastProgressNotify > 150) {
          notify();
          lastProgressNotify = now;
        }
      });

      await remote.downloadModel(modelId, progress_callback);

      loadingStatus = 'idle';
      loadingProgress = 0;
      notify();
      notifyModelListChange();
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
      activeModelId = undefined;
      loadingStatus = 'idle';
      loadingProgress = 0;
      progressItems = {};
      heavyFileDetectedAt = 0;
      totalLoadedAmount = 0;
      totalSizeAmount = 0;
      loadingError = undefined;
      isCached = false;
      isLoadingFromCache = false;
      notify();
    } catch (e) {
      console.error('[transformersJsService] Failed to unload model:', e);
      // If unload fails, it's likely the worker is dead anyway
      initWorker();
      activeModelId = undefined;
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
    switch (loadingStatus) {
    case 'idle':
    case 'loading':
    case 'error':
      throw new Error('Model not loaded');
    case 'ready':
      break;
    default: {
      const _ex: never = loadingStatus;
      throw new Error(`Unhandled loading status: ${_ex}`);
    }
    }

    if (!remote) throw new Error('Worker not initialized');

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
        activeModelId = undefined;
        loadingStatus = 'idle';
        notify();
      }
      throw e;
    }
  }
};
