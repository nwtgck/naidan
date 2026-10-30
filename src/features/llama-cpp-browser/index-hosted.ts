import { liveCommandSchema, liveInfoSchema, liveToolsSchema, type LiveResult, type LiveScope } from './live-types';
import { llamaCppBrowserModelFiles } from './model-files';
import { captureProjectorOptions, captureChatInputOptions, createOperationOptionsCapture } from './runtime/chat-options';
import { promiseAllKeyed } from '@/utils/promise';
import { resolveModel } from './runtime/model-resolution';
import type { ResolvedModel } from './runtime/model-directory';
import { resolveRuntimeProfile } from './runtime/detect-profile';
import { audioGenerationInputSchema } from '@/features/audio-generation/types';
import { profileCapabilitiesSchema, resolveProfilePreference, type ProfileCapabilities, type ProfileState } from './runtime/profile-capabilities';
import { defaultRuntimeOptions, parseRuntimeOptions } from '@/features/llama-cpp-browser/runtime/profile-policy';
import { createLlamaCppWorkerClient } from '@/features/llama-cpp-browser/worker/client';
import type { AcceptedGenerateInput, LlamaCppWorkerClient } from './worker/types';
import { errorCode, generateInputSchema, LlamaCppBrowserError, type EngineState, type Progress, type RuntimeOptions, type GenerateInput, type GenerationResult } from './types';
import type { LlamaCppBrowserService, LlamaCppPerformanceScope } from './service-contract';
import { logDiagnostic, logFailure } from './debug-log';

/** Capture concrete file resources before an operation waits for its lane. */
function acceptModelRequest<T extends { modelId: string }>({ request, signal }: {
  request: T, signal: AbortSignal | undefined,
}): Promise<T & { resolvedModel: ResolvedModel }> {
  const pending = resolveModel({ modelId: request.modelId, signal }).then(resolvedModel => ({ ...request, resolvedModel }));
  // A queued operation may not await its accepted resources immediately.
  void pending.catch(() => {});
  return pending;
}

function acceptChatRequest({ request, signal }: { request: GenerateInput, signal: AbortSignal | undefined }): Promise<AcceptedGenerateInput> {
  const pending = promiseAllKeyed({
    request: acceptModelRequest({ request, signal }),
    options: captureChatInputOptions({ options: request.options, messages: request.messages }),
  }).then(({ request, options }) => ({ ...request, options }));
  void pending.catch(() => {});
  return pending;
}

let state: EngineState = { status: 'idle' };
let options: RuntimeOptions = defaultRuntimeOptions();
const optionsListeners = new Set<({ options }: { options: RuntimeOptions }) => void>();
let client: LlamaCppWorkerClient | undefined;
type WorkerRetirement = { outcome: Promise<void>, completed: Promise<void> };
const retiringWorkers = new WeakMap<LlamaCppWorkerClient, WorkerRetirement>();
let workerRetirement = Promise.resolve();

function retireWorker({ worker }: { worker: LlamaCppWorkerClient }): WorkerRetirement {
  const existing = retiringWorkers.get(worker);
  if (existing) {
    return existing;
  }
  const outcome = Promise.withResolvers<void>();
  // Explicit disposal callers receive the original failure. Background cleanup
  // and the shared retirement barrier still settle without poisoning the lane.
  const completed = outcome.promise.catch(error => {
    try {
      logFailure({ stage: 'cleanup', error });
    } catch { /* Diagnostics cannot strand retirement. */ }
  });
  const retirement = { outcome: outcome.promise, completed };
  retiringWorkers.set(worker, retirement);
  workerRetirement = Promise.all([workerRetirement, completed]).then(() => {});
  try {
    void Promise.resolve(worker.dispose()).then(outcome.resolve, outcome.reject);
  } catch (error) {
    outcome.reject(error);
  }
  return retirement;
}

// A native cache belongs to the last model operation, not to the UI that once
// created the Worker. Probing capabilities does not transfer model ownership.
type ReadOnlyOwner = { worker: LlamaCppWorkerClient | undefined };
let cacheOwner: ReadOnlyOwner | undefined;
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
  profileEpoch++;
  profileProbe = undefined;
  profileOwner = undefined;
  publishProfiles({ next: { status: 'idle' } });
}

