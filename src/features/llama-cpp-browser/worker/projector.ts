import { openModelFileAccess } from './model-file-access';
import type { AudioBackend } from '@/features/audio-generation/types';
import type { Core } from '@/features/llama-cpp-browser/runtime/core';
import type { ModelFile } from '@/features/llama-cpp-browser/runtime/model-directory';
import { mountReadOnlyFile } from '@/features/llama-cpp-browser/runtime/read-only-file';
import { createModelReadCache } from '@/features/llama-cpp-browser/runtime/model-read-cache';
import { logDiagnostic, logFailure, logOperation } from '@/features/llama-cpp-browser/debug-log';
import { LlamaCppBrowserError, usesWebGpu, type LlamaCppProfile } from '@/features/llama-cpp-browser/types';
import type { VisionBf16Storage, VisionBf16StorageObservation } from '@/features/llama-cpp-browser/runtime/vision-bf16-storage-schema';
import { createProjectorTrace } from './projector-trace';

export type ResidentProjector = { pointer: bigint, debug: 'off' | 'on', purpose: 'chat' | 'audio', visionStorage: Readonly<VisionBf16StorageObservation> | undefined, release: () => Promise<void> };

export async function loadProjector({ core, model, file, profile, debug, signal, visionBf16Storage, observation }: {
  core: Core, model: bigint, file: ModelFile, profile: LlamaCppProfile, debug: 'off' | 'on', signal: AbortSignal | undefined, visionBf16Storage: VisionBf16Storage | undefined, observation: 'enabled' | 'disabled',
}): Promise<ResidentProjector> {
  return loadProjectorForBackend({ core, model, file, profile, debug, signal, backend: 'profile', purpose: 'chat', visionBf16Storage, observation });
}

