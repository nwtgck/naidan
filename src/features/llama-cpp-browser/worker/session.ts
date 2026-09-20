import type { Core } from "@/features/llama-cpp-browser/runtime/core";
import { mountReadOnlyFile } from "@/features/llama-cpp-browser/runtime/read-only-file";
import { LlamaCppBrowserError, usesWebGpu, type LlamaCppProfile, type Progress, type RuntimeOptions } from "@/features/llama-cpp-browser/types";
import { storedModelHandle } from "@/features/llama-cpp-browser/runtime/model-store";
import { loadRuntime } from "@/features/llama-cpp-browser/runtime/load-runtime";
import { resolveRuntimeProfile } from "@/features/llama-cpp-browser/runtime/detect-profile";
import { logDiagnostic } from "@/features/llama-cpp-browser/debug-log";
import type { WorkerGenerateInput } from "./types";

type ResidentModel = { model: bigint, context: bigint, contextSize: number, name: string,
  handle: FileSystemFileHandle, size: number, modified: number };
let runtime: { core: Core, profile: LlamaCppProfile, requestedProfile: RuntimeOptions['profile'], assetBaseURL: string } | undefined;
let resident: ResidentModel | undefined;

/** Keep one model resident. Storage locks/handles are only needed while reading,
 * not throughout the idle GPU lifetime. KV and samplers remain request-local. */
export async function releaseSession({ releaseRuntime }: { releaseRuntime: boolean }): Promise<void> {
  const current = resident; resident = undefined;
  if (runtime && current) {
    try {
      if (current.context !== 0n) await runtime.core.api.llama_free(current.context);
    } finally {
      await runtime.core.api.llama_model_free(current.model);
    }
    logDiagnostic({ diagnostic: { event: "released" } });
  }
  if (runtime && releaseRuntime) {
    const previous = runtime; runtime = undefined;
    await previous.core.api.llama_backend_free();
  }
}
export async function invalidateStoredModel({ id }: { id: string }): Promise<void> {
  if (resident && (id.split("/")[1] === resident.name || id === `user/${resident.name.slice(0, -5)}-GGUF/${resident.name}`)) await releaseSession({ releaseRuntime: false });
}
export async function prepareSession({ request, onProgress, signal }: {
  request: WorkerGenerateInput, onProgress: ({ progress }: { progress: Progress }) => void, signal: AbortSignal | undefined,
}): Promise<{ core: Core, model: bigint, context: bigint }> {
  const checkCancelled = (): void => {
    if (signal?.aborted) throw new LlamaCppBrowserError({ code: "aborted" });
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
  const handle = await storedModelHandle({ name: request.model });
  const file = await handle.getFile();
  if (resident && (resident.name !== request.model || resident.size !== file.size || resident.modified !== file.lastModified
    || !await resident.handle.isSameEntry(handle))) await releaseSession({ releaseRuntime: false });
  checkCancelled();
  if (!resident) {
    const nativeHandle = handle as FileSystemFileHandle & { createSyncAccessHandle?: () => Promise<{
      getSize(): number,
      // eslint-disable-next-line local-rules-named-args/require-named-args -- Native FileSystemSyncAccessHandle has positional arguments.
      read(destination: Uint8Array, options: { at: number }): number,
      close(): void,
    }> };
    if (!nativeHandle.createSyncAccessHandle) throw new LlamaCppBrowserError({ code: "unavailable" });
    const access = await nativeHandle.createSyncAccessHandle();
    let mounted: ReturnType<typeof mountReadOnlyFile> | undefined;
    const allocations: bigint[] = []; let callback: number | bigint | undefined; let model = 0n;
    const started = performance.now();
    logDiagnostic({ diagnostic: { event: "load-start", profile } });
    try {
      if (access.getSize() !== file.size) throw new LlamaCppBrowserError({ code: "storage-error" });
      mounted = mountReadOnlyFile({ core, path: "/models/model.gguf", source: { size: access.getSize(), read({ destination, offset }) {
        return access.read(destination, { at: offset });
      } }, maxChunkBytes: 8 * 1024 * 1024 });
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
      const path = core.utf8({ text: mounted.path }); allocations.push(path);
      onProgress({ progress: { phase: "loading", completed: 0, total: 1 } });
      model = await api.llama_model_load_from_file(path, params);
      checkCancelled();
      if (model === 0n) throw new LlamaCppBrowserError({ code: "runtime-error" });
      resident = { model, context: 0n, contextSize: 0, name: request.model, handle, size: file.size, modified: file.lastModified };
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
          mounted?.remove();
        } finally {
          access.close();
        }
      }
    }
  } else {
    logDiagnostic({ diagnostic: { event: "model-reused", profile } });
  }
  const current = resident;
  if (!current) throw new LlamaCppBrowserError({ code: "runtime-error" });
  checkCancelled();
  if (current.context === 0n || current.contextSize !== request.options.contextSize) {
    const old = current.context; current.context = 0n;
    if (old !== 0n) await api.llama_free(old);
    const cp = core.allocRecord({ name: "llama_context_params" }); const started = performance.now();
    onProgress({ progress: { phase: "initializing", completed: 0, total: 0 } });
    logDiagnostic({ diagnostic: { event: "context-start", profile } });
    try {
      await api.llama_context_default_params(cp);
      for (const [field, value] of Object.entries({ n_ctx: request.options.contextSize, n_batch: 128, n_ubatch: 128, n_threads: 1, n_threads_batch: 1 })) {
        core.setField({ name: "llama_context_params", pointer: cp, field: field, value: value });
      }
      current.context = await api.llama_init_from_model(current.model, cp);
      current.contextSize = request.options.contextSize;
      checkCancelled();
      if (current.context === 0n) throw new LlamaCppBrowserError({ code: "runtime-error" });
      logDiagnostic({ diagnostic: { event: "context-ready", elapsedMs: performance.now() - started, profile } });
    } finally {
      core.free({ pointer: cp });
    }
  }
  checkCancelled();
  return { core, model: current.model, context: current.context };
}
export const TEST_ONLY = {
  residentContext: () => resident?.context,
};