async function ensureProfiles({ worker, signal }: { worker: LlamaCppWorkerClient, signal: AbortSignal | undefined }): Promise<ProfileCapabilities> {
  if (profileOwner === worker && worker.canReuse() && profileState.status === 'ready') {
    return profileState.capabilities;
  }
  publishProfiles({ next: { status: 'checking' } });
  // Ordinary UI probes omit signal and only detach their waiter. A measured
  // operation owns its fresh Worker and can cancel its startup/probe as well.
  const epoch = profileEpoch;
  const capabilities = profileCapabilitiesSchema.parse(await worker.probeProfiles({ signal }));
  if (epoch !== profileEpoch || client !== worker || !worker.canReuse()) {
    throw new LlamaCppBrowserError({ code: 'worker-failed' });
  }
  profileOwner = worker;
  publishProfiles({ next: { status: 'ready', capabilities } });
  return capabilities;
}

async function resolveGenerationOptions({ worker, options, signal }: { worker: LlamaCppWorkerClient, options: RuntimeOptions, signal: AbortSignal | undefined }) {
  const capabilities = await ensureProfiles({ worker, signal });
  const profile = resolveProfilePreference({ preference: options.profile, capabilities });
  if (profile === undefined || !capabilities.profiles.some(entry => entry.profile === profile && entry.status === 'available')) {
    throw new LlamaCppBrowserError({ code: 'unavailable' });
  }
  if (client !== worker || !worker.canReuse()) {
    throw new LlamaCppBrowserError({ code: 'worker-failed' });
  }
  return { ...options, profile };
}