export async function loadProjectorForBackend({ core, model, file, profile, debug, signal, backend, purpose, visionBf16Storage, observation }: {
  core: Core, model: bigint, file: ModelFile, profile: LlamaCppProfile, debug: 'off' | 'on', signal: AbortSignal | undefined, backend: AudioBackend, purpose: 'chat' | 'audio', visionBf16Storage: VisionBf16Storage | undefined, observation: 'enabled' | 'disabled',
}): Promise<ResidentProjector> {
  const checkCancelled = (): void => {
    if (signal?.aborted) {
      throw new LlamaCppBrowserError({ code: 'aborted' });
    }
  };
  checkCancelled();
  let storage: Awaited<ReturnType<typeof import('@/features/llama-cpp-browser/runtime/vision-bf16-storage')['prepareVisionBf16Loader']>> | undefined;
  const recordStorage = (): void => {
    switch (observation) {
    case 'enabled':
      if (storage) {
        logDiagnostic({ diagnostic: { event: 'native-info', visionStorage: storage.observed } });
      }
      break;
    case 'disabled': break;
    default: {
      const exhaustive: never = observation;
      throw new Error(String(exhaustive));
    }
    }
  };
  switch (purpose) {
  case 'chat': {
    const { prepareVisionBf16Loader } = await import('@/features/llama-cpp-browser/runtime/vision-bf16-storage');
    storage = await prepareVisionBf16Loader({ core, preference: visionBf16Storage });
    checkCancelled();
    recordStorage();
    const status = storage.observed.status;
    switch (status) {
    case 'unavailable': throw new LlamaCppBrowserError({ code: 'unavailable' });
    case 'selected': case 'initialized': break;
    default: {
      const exhaustive: never = status;
      throw new Error(String(exhaustive));
    }
    }
    break;
  }
  case 'audio': break;
  default: {
    const exhaustive: never = purpose;
    throw new Error(String(exhaustive));
  }
  }
  const reportFileReads = (() => {
    switch (debug) {
    case 'on': return true;
    case 'off': return false;
    default: {
      const exhaustive: never = debug;
      throw new Error(String(exhaustive));
    }
    }
  })();
  const access = await openModelFileAccess({ entry: file });
  const readCache = createModelReadCache({ mode: 'read-ahead', now: reportFileReads ? () => performance.now() : undefined });
  let mounted: ReturnType<typeof mountReadOnlyFile> | undefined;
  let trace: ReturnType<typeof createProjectorTrace> | undefined;
  const allocations: bigint[] = [];
  let pointer = 0n;
  let nativeReleaseFailure: { error: unknown } | undefined;
  const release = async (): Promise<void> => {
    if (nativeReleaseFailure) {
      throw nativeReleaseFailure.error;
    }
    if (pointer !== 0n) {
      // If destruction fails, keep the callback valid and let the host discard the worker.
      try {
        await core.api.mtmd_free(pointer);
      } catch (error) {
        nativeReleaseFailure = { error };
        throw error;
      }
      pointer = 0n;
    }
    trace?.release();
    trace = undefined;
  };
  const cleanupTemporary = async (): Promise<void> => {
    let failure: { error: unknown } | undefined;
    try {
      try {
        for (const allocation of allocations.reverse()) {
          core.free({ pointer: allocation });
        }
      } finally {
        mounted?.remove();
      }
    } catch (error) {
      failure = { error };
    }
    try {
      access.close();
    } catch (error) {
      failure ??= { error };
    }
    if (failure) {
      await release();
      throw failure.error;
    }
  };
  try {
    checkCancelled();
    if (access.getSize() !== file.file.size) {
      throw new LlamaCppBrowserError({ code: 'storage-error' });
    }
    const readWithTail = access.readWithTail?.bind(access);
    mounted = mountReadOnlyFile({
      core,
      path: `/models/${file.relativePath}`,
      source: readCache.wrap({
        source: {
          size: access.getSize(),
          ...(readWithTail ? { readWithTail } : {}),
          read({ destination, offset }) {
            return access.read(destination, { at: offset });
          },
        },
      }),
      maxChunkBytes: 8 * 1024 * 1024,
    });
    const params = core.allocRecord({ name: 'mtmd_context_params' });
    allocations.push(params);
    await core.api.mtmd_context_params_default(params);
    core.setField({ name: 'mtmd_context_params', pointer: params, field: 'use_gpu', value: backend === 'profile' && usesWebGpu({ profile }) ? 1 : 0 });
    core.setField({ name: 'mtmd_context_params', pointer: params, field: 'n_threads', value: 1 });
    switch (debug) {
    case 'on': trace = createProjectorTrace({ core });
      break;
    case 'off': break;
    default: {
      const exhaustive: never = debug;
      throw new Error(String(exhaustive));
    }
    }
    core.setField({ name: 'mtmd_context_params', pointer: params, field: 'cb_eval', value: trace ? BigInt(trace.pointer) : 0n });
    core.setField({ name: 'mtmd_context_params', pointer: params, field: 'cb_eval_user_data', value: 0n });
    const path = core.utf8({ text: `/models/${file.relativePath}` });
    allocations.push(path);
    checkCancelled();
    await logOperation({ diagnostic: { event: 'operation-start', stage: 'projector-load', profile } });
    pointer = storage ? await storage.initialize({ path, model, params }) : await core.api.mtmd_init_from_file(path, model, params);
    if (pointer !== 0n && storage) {
      checkCancelled();
      await storage.confirm({ pointer });
      recordStorage();
    }
    await logOperation({ diagnostic: { event: 'operation-complete', stage: 'projector-load', statusCode: pointer === 0n ? 1 : 0, profile } });
    checkCancelled();
    if (pointer === 0n) {
      throw new LlamaCppBrowserError({ code: 'unsupported-input' });
    }

  } catch (error) {
    recordStorage();
    logFailure({ stage: 'projector-load', error });
    try {
      await release();
    } catch (cleanupError) {
      logFailure({ stage: 'cleanup', error: cleanupError });
      throw cleanupError;
    }
    throw error;
  } finally {
    try {
      await cleanupTemporary();
    } catch (cleanupError) {
      logFailure({ stage: 'cleanup', error: cleanupError });
      // eslint-disable-next-line no-unsafe-finally -- Incomplete native cleanup must retire the worker, including after cancellation.
      throw cleanupError;
    } finally {
      readCache.dispose();
      try {
        if (reportFileReads) {
          logDiagnostic({
            diagnostic: {
              event: 'file-read-performance',
              profile,
              fileReads: { target: 'projector', ...readCache.counters },
            },
          });
        }
      } catch { /* Read diagnostics must not replace the load/cleanup result. */ }
    }
  }
  // Transfer native ownership only after temporary filesystem resources are closed.
  return { pointer, debug, purpose, visionStorage: storage ? Object.freeze({ ...storage.observed }) : undefined, release };
}

export const TEST_ONLY = {
};
