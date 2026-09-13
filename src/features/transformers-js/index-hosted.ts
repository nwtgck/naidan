import type { ChatMessage, LmParameters } from '@/01-models/types';
import { cloneChatMessages, cloneLmParameters, cloneWorkerTools } from './inference-input-snapshot';
import { isOpfsStagingFileName } from './runtime/opfs-staging-file';
import { createTransformersJsWorkerClient } from '@/features/transformers-js/worker/client';
import { ProductionWorkerLifecycleError } from '@/features/transformers-js/worker/production-worker-session';
import type { DownloadedModelRevisionSelection } from '@/features/transformers-js/runtime/downloaded-model-revision-selection';
import { reuseDownloadedProductionRevision } from '@/features/transformers-js/download-verification/logic/reuse-downloaded-production-revision';
import { resolvePublicHuggingFaceRevision } from '@/features/transformers-js/download-verification/logic/resolve-public-hugging-face-revision';
import { runProductionDownloadPreparation } from '@/features/transformers-js/download-verification/logic/run-production-download-preparation';
import { normalizeTransformersJsProductionModelId } from '@/features/transformers-js/production-routing';
import { createTransformersJsRuntimeLane, type TransformersJsRuntimeOperation } from './runtime-operation-lane';
import type { TransformersJsInferenceOperation, TransformersJsInferenceScope } from './inference-operation';
import { createDownloadProgressTracker, observeDownloadSafely, type DownloadProgressCallback, type DownloadProgressSnapshot } from './download-progress';
import type {
  ProgressInfo,
  WorkerToolDefinition,
  TransformersJsWorkerClient,
  TransformersJsProgressCallback,
  TransformersJsChunkCallback,
  TransformersJsToolCallsCallback,
} from './types';

/**
 * Interface for FileSystemFileHandle with createWritable() method.
 */
interface FileSystemFileHandleWithWritable extends FileSystemFileHandle {
  createWritable(): Promise<FileSystemWritableFileStream>,
}