async function observeProbe({ pending, signal }: { pending: Promise<ProfileCapabilities>, signal: AbortSignal | undefined }): Promise<ProfileCapabilities> {
  if (!signal) {
    return pending;
  }
  if (signal.aborted) {
    throw new LlamaCppBrowserError({ code: 'aborted' });
  }
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
let liveReservations = 0;
const listeners = new Set<({ state }: { state: EngineState }) => void>();

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

async function run<T>({ signal, operation, kind, owner, ready }: {
  owner: ReadOnlyOwner | undefined,
  ready: Promise<unknown> | undefined,
  kind: 'operation' | 'probe' | 'read-only' | 'measurement' | 'live',
  signal: AbortSignal | undefined,
  operation: ({ worker, signal }: { worker: LlamaCppWorkerClient, signal: AbortSignal }) => Promise<T>,
}): Promise<T> {
  // Cancellation can skip awaiting preflight work, which must still own its rejection.
  void ready?.catch(() => {});
  if (signal?.aborted) {
    throw new LlamaCppBrowserError({ code: 'aborted' });
  }
  if (liveReservations > 0) {
    throw new LlamaCppBrowserError({ code: 'busy' });
  }
  switch (kind) {
  case 'live': liveReservations++;
    break;
  case 'operation': case 'probe': case 'read-only': case 'measurement': break;
  default: {
    const exhaustive: never = kind;
    throw new Error(String(exhaustive));
  }
  }
  const epoch = profileEpoch;
  laneReservations++;
  switch (kind) {
  case 'read-only': readOnlyReservations++;
    break;
  case 'measurement': case 'live': case 'operation': case 'probe': break;
  default: {
    const exhaustive: never = kind;
    throw new Error(String(exhaustive));
  }
  }
  const predecessor = queue;
  let releaseLane: () => void = () => {};
  queue = new Promise<void>(resolve => {
    releaseLane = resolve;
  });
  try {
    await predecessor;
    await ready;
    if (signal?.aborted) {
      throw new LlamaCppBrowserError({ code: 'aborted' });
    }
    switch (kind) {
    case 'probe': if (epoch !== profileEpoch) {
      throw new LlamaCppBrowserError({ code: 'aborted' });
    }
      break;
    case 'measurement': case 'live': case 'operation': case 'read-only': break;
    default: {
      const exhaustive: never = kind;
      throw new Error(String(exhaustive));
    }
    }
    const controller = new AbortController();
    activeController = controller;
    let measuredWorker: LlamaCppWorkerClient | undefined;
    const forwardAbort = (): void => controller.abort();
    signal?.addEventListener('abort', forwardAbort, { once: true });
    try {
      switch (kind) {
      case 'measurement':
        if (client) {
          const retired = client;
          client = undefined;
          invalidateProfiles();
          await retireWorker({ worker: retired }).completed;
        }
        await workerRetirement;
        controller.signal.throwIfAborted();
        break;
      case 'live': case 'operation': case 'probe': case 'read-only': break;
      default: {
        const exhaustive: never = kind;
        throw new Error(String(exhaustive));
      }
      }
      if (client && !client.canReuse()) {
        void retireWorker({ worker: client });
        client = undefined;
        invalidateProfiles();
      }
      if (!client) {
        const created = createLlamaCppWorkerClient();
        client = created;
        created.subscribeDisposed({
          listener: () => {
            void retireWorker({ worker: created });
            if (client === created) {
              const checking = profileState.status === 'checking';
              client = undefined;
              invalidateProfiles();
              if (checking) {
                publishProfiles({ next: { status: 'error', code: 'worker-failed' } });
              }
            }
          },
        });
      }
      // A real ownership handoff releases the previous reader's claim. A probe
      // keeps it; failure/cancellation detachment retains its retirement handle.
      if (kind !== 'probe' && cacheOwner && cacheOwner !== owner) {
        cacheOwner.worker = undefined;
      }
      switch (kind) {
      case 'measurement': measuredWorker = client;
        cacheOwner = undefined;
        break;
      case 'live': case 'operation': cacheOwner = undefined;
        break;
      case 'read-only':
        cacheOwner = owner;
        if (owner) {
          owner.worker = client;
        }
        break;
      case 'probe': break;
      default: {
        const exhaustive: never = kind;
        throw new Error(String(exhaustive));
      }
      }
      const result = await operation({ worker: client, signal: controller.signal });
      switch (kind) {
      case 'measurement': case 'live': case 'operation': case 'read-only': publish({ next: { status: 'idle' } });
        break;
      case 'probe': break;
      default: {
        const exhaustive: never = kind;
        throw new Error(`Unhandled operation kind: ${exhaustive}`);
      }
      }
      return result;
    } catch (error) {
      const failure = errorCode({ error });
      switch (kind) {
      case 'probe':
        if (epoch === profileEpoch) {
          if (client) {
            void retireWorker({ worker: client });
          }
          client = undefined;
          invalidateProfiles();
          publishProfiles({ next: { status: 'error', code: failure } });
        }
        throw new LlamaCppBrowserError({ code: failure });
      case 'measurement': case 'live': case 'operation': case 'read-only': break;
      default: {
        const exhaustive: never = kind;
        throw new Error(`Unhandled operation kind: ${exhaustive}`);
      }
      }
      const reusable = (failure === 'aborted' || failure === 'context-full' || failure === 'template-unsupported' || failure === 'reasoning-unsupported') && client?.canReuse();
      if (!reusable) {
        if (client) {
          void retireWorker({ worker: client });
        }
        client = undefined;
        invalidateProfiles();
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
      default: {
        const exhaustive: never = code;
        throw new Error(`Unhandled error code: ${exhaustive}`);
      }
      }
      throw new LlamaCppBrowserError({ code });
    } finally {
      if (measuredWorker) {
        if (client === measuredWorker) {
          client = undefined;
          invalidateProfiles();
        }
        // Always retire the physical Worker, including failure and Stop, while
        // still holding the lane. Native release alone can retain mapped pools.
        await retireWorker({ worker: measuredWorker }).completed;
      }
      signal?.removeEventListener('abort', forwardAbort);
      activeController = undefined;
    }
  } finally {
    laneReservations--;
    switch (kind) {
    case 'live': liveReservations--;
      break;
    case 'operation': case 'probe': case 'read-only': case 'measurement': break;
    default: {
      const exhaustive: never = kind;
      void exhaustive;
    }
    }
    switch (kind) {
    case 'read-only': readOnlyReservations--;
      break;
    case 'measurement': case 'live': case 'operation': case 'probe': break;
    default: {
      const exhaustive: never = kind;
      void exhaustive;
    }
    }
    releaseLane();
  }
}

export const llamaCppBrowserService: LlamaCppBrowserService = {
  async runLiveSession({ modelId, instructions, tools, signal, onProgress, operation }) {
    if (laneReservations > 0) {
      throw new LlamaCppBrowserError({ code: 'busy' });
    }
    signal.throwIfAborted();
    const sessionId = crypto.randomUUID();
    const accepted = acceptModelRequest({ request: { modelId: generateInputSchema.shape.modelId.parse(modelId) }, signal });
    const acceptedOptions = captureProjectorOptions({ options: { ...options } });
    const acceptedTools = liveToolsSchema.parse(tools);
    await run({
      ready: promiseAllKeyed({ model: accepted, options: acceptedOptions }),
      kind: 'live',
      owner: undefined,
      signal,
      operation: async ({ worker, signal }) => {
        const concrete = await resolveGenerationOptions({ worker, options: await acceptedOptions, signal });
        let open = true;
        let pending: Promise<LiveResult> | undefined;
        const report: typeof progress = ({ progress: value }) => {
          progress({ progress: value });
          onProgress({ progress: value });
        };
        let onAbort = () => {};
        try {
          const info = liveInfoSchema.parse(await worker.live({
            request: { type: 'open', sessionId, prepare: { ...await accepted, options: concrete, debug: 'off' }, instructions, tools: acceptedTools },
            onEvent: async () => {},
            onProgress: report,
            signal,
          }));
          const scope: LiveScope = {
            info,
            request({ command, onEvent }) {
              if (!open || signal.aborted) {
                return Promise.reject(new LlamaCppBrowserError({ code: 'aborted' }));
              }
              if (pending) {
                return Promise.reject(new LlamaCppBrowserError({ code: 'busy' }));
              }
              const accepted = liveCommandSchema.parse(command);
              switch (accepted.type) {
              case 'close': throw new Error('The live operation owns session close');
              case 'begin': case 'audio': case 'respond': case 'tool-results': case 'transcribe': case 'rollback': case 'reset': break;
              default: {
                const exhaustive: never = accepted;
                throw new Error(String(exhaustive));
              }
              }
              pending = worker.live({ request: { type: 'command', sessionId, command: accepted }, onEvent, onProgress: report, signal }).finally(() => {
                pending = undefined;
              });
              return pending;
            },
            interrupt({ turnId }) {
              if (!open || signal.aborted) {
                return Promise.reject(new LlamaCppBrowserError({ code: 'aborted' }));
              }
              return worker.interruptLive({ sessionId, turnId });
            },
          };
          const aborted = new Promise<never>((_resolve, reject) => {
            onAbort = () => reject(new LlamaCppBrowserError({ code: 'aborted' }));
            signal.addEventListener('abort', onAbort, { once: true });
            if (signal.aborted) {
              onAbort();
            }
          });
          await Promise.race([operation({ scope }), aborted]);
          if (pending) {
            throw new Error('The live operation ended with a pending command');
          }
        } finally {
          open = false;
          signal.removeEventListener('abort', onAbort);
          await pending?.catch(() => {});
          if (worker.canReuse()) {
            const cleanup = new AbortController();
            const timer = setTimeout(() => cleanup.abort(), 10000);
            try {
              await worker.live({ request: { type: 'command', sessionId, command: { type: 'close' } }, onEvent: async () => {}, onProgress: () => {}, signal: cleanup.signal });
            } catch {
              await retireWorker({ worker }).completed;
            } finally {
              clearTimeout(timer);
            }
          }
        }
      },
    });
  },
  async prepareModel({ modelId, signal, onProgress }) {
    if (signal?.aborted) {
      throw new LlamaCppBrowserError({ code: 'aborted' });
    }
    const acceptedOptions = captureProjectorOptions({ options: { ...options } });
    // Resolve at acceptance so a shared advisory probe cannot retarget warmup.
    const accepted = acceptModelRequest({ request: { modelId: generateInputSchema.shape.modelId.parse(modelId) }, signal });
    // A capability-only probe owns no model. Share it instead of suppressing
    // the Welcome Screen's one-shot warmup when its advisory probes first.
    // Do not reserve a warmup lane while waiting: a foreground send still wins.
    if (laneReservations === 1 && profileProbe !== undefined) {
      const epoch = profileEpoch;
      await observeProbe({ pending: profileProbe, signal });
      // Releasing the engine while we waited must not revive its Worker.
      if (epoch !== profileEpoch) {
        throw new LlamaCppBrowserError({ code: 'aborted' });
      }
    }
    // Inspect ownership, not progress. Tool callbacks can own the lane while
    // EngineState still says idle. Do not evict or wait behind another chat.
    if (laneReservations > 0) {
      return 'skipped-busy';
    }
    return run({
      ready: promiseAllKeyed({ model: accepted, options: acceptedOptions }),
      kind: 'operation',
      owner: undefined,
      signal,
      operation: async ({ worker, signal }) => {
        let acceptingProgress = true;
        const report: typeof progress = ({ progress: value }) => {
          if (signal.aborted || !acceptingProgress) {
            return;
          }
          progress({ progress: value });
          onProgress?.({ progress: value });
        };
        try {
          report({ progress: { phase: 'initializing', completed: 0, total: 0 } });
          const concreteOptions = await resolveGenerationOptions({ worker, options: await acceptedOptions, signal: undefined });
          if (signal.aborted) {
            throw new LlamaCppBrowserError({ code: 'aborted' });
          }
          await worker.prepareModel({ request: { ...await accepted, options: concreteOptions, debug: 'off' }, onProgress: report, signal });
          return 'ready' as const;
        } finally {
          acceptingProgress = false;
        }
      },
    });
  },
  getProfileState: () => profileState,
  subscribeProfiles({ listener }) {
    profileListeners.add(listener);
    listener({ state: profileState });
    return () => {
      profileListeners.delete(listener);
    };
  },
  probeProfiles({ signal }) {
    if (signal?.aborted) {
      return Promise.reject(new LlamaCppBrowserError({ code: 'aborted' }));
    }
    if (client?.canReuse() && profileOwner === client && profileState.status === 'ready') {
      return observeProbe({ pending: Promise.resolve(profileState.capabilities), signal });
    }
    if (!profileProbe) {
      const pending = run({ ready: undefined, kind: 'probe', owner: undefined, signal: undefined, operation: ({ worker }) => ensureProfiles({ worker, signal: undefined }) });
      profileProbe = pending;
      void pending.finally(() => {
        if (profileProbe === pending) {
          profileProbe = undefined;
        }
      }).catch(() => {});
    }
    return observeProbe({ pending: profileProbe, signal });
  },
  getState: () => ({ ...state }),
  getOptions: () => ({ ...options }),
  subscribeOptions({ listener }) {
    // Options are shared by all chats. Each observer receives its own snapshot.
    optionsListeners.add(listener);
    try {
      listener({ options: { ...options } });
    } catch (error) {
      optionsListeners.delete(listener);
      throw error;
    }
    return () => {
      optionsListeners.delete(listener);
    };
  },
  setOptions({ options: next }) {
    options = parseRuntimeOptions({ options: next });
    for (const listener of optionsListeners) {
      try {
        listener({ options: { ...options } });
      } catch {
        // An advisory UI must not interrupt option changes or other observers.
        logDiagnostic({ diagnostic: { event: 'failed' } });
      }
    }
  },
  subscribe({ listener }) {
    listeners.add(listener);
    listener({ state: { ...state } });
    return () => {
      listeners.delete(listener);
    };
  },
  subscribeModelList: llamaCppBrowserModelFiles.subscribeModelList,
  listModelEntries: llamaCppBrowserModelFiles.listModelEntries,
  importModel: llamaCppBrowserModelFiles.importModel,
  importDirectory: llamaCppBrowserModelFiles.importDirectory,
  removeTemporaryModel: llamaCppBrowserModelFiles.removeTemporaryModel,
  removeModel: llamaCppBrowserModelFiles.removeModel,
  generate({ input, onEvent, signal }) {
    // Snapshot accepted inputs before waiting in the queue; Vue proxies never cross RPC.
    const initialRequest = acceptChatRequest({ request: generateInputSchema.parse({ ...input, options: { ...options } }), signal });
    return run({
      ready: initialRequest,
      kind: 'operation',
      owner: undefined,
      signal,
      operation: async ({ worker, signal }) => {
      // Only the Worker knows whether weights/context actually need preparation.
        const request = await initialRequest;
        progress({ progress: { phase: 'prefill', completed: 0, total: 0 } });
        const concreteOptions = await resolveGenerationOptions({ worker, options: request.options, signal: undefined });
        if (signal.aborted) {
          throw new LlamaCppBrowserError({ code: 'aborted' });
        }
        return worker.generate({ request: { ...request, options: concreteOptions }, onEvent, onProgress: progress, signal });
      },
    });
  },
  generateAudio({ input, cancellationSignal, completionSignal, preview }) {
    const initialRequest = acceptModelRequest({ request: audioGenerationInputSchema.parse({ ...input, options: { ...options } }), signal: cancellationSignal });
    return run({
      ready: initialRequest,
      kind: 'operation',
      owner: undefined,
      signal: cancellationSignal,
      operation: async ({ worker, signal }) => {
        const request = await initialRequest;
        progress({ progress: { phase: 'initializing', completed: 0, total: 0 } });
        const concreteOptions = await resolveGenerationOptions({ worker, options: request.options, signal: undefined });
        if (signal.aborted) {
          throw new LlamaCppBrowserError({ code: 'aborted' });
        }
        return worker.generateAudio({ request: { ...request, options: concreteOptions }, onProgress: progress, cancellationSignal: signal, completionSignal, preview });
      },
    });
  },
  async runGenerationOperation({ signal, operation, onProgress }) {
    const reportOperation = ({ progress: value }: { progress: Progress }): void => {
      progress({ progress: value });
      try {
        if (onProgress) {
          void Promise.resolve(onProgress({ progress: { ...value } })).catch(() => undefined);
        }
      } catch { /* Display observers cannot invalidate a healthy model. */ }
    };
    const optionCapture = createOperationOptionsCapture({ options: { ...options }, kind: 'chat' });
    const capturedOptions = optionCapture.initial;
    let callbackCompleted = false;
    let observedFailure: { error: unknown } | undefined;
    try {
      await run({
        ready: capturedOptions,
        kind: 'operation',
        owner: undefined,
        signal,
        operation: async ({ worker, signal }) => {
          const acceptedOptions = await capturedOptions;
          const controller = new AbortController();
          const abort = () => controller.abort(signal.reason);
          signal.addEventListener('abort', abort, { once: true });
          if (signal.aborted) {
            abort();
          }
          let phase: 'open' | 'closed' = 'open';
          let pending: Promise<GenerationResult> | undefined;
          const generate: LlamaCppBrowserService['generate'] = ({ input, onEvent, signal }) => {
            switch (phase) {
            case 'open': break;
            case 'closed': throw new Error('The generation operation is closed.');
            default: {
              const exhaustive: never = phase;
              throw new Error(`Unknown operation phase: ${exhaustive}`);
            }
            }
            if (pending) {
              throw new LlamaCppBrowserError({ code: 'busy' });
            }
            if (observedFailure) {
              throw observedFailure.error;
            }
            if (controller.signal.aborted) {
              throw new LlamaCppBrowserError({ code: 'aborted' });
            }
            const acceptedInput = generateInputSchema.parse({ ...input, options: acceptedOptions });
            const requestOptions = optionCapture.forMessages({ messages: acceptedInput.messages });
            const acceptedRequest = acceptModelRequest({ request: acceptedInput, signal });
            const local = new AbortController();
            const sources = [...new Set([signal, controller.signal].filter(value => value !== undefined))];
            const removers = sources.map(source => {
              const forward = () => local.abort(source.reason);
              source.addEventListener('abort', forward, { once: true });
              if (source.aborted) {
                forward();
              }
              return () => source.removeEventListener('abort', forward);
            });
            pending = Promise.resolve().then(async () => {
              let acceptingProgress = true;
              const report = ({ progress: value }: { progress: Progress }): void => {
                if (!acceptingProgress || local.signal.aborted) {
                  return;
                }
                reportOperation({ progress: value });
              };
              try {
                if (local.signal.aborted) {
                  throw new LlamaCppBrowserError({ code: 'aborted' });
                }
                const request = await acceptedRequest;
                local.signal.throwIfAborted();
                report({ progress: { phase: 'prefill', completed: 0, total: 0 } });
                const concreteOptions = await resolveGenerationOptions({ worker, options: await requestOptions, signal: undefined });
                if (local.signal.aborted) {
                  throw new LlamaCppBrowserError({ code: 'aborted' });
                }
                return await worker.generate({ request: { ...request, options: concreteOptions }, onEvent, onProgress: report, signal: local.signal });
              } catch (error) {
              // A failed model request is not a user cancellation. Keep its error
              // visible to the consumer instead of aborting the delivery signal.
                observedFailure = { error };
                throw error;
              } finally {
                acceptingProgress = false;
                for (const remove of removers) {
                  remove();
                }
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
          if (callbackFailure) {
            throw callbackFailure.error;
          }
          callbackCompleted = true;
          // The common consumer may have recorded a model failure as a result.
          // Let run retire the failed runtime, without replacing that recorded result.
          if (observedFailure) {
            throw observedFailure.error;
          }
        },
      });
    } catch (error) {
      if (!callbackCompleted || observedFailure === undefined) {
        throw error;
      }
    }
  },
  async runPerformanceOperation({ options, signal, operation }) {
    const optionCapture = createOperationOptionsCapture({ options, kind: 'measurement' });
    const acceptedOptions = optionCapture.initial;
    // Fail rather than silently warming behind an unrelated operation.
    if (laneReservations > 0) {
      throw new LlamaCppBrowserError({ code: 'busy' });
    }
    await run({
      ready: acceptedOptions,
      owner: undefined,
      kind: 'measurement',
      signal,
      operation: async ({ worker, signal }) => {
        const concreteOptions = await resolveGenerationOptions({ worker, options: await acceptedOptions, signal });
        const controller = new AbortController();
        const abort = () => controller.abort();
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) {
          abort();
        }
        let open = true;
        let pending: Promise<GenerationResult> | undefined;
        let failure: { error: unknown } | undefined;
        const generate: LlamaCppPerformanceScope['generate'] = ({ input, sequence, observation, onVisionAdmission, onEvent, onSummary, onMemoryDiagnostics, onProgress, signal }) => {
          if (!open) {
            throw new Error('The performance operation is closed.');
          }
          if (pending) {
            throw new LlamaCppBrowserError({ code: 'busy' });
          }
          if (failure) {
            throw failure.error;
          }
          const acceptedInput = generateInputSchema.parse({ ...input, options: concreteOptions });
          const requestOptions = optionCapture.forMessages({ messages: acceptedInput.messages });
          const acceptedRequest = acceptModelRequest({ request: acceptedInput, signal });
          const local = new AbortController();
          const abort = () => local.abort();
          const sources = [...new Set([signal, controller.signal])];
          for (const source of sources) {
            source.addEventListener('abort', abort, { once: true });
            if (source.aborted) {
              abort();
            }
          }
          pending = Promise.resolve().then(async () => {
            try {
              local.signal.throwIfAborted();
              const request = await acceptedRequest;
              local.signal.throwIfAborted();
              return await worker.generate({
                request: { ...request, options: { ...await requestOptions, profile: concreteOptions.profile }, measurement: { sequence, observation } },
                onVisionAdmission,
                onEvent,
                onSummary,
                onMemoryDiagnostics,
                onProgress: ({ progress: value }) => {
                  progress({ progress: value });
                  onProgress?.({ progress: value });
                },
                signal: local.signal,
              });
            } catch (error) {
              failure = { error };
              throw error;
            } finally {
              for (const source of sources) {
                source.removeEventListener('abort', abort);
              }
              pending = undefined;
            }
          });
          void pending.catch(() => {});
          return pending;
        };
        try {
          await operation({ scope: { signal: controller.signal, options: concreteOptions, generate } });
          if (failure) {
            throw failure.error;
          }
          if (pending) {
            throw new Error('The performance operation ended with a pending request.');
          }
        } finally {
          open = false;
          controller.abort();
          signal.removeEventListener('abort', abort);
          await pending?.catch(() => {});
          // Cleanup is outside trial timing. It is bounded by the client and
          // cannot overlap the next model, even when the user has pressed Stop.
          if (worker.canReuse()) {
            await worker.releaseRuntime({ signal: undefined });
          }
        }
      },
    });
  },
  async restartRuntime({ signal }) {
    if (signal?.aborted) {
      throw new LlamaCppBrowserError({ code: 'aborted' });
    }
    // State may still be idle while a tool callback owns the lane. Inspect the
    // owner, not the last progress message, before retiring a shared Worker.
    if (laneReservations > 0) {
      throw new LlamaCppBrowserError({ code: 'busy' });
    }
    llamaCppBrowserService.release();
    // Probe through the existing serialized lane. No model/cache deletion and
    // no automatic generation. The next request lazily reloads native weights.
    return llamaCppBrowserService.probeProfiles({ signal });
  },
  cancel() {
    if (readOnlyReservations > 0 || liveReservations > 0) {
      return;
    }
    activeController?.abort();
  },
  release() {
    if (readOnlyReservations > 0 || liveReservations > 0) {
      return;
    }
    activeController?.abort();
    if (client) {
      void retireWorker({ worker: client });
    }
    client = undefined;
    invalidateProfiles();
    publish({ next: { status: 'idle' } });
  },
};

/** Uses the existing native lane, but deliberately skips the writable-storage
 * capability probe. Model lookup inside generate is read-only; this entry point
 * never imports/downloads weights, changes settings or writes chat history. */
async function generateReadOnlyLlamaCpp({ owner, input, onEvent, signal, onProgress }: { owner: ReadOnlyOwner, input: Parameters<LlamaCppBrowserService['generate']>[0]['input'], onEvent: Parameters<LlamaCppBrowserService['generate']>[0]['onEvent'], signal: Parameters<LlamaCppBrowserService['generate']>[0]['signal'], onProgress({ progress }: { progress: Progress }): void }): Promise<GenerationResult> {
  if (laneReservations !== 0) {
    throw new LlamaCppBrowserError({ code: 'busy' });
  }
  const accepted = acceptChatRequest({ request: generateInputSchema.parse({ ...input, debug: 'off', options: { ...options } }), signal });
  return run({
    ready: accepted,
    kind: 'read-only',
    owner,
    signal,
    operation: async ({ worker, signal }) => {
      progress({ progress: { phase: 'initializing', completed: 0, total: 0 } });
      const request = await accepted;
      const profile = await resolveRuntimeProfile({ profile: request.options.profile });
      signal.throwIfAborted();
      return worker.generate({
        request: { ...request, options: { ...request.options, profile } },
        onEvent,
        onProgress: ({ progress: value }) => {
          if (signal.aborted) {
            return;
          }
          progress({ progress: value });
          onProgress({ progress: value });
        },
        signal,
      });
    },
  });
}


/** Releasing is serialized with model operations but never acquires a Worker.
 * An operation queued before retirement may have taken over its cache by the
 * time we reach the lane; in that case that operation is its new owner. */
function retireReadOnlyCache({ owner }: { owner: ReadOnlyOwner }): Promise<void> {
  laneReservations++;
  const predecessor = queue;
  const retiring = predecessor.then(() => {
    // Cancellation may already have detached this owner's Worker. Await only
    // its registered retirement; never retire a cache handed to another owner.
    if (cacheOwner !== owner) {
      return owner.worker ? retiringWorkers.get(owner.worker)?.outcome : undefined;
    }
    const retired = client;
    client = undefined;
    invalidateProfiles();
    const retirement = retired ? retireWorker({ worker: retired }).outcome : undefined;
    publish({ next: { status: 'idle' } });
    return retirement;
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
  const owner: ReadOnlyOwner = { worker: undefined };
  const lifetime = new AbortController();
  let pending = 0;
  let closing: Promise<void> | undefined;
  return {
    async generate({ input, onEvent, signal, onProgress }: { input: Parameters<LlamaCppBrowserService['generate']>[0]['input'], onEvent: Parameters<LlamaCppBrowserService['generate']>[0]['onEvent'], signal: Parameters<LlamaCppBrowserService['generate']>[0]['signal'], onProgress({ progress }: { progress: Progress }): void }): Promise<GenerationResult> {
      if (lifetime.signal.aborted) {
        throw new LlamaCppBrowserError({ code: 'aborted' });
      }
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
      if (closing) {
        return closing;
      }
      const completed = Promise.withResolvers<void>();
      closing = completed.promise;
      lifetime.abort();
      // No import, probe, Worker creation or wait for unrelated work if this
      // owner never acquired (or already handed over) the native cache.
      const retirement = pending > 0 || cacheOwner === owner
        ? retireReadOnlyCache({ owner })
        : owner.worker ? retiringWorkers.get(owner.worker)?.outcome ?? Promise.resolve() : Promise.resolve();
      void retirement.then(completed.resolve, completed.reject);
      return closing;
    },
  };
}

export const TEST_ONLY = {
};
