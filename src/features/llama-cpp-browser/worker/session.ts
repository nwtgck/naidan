import type { AudioBackend } from '@/features/audio-generation/types';
import type { ModelFile } from '@/features/llama-cpp-browser/runtime/model-directory';
import type { Core } from "@/features/llama-cpp-browser/runtime/core";
import { mountReadOnlyFile } from "@/features/llama-cpp-browser/runtime/read-only-file";
import { createModelReadCache } from "@/features/llama-cpp-browser/runtime/model-read-cache";
import { LlamaCppBrowserError, usesWebGpu, type LlamaCppProfile, type Progress, type RuntimeOptions } from "@/features/llama-cpp-browser/types";
import { storedModelDirectory } from "@/features/llama-cpp-browser/runtime/model-store";
import { loadRuntime } from "@/features/llama-cpp-browser/runtime/load-runtime";
import { resolveRuntimeProfile } from "@/features/llama-cpp-browser/runtime/detect-profile";
import { logDiagnostic, logFailure } from "@/features/llama-cpp-browser/debug-log";
import type { WorkerGenerateInput } from "./types";
import { loadProjector, loadProjectorForBackend, type ResidentProjector } from "./projector";
import { probeNewContextSequenceRemoval, type SequenceRemoval } from './cache-capabilities';
import { disposePromptCheckpoint, type PromptCheckpoint } from './prompt-checkpoint';
import { prefillBatchTokens, prefillMicroBatchTokens } from './prefill-config';

export type PromptCache = { tokens: number[], validity: 'valid' | 'invalid', checkpoint: PromptCheckpoint | undefined,
  // A one-use proof, published only after the new-context probe has cleared
  // and synchronized memory. Generation consumes it before doing any work.
  initialMemoryState: 'probe-cleared' | 'unknown',
};

type ResidentChatMetadata = { vocab: bigint, contextTokens: number, memory: bigint, nativeRollbackTokens: number, prefillBatchTokens: number };
type ResidentModel = { model: bigint, context: bigint, sequenceRemoval: SequenceRemoval | undefined, slidingWindow: number, cache: PromptCache, name: string,
  id: string, files: ModelFile[], projector: ResidentProjector | undefined, chatMetadata: ResidentChatMetadata | undefined, contextProjector: 'absent' | 'present' | undefined };
let runtime: { core: Core, profile: LlamaCppProfile, requestedProfile: RuntimeOptions['profile'], assetBaseURL: string | undefined } | undefined;
let resident: ResidentModel | undefined;

/** Storage resources are independent. Attempt every release even when an
 * earlier shard fails; consume ownership before each attempt and never retry. */
function releaseModelFiles({ mounts, accesses }: {
  mounts: ReturnType<typeof mountReadOnlyFile>[], accesses: { close(): void }[],
}): void {
  let failure: { error: unknown } | undefined;
  while (mounts.length) {
    const mounted = mounts.pop()!;
    try {
      mounted.remove();
    } catch (error) {
      failure ??= { error };
    }
  }
  while (accesses.length) {
    const access = accesses.pop()!;
    try {
      access.close();
    } catch (error) {
      failure ??= { error };
    }
  }
  if (failure) throw failure.error;
}

/** Keep one model resident. Storage locks/handles are only needed while reading,
 * not throughout the idle GPU lifetime. The decoded token prefix stays with its context; samplers remain request-local. */
