import { storageService } from '@/00-storage/service';
import { listHostStoredModels, recordOpfsInventoryIssue } from './runtime/host-model-store';
import { resolveRuntimeProfile } from './runtime/detect-profile';
import { audioGenerationInputSchema } from '@/features/audio-generation/types';
import { profileCapabilitiesSchema, resolveProfilePreference, type ProfileCapabilities, type ProfileState } from './runtime/profile-capabilities';
import { defaultRuntimeOptions, parseRuntimeOptions } from '@/features/llama-cpp-browser/runtime/profile-policy';
import { listStoredModels, removeStoredModel, withModelMutationLock } from './runtime/model-store';
import { createLlamaCppWorkerClient } from '@/features/llama-cpp-browser/worker/client';
import type { LlamaCppWorkerClient } from './worker/types';
import { errorCode, generateInputSchema, LlamaCppBrowserError, type LocalModel, type EngineState, type Progress, type RuntimeOptions, type GenerationResult } from './types';
import type { LlamaCppBrowserService } from './service-contract';
import { logDiagnostic } from './debug-log';

let state: EngineState = { status: 'idle' };
let options: RuntimeOptions = defaultRuntimeOptions();
let client: LlamaCppWorkerClient | undefined;
// A native cache belongs to the last model operation, not to the UI that once
// created the Worker. Probing capabilities does not transfer model ownership.
let cacheOwner: symbol | undefined;
let profileState: ProfileState = { status: 'idle' };
let profileOwner: LlamaCppWorkerClient | undefined;
let profileProbe: Promise<ProfileCapabilities> | undefined;
let profileEpoch = 0;
const profileListeners = new Set<({ state }: { state: ProfileState }) => void>();
function publishProfiles({ next }: { next: ProfileState }): void {
  profileState = next;
  for (const listener of profileListeners) {
    try {
      listener({ state: next });
    } catch { /* Observers cannot interrupt capability detection. */ }
  }
}
function invalidateProfiles(): void {
  cacheOwner = undefined;
  profileEpoch++; profileProbe = undefined; profileOwner = undefined; publishProfiles({ next: { status: 'idle' } });
}
async function ensureProfiles({ worker }: { worker: LlamaCppWorkerClient }): Promise<ProfileCapabilities> {
  if (profileOwner === worker && worker.canReuse() && profileState.status === 'ready') return profileState.capabilities;
  publishProfiles({ next: { status: 'checking' } });
  // UI cancellation only detaches its waiter. It must never terminate the
  // inference Worker or discard a resident model and its verified KV cache.
  const epoch = profileEpoch;
  const capabilities = profileCapabilitiesSchema.parse(await worker.probeProfiles({ signal: undefined }));
  if (epoch !== profileEpoch || client !== worker || !worker.canReuse()) throw new LlamaCppBrowserError({ code: 'worker-failed' });
  profileOwner = worker; publishProfiles({ next: { status: 'ready', capabilities } });
  return capabilities;
}
async function resolveGenerationOptions({ worker, options }: { worker: LlamaCppWorkerClient, options: RuntimeOptions }) {
  const capabilities = await ensureProfiles({ worker });
  const profile = resolveProfilePreference({ preference: options.profile, capabilities });
  if (profile === undefined || !capabilities.profiles.some(entry => entry.profile === profile && entry.status === 'available')) {
    throw new LlamaCppBrowserError({ code: 'unavailable' });
  }
  if (client !== worker || !worker.canReuse()) throw new LlamaCppBrowserError({ code: 'worker-failed' });
  return { ...options, profile };
}
async function observeProbe({ pending, signal }: { pending: Promise<ProfileCapabilities>, signal: AbortSignal | undefined }): Promise<ProfileCapabilities> {
  if (!signal) return pending;
  if (signal.aborted) throw new LlamaCppBrowserError({ code: 'aborted' });
  let abort: () => void = () => {};
  try {
    return await Promise.race([pending, new Promise<never>((_resolve, reject) => {
      abort = () => reject(new LlamaCppBrowserError({ code: 'aborted' }));
      signal.addEventListener('abort', abort, { once: true });
    })]);
  } finally {
    signal.removeEventListener('abort', abort);
  }
}
let activeController: AbortController | undefined;
let queue: Promise<void> = Promise.resolve();
let laneReservations = 0;
// Scoped read-only callers share the lane, not the local UI's unscoped controls.
// Reserve before the first await, including while the Worker is being acquired.
let readOnlyReservations = 0;
const listeners = new Set<({ state }: { state: EngineState }) => void>();
const modelListeners = new Set<() => void>();
function publish({ next }: { next: EngineState }): void {
  state = next;
  for (const listener of listeners) {
    try {
      listener({ state: { ...state } });
    } catch {
      logDiagnostic({ diagnostic: { event: 'failed' } });
    }
  }
}
function progress({ progress }: { progress: Progress }): void {
  publish({ next: { status: 'working', progress } });
}
async function run<T>({ signal, operation, kind, owner }: {
  owner: symbol | undefined,
  kind: 'operation' | 'probe' | 'read-only',
  signal: AbortSignal | undefined,
  operation: ({ worker, signal }: { worker: LlamaCppWorkerClient, signal: AbortSignal }) => Promise<T>,
}): Promise<T> {
  if (signal?.aborted) throw new LlamaCppBrowserError({ code: 'aborted' });
  const epoch = profileEpoch;
  laneReservations++;
  switch (kind) {
  case 'read-only': readOnlyReservations++; break;
  case 'operation': case 'probe': break;
  default: { const exhaustive: never = kind; throw new Error(String(exhaustive)); }
  }
  const predecessor = queue;
  let releaseLane: () => void = () => {};
  queue = new Promise<void>(resolve => {
    releaseLane = resolve;
  });
  try {
    await predecessor;
    if (signal?.aborted) throw new LlamaCppBrowserError({ code: 'aborted' });
    switch (kind) {
    case 'probe': if (epoch !== profileEpoch) throw new LlamaCppBrowserError({ code: 'aborted' }); break;
    case 'operation': case 'read-only': break;
    default: { const exhaustive: never = kind; throw new Error(String(exhaustive)); }
    }
    const controller = new AbortController(); activeController = controller;
    const forwardAbort = (): void => controller.abort();
    signal?.addEventListener('abort', forwardAbort, { once: true });
    try {
      if (client && !client.canReuse()) {
        client.dispose(); client = undefined; invalidateProfiles();
      }
      if (!client) {
        const created = createLlamaCppWorkerClient(); client = created;
        created.subscribeDisposed({
          listener: () => {
            if (client === created) {
              const checking = profileState.status === 'checking';
              client = undefined; invalidateProfiles();
              if (checking) publishProfiles({ next: { status: 'error', code: 'worker-failed' } });
            }
          },
        });
      }
      switch (kind) {
      case 'operation': cacheOwner = undefined; break;
      case 'read-only': cacheOwner = owner; break;
      case 'probe': break;
      default: { const exhaustive: never = kind; throw new Error(String(exhaustive)); }
      }
      const result = await operation({ worker: client, signal: controller.signal });
      switch (kind) {
      case 'operation': case 'read-only': publish({ next: { status: 'idle' } }); break;
      case 'probe': break;
      default: { const exhaustive: never = kind; throw new Error(`Unhandled operation kind: ${exhaustive}`); }
      }
      return result;
    } catch (error) {
      const failure = errorCode({ error });
      switch (kind) {
      case 'probe':
        if (epoch === profileEpoch) {
          client?.dispose(); client = undefined; invalidateProfiles();
          publishProfiles({ next: { status: 'error', code: failure } });
        }
        throw new LlamaCppBrowserError({ code: failure });
      case 'operation': case 'read-only': break;
      default: { const exhaustive: never = kind; throw new Error(`Unhandled operation kind: ${exhaustive}`); }
      }
      const reusable = (failure === 'aborted' || failure === 'context-full' || failure === 'template-unsupported' || failure === 'reasoning-unsupported') && client?.canReuse();
      if (!reusable) {
        client?.dispose(); client = undefined; invalidateProfiles();
      }
      const code = controller.signal.aborted ? 'aborted' : errorCode({ error });
      switch (code) {
      case 'aborted':
        publish({ next: { status: 'idle' } });
        logDiagnostic({ diagnostic: { event: 'cancelled' } });
        break;
      case 'unavailable': case 'invalid-gguf': case 'duplicate-model': case 'missing-model':
      case 'storage-error': case 'runtime-error': case 'template-unsupported': case 'reasoning-unsupported': case 'context-full':
      case 'unsupported-input': case 'busy': case 'worker-failed':
      case 'audio-model-unsupported': case 'audio-reference-required': case 'audio-reference-invalid': case 'audio-output-empty':
        publish({ next: { status: 'error', code } });
        logDiagnostic({ diagnostic: { event: 'failed' } });
        break;
      default: { const exhaustive: never = code; throw new Error(`Unhandled error code: ${exhaustive}`); }
      }
      throw new LlamaCppBrowserError({ code });
    } finally {
      signal?.removeEventListener('abort', forwardAbort); activeController = undefined;
    }
  } finally {
    laneReservations--;
    switch (kind) {
    case 'read-only': readOnlyReservations--; break;
    case 'operation': case 'probe': break;
    default: { const exhaustive: never = kind; void exhaustive; }
    }
    releaseLane();
  }
}
export const llamaCppBrowserService: LlamaCppBrowserService = {
  async prepareModel({ model, signal, onProgress }) {
    if (signal?.aborted) throw new LlamaCppBrowserError({ code: 'aborted' });
    // Inspect ownership, not progress. Tool callbacks can own the lane while
    // EngineState still says idle. Do not evict or wait behind another chat.
    if (laneReservations > 0) return 'skipped-busy';
    const acceptedOptions = { ...options };
    return run({
      kind: 'operation',
      owner: undefined,
      signal,
      operation: async ({ worker, signal }) => {
        let acceptingProgress = true;
        const report: typeof progress = ({ progress: value }) => {
          if (signal.aborted || !acceptingProgress) return;
          progress({ progress: value });
          onProgress?.({ progress: value });
        };
        try {
          report({ progress: { phase: 'initializing', completed: 0, total: 0 } });
          const concreteOptions = await resolveGenerationOptions({ worker, options: acceptedOptions });
          if (signal.aborted) throw new LlamaCppBrowserError({ code: 'aborted' });
          await worker.prepareModel({ request: { model, options: concreteOptions, debug: 'off' }, onProgress: report, signal });
          return 'ready' as const;
        } finally {
          acceptingProgress = false;
        }
      },
    });
  },
  getProfileState: () => profileState,
  subscribeProfiles({ listener }) {
    profileListeners.add(listener); listener({ state: profileState }); return () => {
      profileListeners.delete(listener);
    };
  },
  probeProfiles({ signal }) {
    if (signal?.aborted) return Promise.reject(new LlamaCppBrowserError({ code: 'aborted' }));
    if (client?.canReuse() && profileOwner === client && profileState.status === 'ready') {
      return observeProbe({ pending: Promise.resolve(profileState.capabilities), signal });
    }
    if (!profileProbe) {
      const pending = run({ kind: 'probe', owner: undefined, signal: undefined, operation: ({ worker }) => ensureProfiles({ worker }) });
      profileProbe = pending;
      void pending.finally(() => {
        if (profileProbe === pending) profileProbe = undefined;
      }).catch(() => {});
    }
    return observeProbe({ pending: profileProbe, signal });
  },
  getState: () => ({ ...state }),
  getOptions: () => ({ ...options }),
  setOptions({ options: next }) {
    options = parseRuntimeOptions({ options: next });
  },
  subscribe({ listener }) {
    listeners.add(listener); listener({ state: { ...state } }); return () => {
      listeners.delete(listener);
    };
  },
  subscribeModelList({ listener }) {
    modelListeners.add(listener); return () => {
      modelListeners.delete(listener);
    };
  },
  async listModels({ signal }) {
    signal?.throwIfAborted();
    const directories = await storageService.loadHostModelDirectories();
    let models: LocalModel[]; let opfsFailure: { error: unknown } | undefined;
    try {
      models = await listStoredModels();
    } catch (error) {
      // An unavailable browser store must not hide usable linked folders.
      if (!directories.length) throw error;
      models = []; opfsFailure = { error };
    }
    models.push(...await listHostStoredModels({ directories, signal }));
    if (opfsFailure) recordOpfsInventoryIssue(opfsFailure);
    signal?.throwIfAborted(); return models.sort((a, b) => a.name.localeCompare(b.name));
  },
  importModel({ file, signal }) {
    return run({
      kind: 'operation',
      owner: undefined,
      signal,
      operation: async ({ worker, signal }) => {
        progress({ progress: { phase: 'importing', completed: 0, total: file.size } });
        await worker.importModel({ file, onProgress: progress, signal });
        for (const listener of modelListeners) {
          try {
            listener();
          } catch {
            logDiagnostic({ diagnostic: { event: 'failed' } });
          }
        }
      },
    });
  },
  importDirectory({ directory, signal }) {
    return run({
      kind: 'operation',
      owner: undefined,
      signal,
      operation: async ({ worker, signal }) => {
        progress({ progress: { phase: 'importing', completed: 0, total: directory.files.reduce((total, entry) => total + entry.file.size, 0) } });
        await worker.importDirectory({ directory, onProgress: progress, signal });
        for (const listener of modelListeners) {
          try {
            listener();
          } catch {
            logDiagnostic({ diagnostic: { event: 'failed' } });
          }
        }
      },
    });
  },
  async removeModel({ plan, signal }) {
    // Deletion is deliberately optimistic: it does not wait for chats or keep a
    // usage registry. Active readers may fail normally; the next request checks
    // the actual file identities before reusing resident native state.
    signal?.throwIfAborted();
    const result = await withModelMutationLock({
      operation: () => {
        signal?.throwIfAborted(); return removeStoredModel({ plan });
      },
    });
    for (const listener of modelListeners) {
      try {
        listener();
      } catch {
        logDiagnostic({ diagnostic: { event: 'failed' } });
      }
    }
    return result;
  },
  generate({ input, onEvent, signal }) {
    // Snapshot accepted inputs before waiting in the queue; Vue proxies never cross RPC.
    const initialRequest = generateInputSchema.parse({ ...input, options: { ...options } });
    return run({
      kind: 'operation',
      owner: undefined,
      signal,
      operation: async ({ worker, signal }) => {
      // Only the Worker knows whether weights/context actually need preparation.
        progress({ progress: { phase: 'prefill', completed: 0, total: 0 } });
        const concreteOptions = await resolveGenerationOptions({ worker, options: initialRequest.options });
        if (signal.aborted) throw new LlamaCppBrowserError({ code: 'aborted' });
        return worker.generate({ request: { ...initialRequest, options: concreteOptions }, onEvent, onProgress: progress, signal });
      },
    });
  },
  generateAudio({ input, cancellationSignal, completionSignal, preview }) {
    const initialRequest = audioGenerationInputSchema.parse({ ...input, options: { ...options } });
    return run({
      kind: 'operation',
      owner: undefined,
      signal: cancellationSignal,
      operation: async ({ worker, signal }) => {
        progress({ progress: { phase: 'initializing', completed: 0, total: 0 } });
        const concreteOptions = await resolveGenerationOptions({ worker, options: initialRequest.options });
        if (signal.aborted) throw new LlamaCppBrowserError({ code: 'aborted' });
        return worker.generateAudio({ request: { ...initialRequest, options: concreteOptions }, onProgress: progress, cancellationSignal: signal, completionSignal, preview });
      },
    });
  },
  async runGenerationOperation({ signal, operation, onProgress }) {
    const reportOperation = ({ progress: value }: { progress: Progress }): void => {
      progress({ progress: value });
      try {
        if (onProgress) void Promise.resolve(onProgress({ progress: { ...value } })).catch(() => undefined);
      } catch { /* Display observers cannot invalidate a healthy model. */ }
    };
    const acceptedOptions = { ...options };
    let callbackCompleted = false;
    let observedFailure: { error: unknown } | undefined;
    try {
      await run({
        kind: 'operation',
        owner: undefined,
        signal,
        operation: async ({ worker, signal }) => {
          const controller = new AbortController();
          const abort = () => controller.abort(signal.reason);
          signal.addEventListener('abort', abort, { once: true });
          if (signal.aborted) abort();
          let phase: 'open' | 'closed' = 'open';
          let pending: Promise<GenerationResult> | undefined;
          const generate: LlamaCppBrowserService['generate'] = ({ input, onEvent, signal }) => {
            switch (phase) {
            case 'open': break;
            case 'closed': throw new Error('The generation operation is closed.');
            default: { const exhaustive: never = phase; throw new Error(`Unknown operation phase: ${exhaustive}`); }
            }
            if (pending) throw new LlamaCppBrowserError({ code: 'busy' });
            if (observedFailure) throw observedFailure.error;
            if (controller.signal.aborted) throw new LlamaCppBrowserError({ code: 'aborted' });
            const request = generateInputSchema.parse({ ...input, options: acceptedOptions });
            const local = new AbortController();
            const sources = [...new Set([signal, controller.signal].filter(value => value !== undefined))];
            const removers = sources.map(source => {
              const forward = () => local.abort(source.reason);
              source.addEventListener('abort', forward, { once: true });
              if (source.aborted) forward();
              return () => source.removeEventListener('abort', forward);
            });
            pending = Promise.resolve().then(async () => {
              let acceptingProgress = true;
              const report = ({ progress: value }: { progress: Progress }): void => {
                if (!acceptingProgress || local.signal.aborted) return;
                reportOperation({ progress: value });
              };
              try {
                if (local.signal.aborted) throw new LlamaCppBrowserError({ code: 'aborted' });
                report({ progress: { phase: 'prefill', completed: 0, total: 0 } });
                const concreteOptions = await resolveGenerationOptions({ worker, options: acceptedOptions });
                if (local.signal.aborted) throw new LlamaCppBrowserError({ code: 'aborted' });
                return await worker.generate({ request: { ...request, options: concreteOptions }, onEvent, onProgress: report, signal: local.signal });
              } catch (error) {
              // A failed model request is not a user cancellation. Keep its error
              // visible to the consumer instead of aborting the delivery signal.
                observedFailure = { error };
                throw error;
              } finally {
                acceptingProgress = false;
                for (const remove of removers) remove();
                pending = undefined;
              }
            });
            // Own rejection even if a buggy operation returns before awaiting the request.
            void pending.catch(() => {});
            return pending;
          };
          let callbackFailure: { error: unknown } | undefined;
          try {
            await operation({ scope: { signal: controller.signal, generate } });
          } catch (error) {
            callbackFailure = { error };
          } finally {
            phase = 'closed';
            const running = pending;
            if (running) {
              controller.abort();
              await running.catch(() => {});
              callbackFailure ??= { error: new Error('The generation operation ended with a pending request.') };
            }
            signal.removeEventListener('abort', abort);
          }
          if (callbackFailure) throw callbackFailure.error;
          callbackCompleted = true;
          // The common consumer may have recorded a model failure as a result.
          // Let run retire the failed runtime, without replacing that recorded result.
          if (observedFailure) throw observedFailure.error;
        },
      });
    } catch (error) {
      if (!callbackCompleted || observedFailure === undefined) throw error;
    }
  },
  async restartRuntime({ signal }) {
    if (signal?.aborted) throw new LlamaCppBrowserError({ code: 'aborted' });
    // State may still be idle while a tool callback owns the lane. Inspect the
    // owner, not the last progress message, before retiring a shared Worker.
    if (laneReservations > 0) throw new LlamaCppBrowserError({ code: 'busy' });
    llamaCppBrowserService.release();
    // Probe through the existing serialized lane. No model/cache deletion and
    // no automatic generation. The next request lazily reloads native weights.
    return llamaCppBrowserService.probeProfiles({ signal });
  },
  cancel() {
    if (readOnlyReservations > 0) return;
    activeController?.abort();
  },
  release() {
    if (readOnlyReservations > 0) return;
    activeController?.abort(); client?.dispose(); client = undefined; invalidateProfiles(); publish({ next: { status: 'idle' } });
  },
};
/** Uses the existing native lane, but deliberately skips the writable-storage
 * capability probe. Model lookup inside generate is read-only; this entry point
 * never imports/downloads weights, changes settings or writes chat history. */
