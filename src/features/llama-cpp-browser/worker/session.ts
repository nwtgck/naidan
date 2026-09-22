import type { BlobContext } from '@/utils/blob-view';
import type { ModelFile } from '@/features/llama-cpp-browser/runtime/model-directory';
import type { Core } from "@/features/llama-cpp-browser/runtime/core";
import { mountReadOnlyFile } from "@/features/llama-cpp-browser/runtime/read-only-file";
import { LlamaCppBrowserError, usesWebGpu, type LlamaCppProfile, type Progress, type RuntimeOptions } from "@/features/llama-cpp-browser/types";
import { storedModelDirectory } from "@/features/llama-cpp-browser/runtime/model-store";
import { loadRuntime } from "@/features/llama-cpp-browser/runtime/load-runtime";
import { resolveRuntimeProfile } from "@/features/llama-cpp-browser/runtime/detect-profile";
import { logDiagnostic, logFailure } from "@/features/llama-cpp-browser/debug-log";
import type { WorkerGenerateInput } from "./types";
import { loadProjector, type ResidentProjector } from "./projector";
import { probeNewContextSequenceRemoval, type SequenceRemoval } from './cache-capabilities';
import { disposePromptCheckpoint, type PromptCheckpoint } from './prompt-checkpoint';

export type PromptCache = { tokens: number[], validity: 'valid' | 'invalid', checkpoint: PromptCheckpoint | undefined };

type ResidentModel = { model: bigint, context: bigint, sequenceRemoval: SequenceRemoval | undefined, slidingWindow: number, cache: PromptCache, name: string,
  id: string, files: ModelFile[], projector: ResidentProjector | undefined };
let runtime: { core: Core, profile: LlamaCppProfile, requestedProfile: RuntimeOptions['profile'], assetBaseURL: string | undefined } | undefined;
let resident: ResidentModel | undefined;

/** Keep one model resident. Storage locks/handles are only needed while reading,
 * not throughout the idle GPU lifetime. The decoded token prefix stays with its context; samplers remain request-local. */