export async function releaseSession({ releaseRuntime }: { releaseRuntime: boolean }): Promise<void> {
  const current = resident; resident = undefined;
  if (current) current.cache.initialMemoryState = 'unknown';
  if (runtime && current) {
    try {
      try {
        const checkpoint = current.cache.checkpoint; current.cache.checkpoint = undefined;
        disposePromptCheckpoint({ core: runtime.core, checkpoint });
      } finally {
        if (current.context !== 0n) await runtime.core.api.llama_free(current.context);
      }
    } finally {
      try {
        await current.projector?.release();
      } finally {
        // Chat templates retain native references derived from the model. Drop
        // them before freeing the model so a recycled pointer can never hit a
        // stale cache entry.
        try {
          runtime.core.chat.releaseModel({ assertIdle: runtime.core.assertIdle, model: current.model });
        } finally {
          await runtime.core.api.llama_model_free(current.model);
        }
      }
    }
    logDiagnostic({ diagnostic: { event: "released" } });
  }
  if (runtime && releaseRuntime) {
    const previous = runtime; runtime = undefined;
    await previous.core.api.llama_backend_free();
  }
}
export async function invalidateStoredModel({ id }: { id: string }): Promise<void> {
  if (resident && resident.id === id) await releaseSession({ releaseRuntime: false });
}
type SessionRequest = Pick<WorkerGenerateInput, 'model' | 'options' | 'assetBaseURL' | 'debug'>;
type ProjectorPolicy = 'load-if-present' | 'defer';
type SessionPurpose = { kind: 'chat', projector: ProjectorPolicy } | { kind: 'audio', contextTokens: number, audioBackend: AudioBackend };
type SessionPreparation = {
  projector: 'absent' | 'deferred' | 'retained' | 'loaded' | 'reused',
  releasedTextContext: boolean,
};

/** Explicit preparation continues to load every available companion. */
export async function prepareSession({ request, onProgress, signal }: {
  request: SessionRequest, onProgress: ({ progress }: { progress: Progress }) => void, signal: AbortSignal | undefined,
}) {
  return prepareChatSession({ request, onProgress, signal, projector: 'load-if-present' });
}

/** A text-only request needs the LM, not the image encoder. Inspect all history
 * parts, not just the latest message; text resembling an image marker is text. */
export async function prepareGenerationSession({ request, onProgress, signal }: {
  request: WorkerGenerateInput, onProgress: ({ progress }: { progress: Progress }) => void, signal: AbortSignal | undefined,
}) {
  const needsProjector = request.messages.some(message => typeof message.content !== 'string' && message.content.some(part => {
    switch (part.type) {
    case 'image': return true;
    case 'text': return false;
    default: { const exhaustive: never = part; throw new Error(String(exhaustive)); }
    }
  }));
  return prepareChatSession({ request, onProgress, signal, projector: needsProjector ? 'load-if-present' : 'defer' });
}

async function prepareChatSession({ request, onProgress, signal, projector }: {
  request: SessionRequest, onProgress: ({ progress }: { progress: Progress }) => void, signal: AbortSignal | undefined,
  projector: ProjectorPolicy,
}) {
  const session = await prepareResidentSession({ request, onProgress, signal, purpose: { kind: 'chat', projector } });
  if (session.sequenceRemoval === undefined || session.chatMetadata === undefined) throw new LlamaCppBrowserError({ code: 'runtime-error' });
  return { ...session, sequenceRemoval: session.sequenceRemoval, ...session.chatMetadata };
}

/** Images already invalidate text-prefix reuse. Before the first deferred
 * projector load, restore the original projector-before-context allocation
 * order instead of adding it on top of a large text context. Keep LM weights. */
async function releaseTextContextForProjector({ core, current }: { core: Core, current: ResidentModel }): Promise<void> {
  const context = current.context;
  const checkpoint = current.cache.checkpoint;
  current.context = 0n;
  current.chatMetadata = undefined;
  current.contextProjector = undefined;
  current.sequenceRemoval = undefined;
  current.slidingWindow = 0;
  current.cache.checkpoint = undefined;
  current.cache.tokens = [];
  current.cache.validity = 'invalid';
  current.cache.initialMemoryState = 'unknown';
  try {
    disposePromptCheckpoint({ core, checkpoint });
  } finally {
    if (context !== 0n) await core.api.llama_free(context);
  }
}

/** Audio is a fresh, bounded context, never a chat-cache continuation. The caller
 * owns releaseSession in a finally block, including failures during preparation. */
export async function prepareAudioSession({ request, contextTokens, audioBackend, onProgress, signal }: {
  request: SessionRequest, contextTokens: number, audioBackend: AudioBackend,
  onProgress: ({ progress }: { progress: Progress }) => void, signal: AbortSignal | undefined,
}) {
  if (signal?.aborted) throw new LlamaCppBrowserError({ code: 'aborted' });
  await releaseSession({ releaseRuntime: false });
  return prepareResidentSession({ request, onProgress, signal, purpose: { kind: 'audio', contextTokens, audioBackend } });
}