async function generateReadOnlyLlamaCpp({ owner, input, onEvent, signal, onProgress }: Parameters<LlamaCppBrowserService['generate']>[0] & {
  owner: symbol,
  onProgress({ progress }: { progress: Progress }): void,
}): Promise<GenerationResult> {
  if (laneReservations !== 0) throw new LlamaCppBrowserError({ code: 'busy' });
  const accepted = generateInputSchema.parse({ ...input, debug: 'off', options: { ...options } });
  return run({
    kind: 'read-only',
    owner,
    signal,
    operation: async ({ worker, signal }) => {
      progress({ progress: { phase: 'initializing', completed: 0, total: 0 } });
      const profile = await resolveRuntimeProfile({ profile: accepted.options.profile });
      signal.throwIfAborted();
      return worker.generate({
        request: { ...accepted, options: { ...accepted.options, profile } },
        onEvent,
        onProgress: ({ progress: value }) => {
          if (signal.aborted) return;
          progress({ progress: value }); onProgress({ progress: value });
        },
        signal,
      });
    },
  });
}


/** Releasing is serialized with model operations but never acquires a Worker.
 * An operation queued before retirement may have taken over its cache by the
 * time we reach the lane; in that case that operation is its new owner. */
function retireReadOnlyCache({ owner }: { owner: symbol }): Promise<void> {
  laneReservations++;
  const predecessor = queue;
  const retiring = predecessor.then(() => {
    if (cacheOwner !== owner) return;
    const retired = client;
    client = undefined;
    invalidateProfiles();
    retired?.dispose();
    publish({ next: { status: 'idle' } });
  }).finally(() => {
    laneReservations--;
  });
  // Keep the serialization lane usable even if native disposal fails. The
  // disposal caller still receives the actual failure via `retiring`.
  queue = retiring.catch(() => {});
  return retiring;
}