export async function releaseSession({ releaseRuntime }: { releaseRuntime: boolean }): Promise<void> {
  const current = resident; resident = undefined;
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
        await runtime.core.api.llama_model_free(current.model);
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
export async function prepareSession({ blobs, request, onProgress, signal }: {
  blobs?: BlobContext,
  request: WorkerGenerateInput, onProgress: ({ progress }: { progress: Progress }) => void, signal: AbortSignal | undefined,
}): Promise<{ core: Core, model: bigint, context: bigint, sequenceRemoval: SequenceRemoval, slidingWindow: number, cache: PromptCache, projector: bigint }> {
  const checkCancelled = (): void => {
    if (signal?.aborted) {
      if (resident) {
        resident.cache.validity = 'invalid';
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
  const directory = await storedModelDirectory({ name: request.model, blobs, signal });
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
    const started = performance.now();
    logDiagnostic({ diagnostic: { event: "load-start", profile } });
    try {
      for (const entry of directory.files.filter(file => file.path !== directory.projectorPath)) {
        const nativeHandle = entry.handle as FileSystemFileHandle & { createSyncAccessHandle?: () => Promise<{
          getSize(): number,
          // eslint-disable-next-line local-rules-named-args/require-named-args -- Native OPFS callback ABI.
          read(destination: Uint8Array, options: { at: number }): number,
          close(): void,
        }> };
        if (!nativeHandle.createSyncAccessHandle) throw new LlamaCppBrowserError({ code: 'unavailable' });
        const access = await nativeHandle.createSyncAccessHandle(); accesses.push(access);
        if (access.getSize() !== entry.file.size) throw new LlamaCppBrowserError({ code: 'storage-error' });
        mounts.push(mountReadOnlyFile({ core, path: `/models/${entry.path}`, source: { size: access.getSize(), read({ destination, offset }) {
          return access.read(destination, { at: offset });
        } }, maxChunkBytes: 8 * 1024 * 1024 }));
      }
      const params = core.allocRecord({ name: "llama_model_params" }); allocations.push(params);
      await api.llama_model_default_params(params);
      for (const [field, value] of Object.entries({ n_gpu_layers: usesWebGpu({ profile }) ? 999 : 0,
        load_mode: core.constant({ name: "LLAMA_LOAD_MODE_NONE" }), lazy_mode: core.constant({ name: "LLAMA_LAZY_MODE_OFF" }), check_tensors: 0 })) {
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
      resident = { model, projector: undefined, context: 0n, sequenceRemoval: undefined, slidingWindow: 0, cache: { tokens: [], validity: 'invalid', checkpoint: undefined }, name: request.model, id: directory.id, files: directory.files };
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
          for (const mounted of mounts.reverse()) mounted.remove();
        } finally {
          for (const access of accesses.reverse()) access.close();
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
  if (directory.projectorPath && (!current.projector || current.projector.debug !== debug)) {
    // Debug callbacks belong only to the projector. Preserve the LM and its KV cache.
    await current.projector?.release();
    current.projector = undefined;
    checkCancelled();
    const file = directory.files.find(file => file.path === directory.projectorPath);
    if (!file) throw new LlamaCppBrowserError({ code: 'storage-error' });
    current.projector = await loadProjector({ core, model: current.model, file, profile, debug, signal });
  }
  checkCancelled();
  if (current.context === 0n) {
    const cp = core.allocRecord({ name: "llama_context_params" }); const started = performance.now();
    onProgress({ progress: { phase: "initializing", completed: 0, total: 0 } });
    logDiagnostic({ diagnostic: { event: "context-start", profile } });
    let failed = false;
    try {
      await api.llama_context_default_params(cp);
      const swaField = core.fieldLayout({ name: 'llama_context_params', field: 'swa_full' });
      if (swaField.kind !== 'boolean' || swaField.size !== 1) throw new LlamaCppBrowserError({ code: 'runtime-error' });
      // Full SWA retention needs no extra SWA snapshot. Read the actual native
      // default instead of assuming that every model with n_swa needs one.
      const swaFull = core.bytes({ pointer: cp + swaField.offset, length: 1 })[0] !== 0;
      current.slidingWindow = swaFull ? 0 : await api.llama_model_n_swa(current.model);
      for (const [field, value] of Object.entries({ n_batch: 128, n_ubatch: 128, n_threads: 1, n_threads_batch: 1 })) {
        core.setField({ name: "llama_context_params", pointer: cp, field: field, value: value });
      }
      const trainingSize = await api.llama_model_n_ctx_train(current.model);
      // This is an application allocation target, not an estimate of free device memory.
      // Reject unknown metadata; n_ctx=0 delegates to the model training capacity.
      if (!Number.isSafeInteger(trainingSize) || trainingSize < 1) throw new LlamaCppBrowserError({ code: "runtime-error" });
      const target = Math.min(32768, trainingSize);
      const floor = Math.min(4096, target);
      let requested = target;
      while (true) {
        core.setField({ name: "llama_context_params", pointer: cp, field: "n_ctx", value: requested });
        current.context = await api.llama_init_from_model(current.model, cp);
        checkCancelled();
        if (current.context !== 0n) break;
        // A normal null return is recoverable; exceptions/traps must never enter this loop.
        if (requested === floor) throw new LlamaCppBrowserError({ code: "runtime-error" });
        requested = Math.max(floor, Math.floor(requested / 2));
        logDiagnostic({ diagnostic: { event: "context-retry", contextTokens: requested, reason: 'context-allocation' } });
      }
      try {
        current.sequenceRemoval = await probeNewContextSequenceRemoval({ core, context: current.context });
      } catch (error) {
        logFailure({ stage: 'cache-probe', error });
        throw error;
      }
      checkCancelled();
      logDiagnostic({ diagnostic: { event: "context-ready", cacheRemoval: current.sequenceRemoval, slidingWindowTokens: current.slidingWindow, contextTokens: await api.llama_n_ctx(current.context), elapsedMs: performance.now() - started, profile } });
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
  if (current.sequenceRemoval === undefined) throw new LlamaCppBrowserError({ code: 'runtime-error' });
  return { core, model: current.model, context: current.context, sequenceRemoval: current.sequenceRemoval, slidingWindow: current.slidingWindow, cache: current.cache, projector: current.projector?.pointer ?? 0n };
}
export const TEST_ONLY = {
  residentContext: () => resident?.context,
  residentModel: () => resident?.model,
};