async function prepareResidentSession({ request, purpose, onProgress, signal }: {
  request: SessionRequest, purpose: SessionPurpose,
  onProgress: ({ progress }: { progress: Progress }) => void, signal: AbortSignal | undefined,
}) {
  const checkCancelled = (): void => {
    if (signal?.aborted) {
      if (resident) {
        resident.cache.validity = 'invalid';
        resident.cache.initialMemoryState = 'unknown';
        const checkpoint = resident.cache.checkpoint; resident.cache.checkpoint = undefined;
        if (runtime) disposePromptCheckpoint({ core: runtime.core, checkpoint });
      }
      throw new LlamaCppBrowserError({ code: "aborted" });
    }
  };
  checkCancelled();
  const profile = runtime?.requestedProfile === request.options.profile && runtime.assetBaseURL === request.assetBaseURL
    ? runtime.profile : await resolveRuntimeProfile({ profile: request.options.profile });
  checkCancelled();
  if (!runtime || runtime.profile !== profile || runtime.assetBaseURL !== request.assetBaseURL) {
    await releaseSession({ releaseRuntime: true });
    onProgress({ progress: { phase: "initializing", completed: 0, total: 0 } });
    runtime = { profile, requestedProfile: request.options.profile, assetBaseURL: request.assetBaseURL, core: await loadRuntime({ profile, assetBaseURL: request.assetBaseURL }) };
  }
  runtime.requestedProfile = request.options.profile;
  const core = runtime.core; const api = core.api;
  const directory = await storedModelDirectory({ name: request.model });
  if (purpose.kind === 'audio' && !directory.projectorPath) throw new LlamaCppBrowserError({ code: 'audio-model-unsupported' });
  let unchanged = resident?.id === directory.id && resident.files.length === directory.files.length;
  if (unchanged && resident) {
    for (let index = 0; index < directory.files.length; index++) {
      const next = directory.files[index]!; const previous = resident.files[index]!;
      if (previous.path !== next.path || previous.file.size !== next.file.size || previous.file.lastModified !== next.file.lastModified || !await previous.handle.isSameEntry(next.handle)) {
        unchanged = false; break;
      }
    }
  }
  if (resident && !unchanged) await releaseSession({ releaseRuntime: false });
  checkCancelled();
  if (!resident) {
    const mounts: ReturnType<typeof mountReadOnlyFile>[] = [];
    const accesses: { close(): void }[] = [];
    const allocations: bigint[] = []; let callback: number | bigint | undefined; let model = 0n;
    const reportFileReads = (() => {
      const debug = request.debug ?? 'off';
      switch (debug) {
      case 'on': return true;
      case 'off': return false;
      default: { const exhaustive: never = debug; throw new Error(String(exhaustive)); }
      }
    })();
    const readCache = createModelReadCache({ mode: 'read-ahead', now: reportFileReads ? () => performance.now() : undefined });
    const started = performance.now();
    logDiagnostic({ diagnostic: { event: "load-start", profile } });
    try {
      for (const entry of directory.files.filter(file => file.path !== directory.projectorPath)) {
        checkCancelled();
        const nativeHandle = entry.handle as FileSystemFileHandle & { createSyncAccessHandle?: () => Promise<{
          getSize(): number,
          // eslint-disable-next-line local-rules-named-args/require-named-args -- Native OPFS callback ABI.
          read(destination: Uint8Array, options: { at: number }): number,
          close(): void,
        }> };
        if (!nativeHandle.createSyncAccessHandle) throw new LlamaCppBrowserError({ code: 'unavailable' });
        const access = await nativeHandle.createSyncAccessHandle(); accesses.push(access);
        // Retain ownership before cancellation can throw. Do not open the next
        // shard or start native loading after a cancelled storage acquisition.
        checkCancelled();
        if (access.getSize() !== entry.file.size) throw new LlamaCppBrowserError({ code: 'storage-error' });
        mounts.push(mountReadOnlyFile({
          core,
          path: `/models/${entry.path}`,
          source: readCache.wrap({
          source: {
          size: access.getSize(),
          read({ destination, offset }) {
          return access.read(destination, { at: offset });
        },
        },
        }),
          maxChunkBytes: 8 * 1024 * 1024,
        }));
      }
      checkCancelled();
      const params = core.allocRecord({ name: "llama_model_params" }); allocations.push(params);
      await api.llama_model_default_params(params);
      for (const [field, value] of Object.entries({
        n_gpu_layers: usesWebGpu({ profile }) ? 999 : 0,
        load_mode: core.constant({ name: "LLAMA_LOAD_MODE_NONE" }),
        lazy_mode: core.constant({ name: "LLAMA_LAZY_MODE_OFF" }),
        check_tensors: 0,
      })) {
        core.setField({ name: "llama_model_params", pointer: params, field: field, value: value });
      }
      let lastProgress = 0;
      callback = core.module.addFunction((amount: number) => {
        if (performance.now() - lastProgress > 150) {
          onProgress({ progress: { phase: "loading", completed: Math.max(0, Math.min(1, amount)), total: 1 } }); lastProgress = performance.now();
        }
        return signal?.aborted ? 0 : 1;
      }, core.pointerBytes === 8 ? "ifj" : "ifi");
      core.setField({ name: "llama_model_params", pointer: params, field: "progress_callback", value: BigInt(callback) });
      const path = core.utf8({ text: `/models/${directory.modelPath}` }); allocations.push(path);
      onProgress({ progress: { phase: "loading", completed: 0, total: 1 } });
      checkCancelled();
      const weights = directory.files.filter(entry => entry.path !== directory.projectorPath);
      if (weights.length > 1) {
        const pointers = core.alloc({ bytes: weights.length * core.pointerBytes }); allocations.push(pointers);
        const paths = weights.map(entry => {
          const value = core.utf8({ text: `/models/${entry.path}` }); allocations.push(value); return value;
        });
        const bytes = core.bytes({ pointer: pointers, length: paths.length * core.pointerBytes }); const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        paths.forEach((value, index) => {
          if (core.pointerBytes === 8) view.setBigUint64(index * 8, value, true); else view.setUint32(index * 4, Number(value), true);
        });
        // Explicit paths preserve original casing and nested placement for every shard.
        model = await api.llama_model_load_from_splits(pointers, BigInt(weights.length), params);
      } else model = await api.llama_model_load_from_file(path, params);
      checkCancelled();
      if (model === 0n) throw new LlamaCppBrowserError({ code: "runtime-error" });
      resident = { model, projector: undefined, context: 0n, sequenceRemoval: undefined, slidingWindow: 0, cache: { tokens: [], validity: 'invalid', checkpoint: undefined, initialMemoryState: 'unknown' }, name: request.model, id: directory.id, files: directory.files, chatMetadata: undefined, contextProjector: undefined };
      model = 0n;
      onProgress({ progress: { phase: "loading", completed: 1, total: 1 } });
      logDiagnostic({ diagnostic: { event: "load-complete", elapsedMs: performance.now() - started, profile } });
    } finally {
      try {
        if (model !== 0n) await api.llama_model_free(model);
        if (callback !== undefined) core.module.removeFunction(callback);
        for (const pointer of allocations.reverse()) core.free({ pointer: pointer });
      } finally {
        try {
          releaseModelFiles({ mounts, accesses });
        } finally {
          readCache.dispose();
          try {
            if (reportFileReads) logDiagnostic({
              diagnostic: {
              event: 'file-read-performance',
              profile,
              fileReads: { target: 'model', ...readCache.counters },
            },
            });
          } catch { /* Read diagnostics must not replace the load/cleanup result. */ }
        }
      }
    }
  } else {
    logDiagnostic({ diagnostic: { event: "model-reused", profile } });
  }
  const current = resident;
  if (!current) throw new LlamaCppBrowserError({ code: "runtime-error" });
  checkCancelled();
  const debug = request.debug ?? 'off';
  const useProjector = purpose.kind === 'audio' || purpose.projector === 'load-if-present';
  const preparation: SessionPreparation = {
    projector: directory.projectorPath ? (useProjector ? 'reused' : current.projector ? 'retained' : 'deferred') : 'absent',
    releasedTextContext: false,
  };
  if (useProjector && directory.projectorPath && (!current.projector || current.projector.debug !== debug)) {
    // Weight loading is complete, but companion/context setup has no measured
    // denominator. Do not keep advertising a completed load percentage here.
    onProgress({ progress: { phase: "initializing", completed: 0, total: 0 } });
    checkCancelled();
    if (!current.projector && current.context !== 0n && current.contextProjector === 'absent') {
      await releaseTextContextForProjector({ core, current });
      preparation.releasedTextContext = true;
      checkCancelled();
    }
    // For an already loaded companion, debug replacement preserves LM/KV.
    // Text-only requests do not reload a companion just to change its trace.
    await current.projector?.release();
    current.projector = undefined;
    checkCancelled();
    const file = directory.files.find(file => file.path === directory.projectorPath);
    if (!file) throw new LlamaCppBrowserError({ code: 'storage-error' });
    switch (purpose.kind) {
    case 'chat': current.projector = await loadProjector({ core, model: current.model, file, profile, debug, signal }); break;
    case 'audio': current.projector = await loadProjectorForBackend({ core, model: current.model, file, profile, debug, signal, backend: purpose.audioBackend }); break;
    default: { const exhaustive: never = purpose; throw new Error(String(exhaustive)); }
    }
    preparation.projector = 'loaded';
  }
  checkCancelled();
  if (current.context === 0n) {
    const started = performance.now();
    onProgress({ progress: { phase: "initializing", completed: 0, total: 0 } });
    checkCancelled();
    logDiagnostic({ diagnostic: { event: "context-start", profile } });
    const cp = core.allocRecord({ name: "llama_context_params" });
    let failed = false;
    try {
      await api.llama_context_default_params(cp);
      const swaField = core.fieldLayout({ name: 'llama_context_params', field: 'swa_full' });
      if (swaField.kind !== 'boolean' || swaField.size !== 1) throw new LlamaCppBrowserError({ code: 'runtime-error' });
      // Full SWA retention needs no extra SWA snapshot. Read the actual native
      // default instead of assuming that every model with n_swa needs one.
      const swaFull = core.bytes({ pointer: cp + swaField.offset, length: 1 })[0] !== 0;
      current.slidingWindow = swaFull ? 0 : await api.llama_model_n_swa(current.model);
      for (const [field, value] of Object.entries({ n_ubatch: prefillMicroBatchTokens, n_threads: 1, n_threads_batch: 1 })) {
        core.setField({ name: "llama_context_params", pointer: cp, field: field, value: value });
      }
      const trainingSize = await api.llama_model_n_ctx_train(current.model);
      // This is an application allocation target, not an estimate of free device memory.
      // Reject unknown metadata; n_ctx=0 delegates to the model training capacity.
      if (!Number.isSafeInteger(trainingSize) || trainingSize < 1) throw new LlamaCppBrowserError({ code: "runtime-error" });
      let contextTarget: number;
      switch (purpose.kind) {
      case 'chat': contextTarget = 32768; break;
      case 'audio':
        contextTarget = purpose.contextTokens;
        core.setField({ name: 'llama_context_params', pointer: cp, field: 'embeddings', value: 1 });
        core.setField({ name: 'llama_context_params', pointer: cp, field: 'pooling_type', value: core.constant({ name: 'LLAMA_POOLING_TYPE_NONE' }) });
        break;
      default: { const exhaustive: never = purpose; throw new Error(String(exhaustive)); }
      }
      const target = Math.min(contextTarget, trainingSize);
      const floor = Math.min(4096, target);
      let requested = target;
      // Wider logical batches are a chat optimization. Audio contexts keep
      // the established batch size and allocation/fallback behavior.
      let configuredPrefillBatchTokens: number;
      switch (purpose.kind) {
      case 'chat': configuredPrefillBatchTokens = prefillBatchTokens; break;
      case 'audio': configuredPrefillBatchTokens = prefillMicroBatchTokens; break;
      default: { const exhaustive: never = purpose; throw new Error(String(exhaustive)); }
      }
      while (true) {
        core.setField({ name: "llama_context_params", pointer: cp, field: "n_batch", value: configuredPrefillBatchTokens });
        core.setField({ name: "llama_context_params", pointer: cp, field: "n_ctx", value: requested });
        current.context = await api.llama_init_from_model(current.model, cp);
        checkCancelled();
        if (current.context !== 0n) {
          current.contextProjector = current.projector ? 'present' : 'absent';
          break;
        }
        // Preserve context capacity before sacrificing it for a performance-only
        // logical batch increase. The microbatch remains conservative in both cases.
        if (configuredPrefillBatchTokens > prefillMicroBatchTokens) {
          configuredPrefillBatchTokens = prefillMicroBatchTokens;
          logDiagnostic({ diagnostic: { event: "context-retry", contextTokens: requested, batchTokens: configuredPrefillBatchTokens, reason: 'context-allocation' } });
          continue;
        }
        // A normal null return is recoverable; exceptions/traps must never enter this loop.
        if (requested === floor) throw new LlamaCppBrowserError({ code: "runtime-error" });
        requested = Math.max(floor, Math.floor(requested / 2));
        logDiagnostic({ diagnostic: { event: "context-retry", contextTokens: requested, batchTokens: configuredPrefillBatchTokens, reason: 'context-allocation' } });
      }
      try {
        switch (purpose.kind) {
        case 'chat': current.sequenceRemoval = await probeNewContextSequenceRemoval({ core, context: current.context }); break;
        case 'audio': break;
        default: { const exhaustive: never = purpose; throw new Error(String(exhaustive)); }
        }
      } catch (error) {
        logFailure({ stage: 'cache-probe', error });
        throw error;
      }
      checkCancelled();
      const contextTokens = await api.llama_n_ctx(current.context);
      if (!Number.isSafeInteger(contextTokens) || contextTokens < 1) throw new LlamaCppBrowserError({ code: 'runtime-error' });
      switch (purpose.kind) {
      case 'chat': {
        const vocab = await api.llama_model_get_vocab(current.model);
        const memory = await api.llama_get_memory(current.context);
        const nativeRollbackTokens = await api.llama_n_rs_seq(current.context);
        const nativeBatchTokens = await api.llama_n_batch(current.context);
        if (!Number.isSafeInteger(nativeBatchTokens) || nativeBatchTokens < 1) throw new LlamaCppBrowserError({ code: 'runtime-error' });
        if (vocab === 0n || !Number.isSafeInteger(nativeRollbackTokens) || nativeRollbackTokens < 0) throw new LlamaCppBrowserError({ code: 'runtime-error' });
        current.chatMetadata = { vocab, contextTokens, memory, nativeRollbackTokens, prefillBatchTokens: Math.min(configuredPrefillBatchTokens, nativeBatchTokens) };
        // The probe's finally block completed both clear and synchronize. Do
        // not infer this from sequence-removal support or an empty token list.
        current.cache.initialMemoryState = memory === 0n ? 'unknown' : 'probe-cleared';
        break;
      }
      case 'audio': current.chatMetadata = undefined; break;
      default: { const exhaustive: never = purpose; throw new Error(String(exhaustive)); }
      }
      logDiagnostic({ diagnostic: { event: "context-ready", cacheRemoval: current.sequenceRemoval, slidingWindowTokens: current.slidingWindow, contextTokens, elapsedMs: performance.now() - started, profile } });
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      try {
        core.free({ pointer: cp });
      } finally {
        if (failed) await releaseSession({ releaseRuntime: true });
      }
    }
  }
  checkCancelled();
  return { core, model: current.model, context: current.context, sequenceRemoval: current.sequenceRemoval, slidingWindow: current.slidingWindow, cache: current.cache, projector: useProjector ? current.projector?.pointer ?? 0n : 0n, chatMetadata: current.chatMetadata, preparation };
}
export const TEST_ONLY = {
  residentContext: () => resident?.context,
  residentModel: () => resident?.model,
};
