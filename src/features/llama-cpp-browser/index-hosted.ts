import { profileCapabilitiesSchema, resolveProfilePreference, type ProfileCapabilities, type ProfileState } from './runtime/profile-capabilities';
import { defaultRuntimeOptions, parseRuntimeOptions } from '@/features/llama-cpp-browser/runtime/profile-policy';
import { listStoredModels, removeStoredModel, withModelMutationLock } from './runtime/model-store';
import { createLlamaCppWorkerClient } from '@/features/llama-cpp-browser/worker/client';
import type { LlamaCppWorkerClient } from './worker/types';
import { errorCode, generateInputSchema, LlamaCppBrowserError, type EngineState, type Progress, type RuntimeOptions } from './types';
import type { LlamaCppBrowserService } from './service-contract';
import { logDiagnostic } from './debug-log';

let state: EngineState = { status: 'idle' };
let options: RuntimeOptions = defaultRuntimeOptions();
let client: LlamaCppWorkerClient | undefined;
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
async function run<T>({ signal, operation, kind }: {
  kind: 'operation' | 'probe',
  signal: AbortSignal | undefined,
  operation: ({ worker, signal }: { worker: LlamaCppWorkerClient, signal: AbortSignal }) => Promise<T>,
}): Promise<T> {
  if (signal?.aborted) throw new LlamaCppBrowserError({ code: 'aborted' });
  const epoch = profileEpoch;
  const predecessor = queue;
  let releaseLane: () => void = () => {};
  queue = new Promise<void>(resolve => {
    releaseLane = resolve;
  });
  try {
    await predecessor;
    if (signal?.aborted) throw new LlamaCppBrowserError({ code: 'aborted' });
    if (kind === 'probe' && epoch !== profileEpoch) throw new LlamaCppBrowserError({ code: 'aborted' });
    const controller = new AbortController(); activeController = controller;
    const forwardAbort = (): void => controller.abort();
    signal?.addEventListener('abort', forwardAbort, { once: true });
    try {
      if (client && !client.canReuse()) {
        client.dispose(); client = undefined; invalidateProfiles();
      }
      if (!client) {
        const created = createLlamaCppWorkerClient(); client = created;
        created.subscribeDisposed({ listener: () => {
          if (client === created) {
            const checking = profileState.status === 'checking';
            client = undefined; invalidateProfiles();
            if (checking) publishProfiles({ next: { status: 'error', code: 'worker-failed' } });
          }
        } });
      }
      const result = await operation({ worker: client, signal: controller.signal });
      switch (kind) {
      case 'operation': publish({ next: { status: 'idle' } }); break;
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
      case 'operation': break;
      default: { const exhaustive: never = kind; throw new Error(`Unhandled operation kind: ${exhaustive}`); }
      }
      const reusable = (failure === 'aborted' || failure === 'context-full' || failure === 'template-unsupported') && client?.canReuse();
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
      case 'storage-error': case 'runtime-error': case 'template-unsupported': case 'context-full':
      case 'unsupported-input': case 'busy': case 'worker-failed':
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
    releaseLane();
  }
}
export const llamaCppBrowserService: LlamaCppBrowserService = {
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
      const pending = run({ kind: 'probe', signal: undefined, operation: ({ worker }) => ensureProfiles({ worker }) });
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
    signal?.throwIfAborted(); const models = await listStoredModels(); signal?.throwIfAborted(); return models;
  },
  importModel({ file, signal }) {
    return run({ kind: 'operation', signal, operation: async ({ worker, signal }) => {
      progress({ progress: { phase: 'importing', completed: 0, total: file.size } });
      await worker.importModel({ file, onProgress: progress, signal });
      for (const listener of modelListeners) {
        try {
          listener();
        } catch {
          logDiagnostic({ diagnostic: { event: 'failed' } });
        }
      }
    } });
  },
  importDirectory({ directory, signal }) {
    return run({ kind: 'operation', signal, operation: async ({ worker, signal }) => {
      progress({ progress: { phase: 'importing', completed: 0, total: directory.files.reduce((total, entry) => total + entry.file.size, 0) } });
      await worker.importDirectory({ directory, onProgress: progress, signal });
      for (const listener of modelListeners) {
        try {
          listener();
        } catch {
          logDiagnostic({ diagnostic: { event: 'failed' } });
        }
      }
    } });
  },
  async removeModel({ plan, signal }) {
    // Deletion is deliberately optimistic: it does not wait for chats or keep a
    // usage registry. Active readers may fail normally; the next request checks
    // the actual file identities before reusing resident native state.
    signal?.throwIfAborted();
    const result = await withModelMutationLock({ operation: () => {
      signal?.throwIfAborted(); return removeStoredModel({ plan });
    } });
    for (const listener of modelListeners) {
      try {
        listener();
      } catch {
        logDiagnostic({ diagnostic: { event: 'failed' } });
      }
    }
    return result;
  },
  generate({ input, onChunk, onResult, signal }) {
    // Snapshot accepted inputs before waiting in the queue; Vue proxies never cross RPC.
    const initialRequest = generateInputSchema.parse({ ...input, options: { ...options } });
    return run({ kind: 'operation', signal, operation: async ({ worker, signal }) => {
      // Only the Worker knows whether weights/context actually need preparation.
      progress({ progress: { phase: 'prefill', completed: 0, total: 0 } });
      const capabilities = await ensureProfiles({ worker });
      const profile = resolveProfilePreference({ preference: initialRequest.options.profile, capabilities });
      if (profile === undefined || !capabilities.profiles.some(entry => entry.profile === profile && entry.status === 'available')) {
        throw new LlamaCppBrowserError({ code: 'unavailable' });
      }
      const concreteOptions = { ...initialRequest.options, profile };
      let request = { ...initialRequest, options: concreteOptions };
      while (true) {
        if (signal.aborted) throw new LlamaCppBrowserError({ code: 'aborted' });
        if (client !== worker || !worker.canReuse()) throw new LlamaCppBrowserError({ code: 'worker-failed' });
        const result = await worker.generate({ request, onChunk, onProgress: progress, signal });
        if (signal.aborted) throw new LlamaCppBrowserError({ code: 'aborted' });
        const next = await onResult?.({ result, signal });
        if (signal.aborted) throw new LlamaCppBrowserError({ code: 'aborted' });
        if (!next) break;
        request = { ...generateInputSchema.parse({ ...next, options: concreteOptions }), options: concreteOptions };
      }
    } });
  },
  cancel() {
    activeController?.abort();
  },
  release() {
    activeController?.abort(); client?.dispose(); client = undefined; invalidateProfiles(); publish({ next: { status: 'idle' } });
  },
};
export const TEST_ONLY = {
};