/** Owns one service's state and Production clients; explicit Download I/O is not owned here. */
export function createTransformersJsService({ createWorkerClient }: {
  createWorkerClient: () => TransformersJsWorkerClient,
}) {
  // The ordinary UI singleton and isolated callers use this same implementation.
  let activeModelId: string | undefined = undefined;
  let loadingModelId: string | undefined = undefined;
  let loadingStatus: 'idle' | 'loading' | 'ready' | 'error' = 'idle';
  let loadingProgress: number = 0;
  let progressItems = new Map<string, ProgressInfo>();
  let heavyFileDetectedAt: number = 0;
  let totalLoadedAmount: number = 0;
  let totalSizeAmount: number = 0;
  let downloadProgress: DownloadProgressSnapshot | undefined;
  let loadingError: string | undefined = undefined;
  let isCached: boolean = false;
  let isLoadingFromCache: boolean = false;
  let currentDevice: string = 'wasm';
  const downloadedModelRevisionHints = new Map<string, string | undefined>();
  let runtimeLane = createTransformersJsRuntimeLane();
  let runtimeEpoch = 0;
  let explicitRestart: Promise<void> | undefined;
  const restartedError = new ProductionWorkerLifecycleError({ reason: 'restarted', message: 'Transformers.js runtime was explicitly restarted; retry the operation' });

  const QWEN_DEBUG_PREFIX = '[naidan-qwen-debug]';

  function debugLog({ event, details }: { event: string, details: Record<string, unknown> }): void {
    const timestamp = (() => {
      const dateCtor = globalThis.Date;
      if (typeof dateCtor === 'function') {
        return new dateCtor().toISOString();
      }
      return '0';
    })();
    console.log(`${QWEN_DEBUG_PREFIX} ${event}`, {
      at: timestamp,
      ...details,
    });
  }


  type ProgressListener = ({
    status,
    progress,
    error,
    isCached,
    isLoadingFromCache,
    progressItems,
    loadingModelId,
  }: {
    status: typeof loadingStatus,
    progress: number,
    error: string | undefined,
    isCached: boolean,
    isLoadingFromCache: boolean,
    progressItems: ReadonlyMap<string, ProgressInfo>,
    loadingModelId: string | undefined,
  }) => void;
  const listeners: Set<ProgressListener> = new Set();
  const downloadListenerChannels = new Map<ProgressListener, { busy: boolean; latest: (() => void) | undefined }>();
  let downloadObservationEpoch = 0;

  function publishDownloadListener({ listener }: { listener: ProgressListener }): void {
    const epoch = downloadObservationEpoch;
    const payload = { status: loadingStatus, progress: loadingProgress, error: loadingError, isCached, isLoadingFromCache, progressItems: new Map(progressItems), loadingModelId };
    let channel = downloadListenerChannels.get(listener);
    if (channel === undefined) {
      channel = { busy: false, latest: undefined };
      downloadListenerChannels.set(listener, channel);
    }
    const ownedChannel = channel;
    const publish = () => {
      if (!isOpen() || !listeners.has(listener) || downloadListenerChannels.get(listener) !== ownedChannel || downloadProgress === undefined || epoch !== downloadObservationEpoch) return;
      ownedChannel.busy = true;
      let observation: unknown;
      try {
        observation = listener(payload);
      } catch {
        observation = undefined;
      }
      void Promise.resolve(observation).catch(() => undefined).finally(() => {
        ownedChannel.busy = false;
        const latest = ownedChannel.latest;
        ownedChannel.latest = undefined;
        latest?.();
      });
    };
    // A held subscriber retains only one in-flight call and the latest scalar
    // snapshot. Completion is committed in getState even if it never responds.
    if (channel.busy) channel.latest = publish;
    else publish();
  }

  type ModelListListener = () => void;
  const modelListListeners: Set<ModelListListener> = new Set();

  function notify() {
    if (!isOpen()) return;
    listeners.forEach(l => {
      const publish = () => l({ status: loadingStatus, progress: loadingProgress, error: loadingError, isCached, isLoadingFromCache, progressItems, loadingModelId });
      if (downloadProgress !== undefined) publishDownloadListener({ listener: l });
      else publish();
    });
  }

  function updateProgress({ info }: { info: ProgressInfo }) {
    if (!isOpen()) return;
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
    const currentItem = progressItems.get(file) || { progress: 0, loaded: 0 };
    const newItem = { ...currentItem, ...info };

    if (info.status === 'done') {
      newItem.progress = 100;
      if (newItem.total === undefined || newItem.total === 0) {
        newItem.total = info.loaded;
      }
    }

    const nextProgressItems = new Map(progressItems);
    nextProgressItems.set(file, newItem);
    progressItems = nextProgressItems;

    // 3. Calculate metrics and detect phases
    let currentTotalLoaded = 0;
    let currentTotalSize = 0;
    let hasHeavyFile = false;

    for (const item of progressItems.values()) {
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
    if (!isOpen()) return;
    modelListListeners.forEach(l => l());
  }

  // Worker management
  let client: TransformersJsWorkerClient | undefined;
  let restartPromise: Promise<TransformersJsWorkerClient> | undefined;
  let lifetime: 'open' | 'closing' | 'closed' = 'open';
  let disposePromise: Promise<void> | undefined;
  const ownedClients = new Set<TransformersJsWorkerClient>();
  const clientDisposals = new WeakMap<TransformersJsWorkerClient, Promise<void>>();
  let retirementFailure: { error: unknown } | undefined;
  const disposedError = new ProductionWorkerLifecycleError({ reason: 'disposed', message: 'Transformers.js service owner disposed' });

  function isOpen(): boolean {
    return lifetime === 'open';
  }

  function ensureOpen(): void {
    if (!isOpen()) throw disposedError;
  }

  function captureRuntimeOperation() {
    const lane = runtimeLane;
    const epoch = runtimeEpoch;
    const owner = lane.getActive();
    if (owner === undefined) throw new Error('Transformers.js runtime operation requires an owner');
    function assertOwned(): void {
      ensureOpen();
      if (runtimeEpoch !== epoch || runtimeLane !== lane || lane.getActive() !== owner) throw restartedError;
    }
    return {
      owner,
      isCurrent: () => isOpen() && runtimeEpoch === epoch && runtimeLane === lane && lane.getActive() === owner,
      assertOwned,
      assertCurrent: () => {
        assertOwned();
        owner.assertActive();
      },
    };
  }

  function disposeOwnedClient({ ownedClient }: { ownedClient: TransformersJsWorkerClient }): Promise<void> {
    const existing = clientDisposals.get(ownedClient);
    if (existing !== undefined) return existing;
    let resolveDisposal!: () => void;
    let rejectDisposal!: ReturnType<typeof Promise.withResolvers<void>>['reject'];
    const disposal = new Promise<void>((resolve, reject) => {
      resolveDisposal = resolve;
      rejectDisposal = reject;
    });
    // Register before calling the client: physical termination can reject other
    // pending operations, whose cleanup must share this one disposal attempt.
    clientDisposals.set(ownedClient, disposal);
    try {
      void ownedClient.dispose().then(() => {
        ownedClients.delete(ownedClient);
        resolveDisposal();
      }, error => {
        retirementFailure ??= { error };
        if (isOpen()) {
          clearRuntimeState();
          loadingStatus = 'error';
          loadingError = error instanceof Error ? error.message : String(error);
        }
        runtimeLane.close({ error: error instanceof Error ? error : new Error('Transformers.js client retirement failed') });
        rejectDisposal(error);
      });
    } catch (error) {
      retirementFailure ??= { error };
      if (isOpen()) {
        clearRuntimeState();
        loadingStatus = 'error';
        loadingError = error instanceof Error ? error.message : String(error);
      }
      runtimeLane.close({ error: error instanceof Error ? error : new Error('Transformers.js client retirement failed') });
      rejectDisposal(error);
    }
    return disposal;
  }

  function createOwnedClient(): TransformersJsWorkerClient {
    ensureOpen();
    if (retirementFailure !== undefined) throw retirementFailure.error;
    const created = createWorkerClient();
    ownedClients.add(created);
    return created;
  }

  /**
   * Terminal ownership boundary for Production clients, not unload/restart and
   * not cancellation of separately owned Download or already-started OPFS I/O.
   */
  function dispose(): Promise<void> {
    if (disposePromise !== undefined) return disposePromise;
    lifetime = 'closing';
    let resolveDisposal!: () => void;
    let rejectDisposal!: ReturnType<typeof Promise.withResolvers<void>>['reject'];
    disposePromise = new Promise<void>((resolve, reject) => {
      resolveDisposal = resolve;
      rejectDisposal = reject;
    });
    runtimeEpoch++;
    // Reserve the idempotent result before abort listeners can reenter dispose.
    runtimeLane.close({ error: disposedError });
    client = undefined;
    activeModelId = undefined;
    loadingModelId = undefined;
    loadingStatus = 'idle';
    loadingProgress = 0;
    downloadProgress = undefined;
    downloadObservationEpoch++;
    progressItems = new Map<string, ProgressInfo>();
    heavyFileDetectedAt = 0;
    totalLoadedAmount = 0;
    totalSizeAmount = 0;
    loadingError = undefined;
    isCached = false;
    isLoadingFromCache = false;
    downloadedModelRevisionHints.clear();
    listeners.clear();
    downloadListenerChannels.forEach(channel => {
      channel.latest = undefined;
    });
    downloadListenerChannels.clear();
    modelListListeners.clear();
    // Includes the old client while restart is awaiting disposal. Termination is
    // started synchronously; no remote unload or advisory ACK delays it.
    const pendingDisposals = [...ownedClients].map(ownedClient => disposeOwnedClient({ ownedClient }));
    void Promise.all(pendingDisposals).then(() => {
      lifetime = 'closed';
      resolveDisposal();
    }, error => {
      lifetime = 'closed';
      rejectDisposal(error);
    });
    return disposePromise;
  }

  async function getClient(): Promise<TransformersJsWorkerClient> {
    ensureOpen();
    if (restartPromise !== undefined) {
      const restarted = await restartPromise;
      ensureOpen();
      return restarted;
    }
    client ??= createOwnedClient();
    return client;
  }

  /**
   * Re-creates the Worker after a fatal Wasm failure. Pending creation and
   * disposal are serialized so two worker instances cannot remain active.
   */
  async function restartWorker(): Promise<TransformersJsWorkerClient> {
    ensureOpen();
    if (restartPromise !== undefined) {
      const restarted = await restartPromise;
      ensureOpen();
      return restarted;
    }

    const currentRestartPromise = restartWorkerOnce();
    restartPromise = currentRestartPromise;
    try {
      const restarted = await currentRestartPromise;
      ensureOpen();
      return restarted;
    } finally {
      if (restartPromise === currentRestartPromise) {
        restartPromise = undefined;
      }
    }
  }

  async function restartWorkerOnce(): Promise<TransformersJsWorkerClient> {
    ensureOpen();
    const epoch = runtimeEpoch;
    const previousClient = client;
    client = undefined;

    if (previousClient !== undefined) {
      await disposeOwnedClient({ ownedClient: previousClient });
    }

    ensureOpen();
    if (runtimeEpoch !== epoch) throw restartedError;
    client = createOwnedClient();
    return client;
  }

  async function getExistingClient(): Promise<TransformersJsWorkerClient | undefined> {
    ensureOpen();
    if (restartPromise !== undefined) {
      const restarted = await restartPromise;
      ensureOpen();
      return restarted;
    }
    return client;
  }

  async function recoverAfterFailure({ error }: { error: unknown }): Promise<void> {
    try {
      await restartWorker();
      ensureOpen();
    } catch (recoveryError) {
      // Closing must prohibit replacement clients without replacing the failure
      // which initiated recovery. Ordinary open-owner recovery stays unchanged.
      if (!isOpen()) throw error;
      throw recoveryError;
    }
  }

  /**
   * Checks if an error message indicates a fatal state that requires a worker restart.
   */
  function isFatalError({ msg }: { msg: string }): boolean {
    const m = msg.toLowerCase();
    return m.includes('aborted()') ||
      m.includes('[webgpu] kernel') ||
      m.includes('protobuf parsing failed') ||
      m.includes('allocation failed') ||
      m.includes('out of memory');
  }


  function selectDownloadedModelLoadRevision({ modelId }: { modelId: string }): DownloadedModelRevisionSelection {
    const normalizedModelId = normalizeTransformersJsProductionModelId({ modelId });
    if (normalizedModelId.startsWith('user/') || normalizedModelId.startsWith('local/')) return { kind: 'pinned', revision: undefined };

    if (downloadedModelRevisionHints.has(normalizedModelId)) {
      const hintedRevision = downloadedModelRevisionHints.get(normalizedModelId);
      // The hint only bridges one accepted Download to the immediately following
      // cache-only Load. Keeping it indefinitely would pin this session to an old
      // immutable revision even after Hugging Face main advances.
      downloadedModelRevisionHints.delete(normalizedModelId);
      return { kind: 'pinned', revision: hintedRevision };
    }

    // Loading is deliberately offline-only. The exact repository revision is
    // resolved by Explicit Download; a later Load must select solely from OPFS
    // and remain usable when Hugging Face is unavailable or `main` has advanced.
    // The Worker owns both inventory and actual resource completeness planning.
    // A coarse host inventory cannot certify a namespace or hide I/O failures.
    return { kind: 'discover-cached' };
  }

  function productionDownloadPreparationError({ run }: {
    run: Awaited<ReturnType<typeof runProductionDownloadPreparation>>;
  }): Error {
    switch (run.status) {
    case 'failed': {
      const failureStage = run.failureStage;
      const detail = (() => {
        switch (failureStage) {
        case 'runtime-artifacts':
          return run.runtimeArtifacts.error;
        case 'candidate-orchestration':
          return run.candidates.error;
        case undefined:
          return undefined;
        default: {
          const _ex: never = failureStage;
          throw new Error(`Unhandled Production download failure stage: ${_ex}`);
        }
        }
      })();
      if (detail !== undefined) return new Error(`${detail.name}: ${detail.message}`);
      return new Error(`Production download preparation failed at ${run.failureStage}`);
    }
    case 'exhausted':
      return new Error('No Production model candidate could be downloaded and accepted from the local cache');
    case 'accepted':
      return new Error('Production download preparation unexpectedly requested an error for an accepted candidate');
    default: {
      const _ex: never = run;
      throw new Error(`Unhandled Production download preparation status: ${String(_ex)}`);
    }
    }
  }

  const rawService = {
    subscribe({ listener }: { listener: ProgressListener }) {
      ensureOpen();
      listeners.add(listener);
      const publish = () => listener({ status: loadingStatus, progress: loadingProgress, error: loadingError, isCached, isLoadingFromCache, progressItems, loadingModelId });
      if (downloadProgress !== undefined) publishDownloadListener({ listener });
      else publish();
      return () => {
        const channel = downloadListenerChannels.get(listener);
        if (channel !== undefined) channel.latest = undefined;
        downloadListenerChannels.delete(listener);
        return listeners.delete(listener);
      };
    },

    subscribeModelList({ listener }: { listener: ModelListListener }) {
      ensureOpen();
      modelListListeners.add(listener);
      return () => modelListListeners.delete(listener);
    },

    getState() {
      return {
        status: loadingStatus,
        progress: loadingProgress,
        error: loadingError,
        activeModelId,
        loadingModelId,
        device: currentDevice,
        isCached,
        isLoadingFromCache,
        progressItems,
        totalLoadedAmount,
        totalSizeAmount,
        downloadProgress,
      };
    },

    async listCachedModels(): Promise<Array<{ id: string, isLocal: boolean, size: number, fileCount: number, lastModified: number, isComplete: boolean }>> {
      ensureOpen();
      const results: Array<{ id: string, isLocal: boolean, size: number, fileCount: number, lastModified: number, isComplete: boolean }> = [];
      try {
        const root = await navigator.storage.getDirectory();
        let modelsDir: FileSystemDirectoryHandle;
        try {
          modelsDir = await root.getDirectoryHandle('models', { create: false });
        } catch {
          return [];
        }

        // Helper to calculate directory stats and check for marker
        const getDirStats = async ({ dir }: { dir: FileSystemDirectoryHandle }): Promise<{ size: number, fileCount: number, lastModified: number, isComplete: boolean }> => {
          let size = 0;
          let fileCount = 0;
          let lastModified = 0;

          const files = new Set<string>();
          const markers = new Set<string>();
          let hasWeights = false;

          const scan = async ({ dir, path = '' }: { dir: FileSystemDirectoryHandle, path?: string }) => {
            for await (const [name, handle] of dir.entries()) {
              const h = handle as FileSystemHandle;
              const fullPath = path ? `${path}/${name}` : name;

              switch (h.kind) {
              case 'file': {
                // Interrupted writers may leave unique temporary files. They
                // are not committed resources; listing is read-only, not cleanup.
                if (isOpfsStagingFileName({ fileName: name })) break;
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
                await scan({ dir: h as FileSystemDirectoryHandle, path: fullPath });
                break;
              default: {
                const _ex: never = h.kind as never;
                throw new Error(`Unhandled handle kind: ${_ex}`);
              }
              }
            }
          };
          await scan({ dir });

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
            isComplete: files.size > 0 && allFilesComplete && hasWeights,
          };
        };

        const getHuggingFaceRepoStats = async ({ repoDir }: { repoDir: FileSystemDirectoryHandle }): Promise<{ size: number, fileCount: number, lastModified: number, isComplete: boolean }> => {
          const aggregate = await getDirStats({ dir: repoDir });
          let resolveDir: FileSystemDirectoryHandle;
          try {
            resolveDir = await repoDir.getDirectoryHandle('resolve', { create: false });
          } catch {
            return aggregate;
          }

          let sawRevisionDirectory = false;
          let hasCommittedRevision = false;
          for await (const [_revision, handle] of resolveDir.entries()) {
            switch (handle.kind) {
            case 'directory': {
              sawRevisionDirectory = true;
              const revisionStats = await getDirStats({ dir: handle as FileSystemDirectoryHandle });
              if (revisionStats.isComplete) hasCommittedRevision = true;
              break;
            }
            case 'file':
              break;
            default: {
              const _ex: never = handle;
              throw new Error(`Unhandled FileSystemHandle: ${String(_ex)}`);
            }
            }
          }

          return {
            ...aggregate,
            // This remains a listing heuristic, not required-file authority. A
            // partial immutable revision must not poison an otherwise committed
            // legacy main (or another committed revision) and create a migration
            // false-incomplete label. Explicit Download revalidates through the
            // Production cache-only acceptance path before reporting success.
            isComplete: sawRevisionDirectory ? hasCommittedRevision : aggregate.isComplete,
          };
        };

        // Try 'user' directory (new)
        try {
          const userDir = await modelsDir.getDirectoryHandle('user', { create: false });
          for await (const [name, handle] of userDir.entries()) {
            const h = handle as FileSystemHandle;
            switch (h.kind) {
            case 'directory': {
              const stats = await getDirStats({ dir: h as FileSystemDirectoryHandle });
              results.push({ id: `user/${name}`, isLocal: true, size: stats.size, fileCount: stats.fileCount, lastModified: stats.lastModified, isComplete: stats.isComplete });
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
              const stats = await getDirStats({ dir: h as FileSystemDirectoryHandle });
              // We still label it as 'user/' to the rest of the app
              results.push({ id: `user/${name}`, isLocal: true, size: stats.size, fileCount: stats.fileCount, lastModified: stats.lastModified, isComplete: stats.isComplete });
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
                  const stats = await getHuggingFaceRepoStats({ repoDir: rh as FileSystemDirectoryHandle });
                  results.push({ id: `hf.co/${orgName}/${repoName}`, isLocal: false, size: stats.size, fileCount: stats.fileCount, lastModified: stats.lastModified, isComplete: stats.isComplete });
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

    async importFile({ modelName, fileName, data }: { modelName: string, fileName: string, data: ArrayBuffer | ReadableStream }) {
      ensureOpen();
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

    async deleteModel({ modelId }: { modelId: string }) {
      ensureOpen();
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
      downloadedModelRevisionHints.delete(normalizeTransformersJsProductionModelId({ modelId }));
      notifyModelListChange();
    },

    /**
     * Loads an already-downloaded model. This MUST NOT start, resume, repair, or
     * otherwise perform any model download; downloading is an explicit separate
     * operation handled by downloadModel().
     */
    async loadDownloadedModel({ modelId }: { modelId: string }) {
      const { owner, assertCurrent, isCurrent } = captureRuntimeOperation();
      assertCurrent();
      downloadProgress = undefined;
      downloadObservationEpoch++;
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
        const loadStartedAt = performance.now();
        const remote = await getClient();
        assertCurrent();
        const loadRevision = selectDownloadedModelLoadRevision({ modelId });
        // Every ordinary Load is read-only. Let the Worker's authoritative
        // inspection fail normally; a best-effort UI listing must not consume
        // and swallow a native storage failure before that inspection begins.
        isLoadingFromCache = true;

        // 2. Now set loading state
        loadingModelId = modelId;
        loadingStatus = 'loading';
        loadingProgress = 0;
        progressItems = new Map<string, ProgressInfo>();
        heavyFileDetectedAt = 0;
        loadingError = undefined;
        isCached = false;
        notify();

        let lastProgressNotify = 0;
        const progress_callback: TransformersJsProgressCallback = ({ info }) => {
          if (!isCurrent() || owner.signal.aborted) return;
          updateProgress({ info });
          if (info.status === 'cached') {
            isCached = true;
          }

          if (info.status !== 'progress' && info.status !== 'progress_total') {
            debugLog({
              event: 'load progress event',
              details: {
                modelId,
                elapsedMs: Math.round(performance.now() - loadStartedAt),
                info,
              },
            });
          }

          const now = Date.now();
          // Transformers.js 4.2 emits a progress_total immediately before every
          // progress event. Treat both as one high-frequency progress stream so
          // they cannot bypass the 150ms notification throttle and saturate the
          // main thread. Lifecycle events (done, cached, etc.) still notify
          // immediately; updateProgress above still consumes every raw event.
          if ((info.status !== 'progress' && info.status !== 'progress_total') || now - lastProgressNotify > 150) {
            notify();
            lastProgressNotify = now;
          }
        };

        // Loading and downloading are deliberately separate operations.
        // loadDownloadedModel() MUST NOT start, resume, repair, or otherwise
        // perform a model download when local artifacts are missing/incomplete.
        // The worker enforces this again at the Transformers.js/cache boundary.
        debugLog({
          event: 'load start',
          details: { modelId, loadRevision, isLoadingFromCache },
        });
        debugLog({
          event: 'worker loadDownloadedModel start',
          details: {
            modelId,
            loadRevision,
            elapsedMs: Math.round(performance.now() - loadStartedAt),
          },
        });

        assertCurrent();
        const result = await remote.loadDownloadedModel({ modelId, revisionSelection: loadRevision, progressCallback: progress_callback });
        assertCurrent();
        debugLog({
          event: 'worker loadDownloadedModel complete',
          details: {
            modelId,
            elapsedMs: Math.round(performance.now() - loadStartedAt),
            device: result.device,
          },
        });
        currentDevice = result.device;

        activeModelId = modelId;
        loadingModelId = undefined;
        loadingStatus = 'ready';
        notify();
        notifyModelListChange();
      } catch (e) {
        if (!isCurrent() || owner.signal.aborted) throw e;
        console.error('[transformersJsService] Failed to load model:', modelId, e);
        const errorMsg = e instanceof Error ? e.message : String(e);

        // If the error is fatal, the worker is likely dead/poisoned and needs to be restarted
        if (e instanceof ProductionWorkerLifecycleError || isFatalError({ msg: errorMsg })) {
          console.warn(`[transformersJsService] Fatal error detected. Re-initializing worker...`);
          await recoverAfterFailure({ error: e });
        }

        if (!isCurrent() || owner.signal.aborted) throw e;
        loadingStatus = 'error';
        loadingError = errorMsg;
        activeModelId = undefined;
        loadingModelId = undefined;
        notify();
        throw e;
      }
    },

    async downloadModel({ modelId }: { modelId: string }) {
      const { owner, assertCurrent, isCurrent } = captureRuntimeOperation();
      assertCurrent();
      const finishDownloadState = () => {
        loadingStatus = 'idle';
        loadingProgress = 0;
        loadingModelId = undefined;
        notify();
      };
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

      const tracker = createDownloadProgressTracker();
      downloadObservationEpoch++;
      const onDownloadProgress: DownloadProgressCallback = ({ event }) => {
        if (!isCurrent() || owner.signal.aborted) return;
        observeDownloadSafely({ observe: () => {
          tracker.observe({ event });
          downloadProgress = tracker.snapshot();
          loadingProgress = downloadProgress.overallProgress ?? 0;
          totalLoadedAmount = downloadProgress.receivedBytes;
          totalSizeAmount = downloadProgress.knownTotalBytes;
          notify();
        } });
      };
      downloadProgress = tracker.snapshot();
      const refreshEstimate = setInterval(() => {
        if (!isCurrent() || owner.signal.aborted) return;
        observeDownloadSafely({ observe: () => {
          downloadProgress = tracker.snapshot(); notify();
        } });
      }, 1_000);
      const stopEstimate = () => clearInterval(refreshEstimate);
      owner.signal.addEventListener('abort', stopEstimate, { once: true });

      try {
        const normalizedModelId = normalizeTransformersJsProductionModelId({ modelId });
        if (normalizedModelId.startsWith('user/')) {
          throw new Error('Downloading local user models is not supported');
        }

        loadingModelId = modelId;
        loadingStatus = 'loading';
        loadingProgress = 0;
        progressItems = new Map<string, ProgressInfo>();
        heavyFileDetectedAt = 0;
        loadingError = undefined;
        isCached = false;
        isLoadingFromCache = false;
        notify();

        const progress_callback: TransformersJsProgressCallback = ({ info }) => {
          if (!isCurrent() || owner.signal.aborted) return;
          // Metadata/acceptance reads are not network weight-transfer rows.
          if (info.status.startsWith('download-metadata:')) onDownloadProgress({ event: { kind: 'metadata', stage: info.status.slice('download-metadata:'.length) } });
        };

        const { resolvedRevision, sizeHints } = await resolvePublicHuggingFaceRevision({ modelId });
        assertCurrent();
        onDownloadProgress({ event: { kind: 'phase', phase: 'checking-cache' } });
        const cachedReuse = await reuseDownloadedProductionRevision({ modelId, resolvedRevision, onProgress: ({ progress }) => {
          // The runtime emits model-session only after admitting a locally
          // complete candidate. Inventory/revision selection alone is not 95%.
          if (progress.phase === 'runtime' && progress.info?.status === 'cache-acceptance-model-session') {
            onDownloadProgress({ event: { kind: 'cached-acceptance' } });
          }
        } });
        assertCurrent();
        if (cachedReuse.reused) {
          downloadedModelRevisionHints.set(normalizedModelId, cachedReuse.loadRevision);
        } else {
          onDownloadProgress({ event: { kind: 'phase', phase: 'preparing-metadata' } });
          const preparation = await runProductionDownloadPreparation({
            modelId,
            revision: resolvedRevision,
            progressCallback: progress_callback,
            onDownloadProgress,
            ...sizeHints === undefined ? {} : { sizeHints },
          });
          assertCurrent();
          switch (preparation.status) {
          case 'accepted':
            downloadedModelRevisionHints.set(normalizedModelId, resolvedRevision);
            break;
          case 'failed':
          case 'exhausted':
            throw productionDownloadPreparationError({ run: preparation });
          default: {
            const _ex: never = preparation;
            throw new Error(`Unhandled Production download preparation result: ${String(_ex)}`);
          }
          }
        }

        onDownloadProgress({ event: { kind: 'phase', phase: 'complete' } });
        finishDownloadState();
        // One failed list renderer must not prevent the other views refreshing.
        modelListListeners.forEach(listener => observeDownloadSafely({ observe: listener }));
      } catch (e) {
        if (!isCurrent() || owner.signal.aborted) throw e;
        console.error('[transformersJsService] Failed to download model:', modelId, e);
        const errorMsg = e instanceof Error ? e.message : String(e);

        if (isFatalError({ msg: errorMsg })) {
          console.warn('[transformersJsService] Fatal error detected during download. Re-initializing worker...');
          await recoverAfterFailure({ error: e });
        }

        if (!isCurrent() || owner.signal.aborted) throw e;
        onDownloadProgress({ event: { kind: 'phase', phase: 'failed' } });
        loadingStatus = 'error';
        loadingError = errorMsg;
        loadingModelId = undefined;
        notify();
        throw e;
      } finally {
        stopEstimate();
        owner.signal.removeEventListener('abort', stopEstimate);
        // Cancellation does not stop Download I/O. Finalize only after it settles,
        // and never let a retired operation overwrite a replacement lane's state.
        if (isCurrent() && owner.signal.aborted && loadingStatus === 'loading') {
          tracker.observe({ event: { kind: 'phase', phase: 'failed' } });
          downloadProgress = tracker.snapshot();
          finishDownloadState();
        }
      }
    },

    async unloadModel() {
      const { owner, assertOwned, assertCurrent, isCurrent } = captureRuntimeOperation();
      assertCurrent();
      try {
        const remote = await getExistingClient();
        assertCurrent();
        if (remote !== undefined) {
          await remote.unloadModel();
        }
        assertOwned();
        activeModelId = undefined;
        loadingStatus = 'idle';
        downloadProgress = undefined;
        downloadObservationEpoch++;
        loadingProgress = 0;
        progressItems = new Map<string, ProgressInfo>();
        heavyFileDetectedAt = 0;
        totalLoadedAmount = 0;
        totalSizeAmount = 0;
        loadingError = undefined;
        isCached = false;
        isLoadingFromCache = false;
        notify();
        assertCurrent();
      } catch (e) {
        if (!isCurrent() || owner.signal.aborted) throw e;
        console.error('[transformersJsService] Failed to unload model:', e);
        // If unload fails, it's likely the worker is dead anyway
        await recoverAfterFailure({ error: e });
        if (!isCurrent()) throw e;
        activeModelId = undefined;
        loadingStatus = 'idle';
        notify();
      }
    },

    async resetCache() {
      const { assertOwned, assertCurrent } = captureRuntimeOperation();
      assertCurrent();
      const remote = await getExistingClient();
      assertCurrent();
      if (remote !== undefined) {
        await remote.resetCache();
      }
      assertOwned();
      downloadedModelRevisionHints.clear();
      assertCurrent();
    },

    /**
     * Generates text through the worker.
     */
    async generateText({ messages, onChunk, onToolCalls, params, tools, signal, continuationOwner }: {
      messages: ChatMessage[],
      onChunk: TransformersJsChunkCallback,
      onToolCalls: TransformersJsToolCallsCallback,
      params?: LmParameters,
      tools?: WorkerToolDefinition[],
      signal?: AbortSignal,
      continuationOwner?: string,
    }) {
      const { owner, assertCurrent, isCurrent } = captureRuntimeOperation();
      assertCurrent();
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

      let interruptPromise: Promise<void> | undefined;
      let generationClient: TransformersJsWorkerClient | undefined;
      const onAbort = () => {
        if (interruptPromise !== undefined || generationClient === undefined) {
          return;
        }
        const interruptedClient = generationClient;
        interruptPromise = (async () => {
          try {
            await interruptedClient.interrupt();
          } catch (error) {
            console.error('Failed to interrupt Transformers.js generation:', error);
          }
        })();
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted === true) {
        onAbort();
      }

      try {
        const remote = await getClient();
        assertCurrent();
        if (signal?.aborted === true) {
          await interruptPromise;
          return;
        }
        generationClient = remote;
        await remote.generateText({
          messages: cloneChatMessages({ messages }),
          onChunk: ({ chunk }) => {
            if (isCurrent() && !owner.signal.aborted) return onChunk({ chunk });
          },
          onToolCalls: ({ toolCalls }) => {
            if (isCurrent() && !owner.signal.aborted) return onToolCalls({ toolCalls });
          },
          params: cloneLmParameters({ params }),
          tools: cloneWorkerTools({ tools }),
          continuationOwner,
        });
        assertCurrent();
      } catch (e) {
        if (!isCurrent() || owner.signal.aborted) throw e;
        const errorMsg = e instanceof Error ? e.message : String(e);
        if (e instanceof ProductionWorkerLifecycleError || isFatalError({ msg: errorMsg })) {
          console.warn(`[transformersJsService] Fatal error detected during generation. Re-initializing worker...`);
          await recoverAfterFailure({ error: e });
          if (!isCurrent()) throw e;
          // Recovery replaces the model-bearing client even if cancellation
          // arrived during retirement. Never advertise its empty replacement
          // as the previously loaded model to the next Provider operation.
          activeModelId = undefined;
          loadingStatus = 'idle';
          notify();
        }
        throw e;
      } finally {
        signal?.removeEventListener('abort', onAbort);
        if (interruptPromise !== undefined) {
          await interruptPromise;
        }
      }
    },
  };

  function clearRuntimeState(): void {
    downloadProgress = undefined;
    downloadObservationEpoch++;
    activeModelId = undefined;
    loadingModelId = undefined;
    loadingStatus = 'idle';
    loadingProgress = 0;
    loadingError = undefined;
    progressItems = new Map();
    heavyFileDetectedAt = 0;
    totalLoadedAmount = 0;
    totalSizeAmount = 0;
    isCached = false;
    isLoadingFromCache = false;
  }

  function enqueue({ signal, operation }: {
    signal: AbortSignal | undefined,
    operation: ({ owner }: { owner: TransformersJsRuntimeOperation }) => Promise<void>,
  }): Promise<void> {
    try {
      ensureOpen();
      if (explicitRestart !== undefined) throw restartedError;
      return runtimeLane.run({ signal, operation });
    } catch (error) {
      return Promise.reject(error);
    }
  }

  async function loadForOwner({ owner, modelId }: { owner: TransformersJsRuntimeOperation, modelId: string }): Promise<void> {
    owner.assertActive();
    const epoch = runtimeEpoch;
    const remote = await getClient();
    owner.assertActive();
    let cancellation: Promise<void> | undefined;
    const onAbort = () => {
      // Model loading has no cooperative interrupt contract. Retire only this
      // captured client, never one created by a later hard reset.
      if (client === remote) client = undefined;
      cancellation = disposeOwnedClient({ ownedClient: remote });
      void cancellation.catch(() => undefined);
    };
    owner.signal.addEventListener('abort', onAbort, { once: true });
    let failure: { error: unknown } | undefined;
    try {
      await rawService.loadDownloadedModel({ modelId });
    } catch (error) {
      failure = { error };
    } finally {
      owner.signal.removeEventListener('abort', onAbort);
    }
    if (cancellation !== undefined) {
      try {
        await cancellation;
      } catch (error) {
        if (epoch === runtimeEpoch) {
          runtimeLane.close({ error: new ProductionWorkerLifecycleError({ reason: 'resource-cleanup-failed', message: 'Failed to retire canceled model Load' }) });
        }
        failure = { error };
      } finally {
        if (isOpen() && epoch === runtimeEpoch && retirementFailure === undefined) {
          clearRuntimeState();
          notify();
        }
      }
    }
    owner.assertActive();
    if (failure !== undefined) throw failure.error;
  }

  async function runInferenceScope({ owner, operation }: {
    owner: TransformersJsRuntimeOperation,
    operation: TransformersJsInferenceOperation['operation'],
  }): Promise<void> {
    let open = true;
    let child: Promise<void> | undefined;
    let childFailure: { error: unknown } | undefined;
    function assertActive(): void {
      owner.assertActive();
      if (!open) throw new Error('Transformers.js inference scope is closed');
    }
    function runChild({ execute }: { execute: () => Promise<void> }): Promise<void> {
      try {
        assertActive();
        if (child !== undefined) throw new Error('Transformers.js inference scope already has an active operation');
        const pending = Promise.resolve().then(() => {
          owner.assertActive();
          return execute();
        });
        child = pending;
        void pending.then(() => {
          if (child === pending) child = undefined;
        }, error => {
          childFailure ??= { error };
          if (child === pending) child = undefined;
        });
        return pending;
      } catch (error) {
        const rejected = Promise.reject<void>(error);
        void rejected.catch(() => undefined);
        return rejected;
      }
    }
    const scope: TransformersJsInferenceScope = {
      signal: owner.signal,
      assertActive,
      getState() {
        assertActive(); return rawService.getState();
      },
      loadDownloadedModel({ modelId }) {
        return runChild({ execute: () => loadForOwner({ owner, modelId }) });
      },
      generateText({ messages, onChunk, onToolCalls, params, tools, continuationOwner }) {
        const snapshot = {
          continuationOwner,
          messages: cloneChatMessages({ messages }),
          params: cloneLmParameters({ params }),
          tools: cloneWorkerTools({ tools }),
          onChunk: ({ chunk }: { chunk: string }) => {
            if (open && owner.isActive()) return onChunk({ chunk });
          },
          onToolCalls: ({ toolCalls }: Parameters<TransformersJsToolCallsCallback>[0]) => {
            if (open && owner.isActive()) return onToolCalls({ toolCalls });
          },
        };
        return runChild({ execute: () => rawService.generateText({ ...snapshot, signal: owner.signal }) });
      },
    };
    let callbackFailure: { error: unknown } | undefined;
    try {
      await operation({ scope });
    } catch (error) {
      callbackFailure = { error };
    } finally {
      open = false;
      try {
        await child;
      } catch { /* The owned child outcome is retained above. */ }
    }
    if (callbackFailure !== undefined) throw callbackFailure.error;
    if (childFailure !== undefined) throw childFailure.error;
    owner.assertActive();
  }

  // Adding another raw method must make an explicit public scheduling choice.
  // Storage inventory/import/deletion retain their separate OPFS ownership;
  // runtime-changing methods never become public through an object spread.
  const {
    subscribe, subscribeModelList, getState, listCachedModels, importFile, deleteModel,
    loadDownloadedModel: _ownedLoad, downloadModel: _ownedDownload,
    unloadModel: _ownedUnload, resetCache: _ownedReset, generateText: _ownedGenerate,
    ...unhandledRawService
  } = rawService;
  unhandledRawService satisfies Record<PropertyKey, never>;
  const service = {
    subscribe, subscribeModelList, getState, listCachedModels, importFile, deleteModel,
    runInferenceOperation({ signal, operation }: TransformersJsInferenceOperation): Promise<void> {
      return enqueue({ signal, operation: ({ owner }) => runInferenceScope({ owner, operation }) });
    },
    loadDownloadedModel({ modelId }: { modelId: string }): Promise<void> {
      return enqueue({ signal: undefined, operation: ({ owner }) => loadForOwner({ owner, modelId }) });
    },
    downloadModel({ modelId }: { modelId: string }): Promise<void> {
      return enqueue({ signal: undefined, operation: () => rawService.downloadModel({ modelId }) });
    },
    unloadModel(): Promise<void> {
      return enqueue({ signal: undefined, operation: () => rawService.unloadModel() });
    },
    resetCache(): Promise<void> {
      return enqueue({ signal: undefined, operation: () => rawService.resetCache() });
    },
    generateText({ messages, onChunk, onToolCalls, params, tools, signal, continuationOwner }: Parameters<typeof rawService.generateText>[0]): Promise<void> {
      try {
        ensureOpen();
        if (explicitRestart !== undefined) throw restartedError;
        if (retirementFailure !== undefined) throw retirementFailure.error;
      } catch (error) {
        return Promise.reject(error);
      }
      if (loadingStatus !== 'ready' || activeModelId === undefined) return Promise.reject(new Error('Model not loaded'));
      const requestedModelId = activeModelId;
      const snapshot = {
        onChunk, onToolCalls, continuationOwner,
        messages: cloneChatMessages({ messages }),
        params: cloneLmParameters({ params }),
        tools: cloneWorkerTools({ tools }),
      };
      return enqueue({ signal, operation: ({ owner }) => {
        if (activeModelId !== requestedModelId || loadingStatus !== 'ready') {
          throw new Error('The requested Transformers.js model is no longer loaded');
        }
        return rawService.generateText({ ...snapshot, signal: owner.signal });
      } });
    },
    async interrupt(): Promise<void> {
      ensureOpen();
      // Capture synchronously. An advisory interrupt must never wait and then
      // select a different owner after the original generation has completed.
      runtimeLane.getActive()?.abort();
    },
    restart(): Promise<void> {
      try {
        ensureOpen();
      } catch (error) {
        return Promise.reject(error);
      }
      if (explicitRestart !== undefined) return explicitRestart;
      const result = Promise.withResolvers<void>();
      explicitRestart = result.promise;
      runtimeEpoch++;
      runtimeLane.close({ error: restartedError });
      clearRuntimeState();
      const pendingRecovery = restartPromise;
      // Begin termination synchronously, even while a noncooperative tool or
      // model operation is still pending. Never create before disposal settles.
      const retiring = [...ownedClients].map(ownedClient => disposeOwnedClient({ ownedClient }));
      client = undefined;
      void (async () => {
        try {
          await Promise.all(retiring);
          try {
            await pendingRecovery;
          } catch { /* Epoch invalidation prevents its replacement. */ }
          ensureOpen();
          await restartWorker();
          ensureOpen();
          runtimeLane = createTransformersJsRuntimeLane();
          clearRuntimeState();
          notify();
          result.resolve();
        } catch (error) {
          result.reject(error);
        } finally {
          if (explicitRestart === result.promise) explicitRestart = undefined;
        }
      })();
      return result.promise;
    },
  };

  return { service, dispose };
}

export const transformersJsService = createTransformersJsService({ createWorkerClient: createTransformersJsWorkerClient }).service;

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