/** A local read-only owner, not a new RPC capability. Construction is lazy;
 * disposal aborts only this owner's calls and retires only its native cache. */
export function createReadOnlyLlamaCppClient() {
  const owner = Symbol('read-only-llama');
  const lifetime = new AbortController();
  let pending = 0;
  let closing: Promise<void> | undefined;
  return {
    async generate({ input, onEvent, signal, onProgress }: Parameters<LlamaCppBrowserService['generate']>[0] & {
      onProgress({ progress }: { progress: Progress }): void,
    }): Promise<GenerationResult> {
      if (lifetime.signal.aborted) throw new LlamaCppBrowserError({ code: 'aborted' });
      const combined = signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal;
      pending++;
      try {
        const result = await generateReadOnlyLlamaCpp({ owner, input, onEvent, signal: combined, onProgress });
        combined.throwIfAborted();
        return result;
      } finally {
        pending--;
      }
    },
    dispose(): Promise<void> {
      if (closing) return closing;
      const completed = Promise.withResolvers<void>();
      closing = completed.promise;
      lifetime.abort();
      // No import, probe, Worker creation or wait for unrelated work if this
      // owner never acquired (or already handed over) the native cache.
      const retirement = pending > 0 || cacheOwner === owner ? retireReadOnlyCache({ owner }) : Promise.resolve();
      void retirement.then(completed.resolve, completed.reject);
      return closing;
    },
  };
}

export const TEST_ONLY = {
};
