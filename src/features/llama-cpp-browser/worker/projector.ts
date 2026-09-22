import type { Core } from '@/features/llama-cpp-browser/runtime/core';
import type { ModelFile } from '@/features/llama-cpp-browser/runtime/model-directory';
import { mountReadOnlyFile } from '@/features/llama-cpp-browser/runtime/read-only-file';
import { logFailure, logOperation } from '@/features/llama-cpp-browser/debug-log';
import { LlamaCppBrowserError, usesWebGpu, type LlamaCppProfile } from '@/features/llama-cpp-browser/types';
import { createProjectorTrace } from './projector-trace';

export type ResidentProjector = { pointer: bigint, debug: 'off' | 'on', release: () => Promise<void> };
export async function loadProjector({ core, model, file, profile, debug, signal }: {
  core: Core, model: bigint, file: ModelFile, profile: LlamaCppProfile, debug: 'off' | 'on', signal: AbortSignal | undefined,
}): Promise<ResidentProjector> {
  const checkCancelled = (): void => {
    if (signal?.aborted) throw new LlamaCppBrowserError({ code: 'aborted' });
  };
  checkCancelled();
  const handle = file.handle as FileSystemFileHandle & { createSyncAccessHandle?: () => Promise<{
    getSize(): number,
    // eslint-disable-next-line local-rules-named-args/require-named-args -- Native OPFS callback ABI.
    read(destination: Uint8Array, options: { at: number }): number,
    close(): void,
  }> };
  if (!handle.createSyncAccessHandle) throw new LlamaCppBrowserError({ code: 'unavailable' });
  const access = await handle.createSyncAccessHandle();
  let mounted: ReturnType<typeof mountReadOnlyFile> | undefined;
  let trace: ReturnType<typeof createProjectorTrace> | undefined;
  const allocations: bigint[] = []; let pointer = 0n;
  let nativeReleaseFailure: { error: unknown } | undefined;
  const release = async (): Promise<void> => {
    if (nativeReleaseFailure) throw nativeReleaseFailure.error;
    if (pointer !== 0n) {
      // If destruction fails, keep the callback valid and let the host discard the worker.
      try {
        await core.api.mtmd_free(pointer);
      } catch (error) {
        nativeReleaseFailure = { error }; throw error;
      }
      pointer = 0n;
    }
    trace?.release(); trace = undefined;
  };
  const cleanupTemporary = async (): Promise<void> => {
    let failure: { error: unknown } | undefined;
    try {
      try {
        for (const allocation of allocations.reverse()) core.free({ pointer: allocation });
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
      await release(); throw failure.error;
    }
  };
  try {
    checkCancelled();
    if (access.getSize() !== file.file.size) throw new LlamaCppBrowserError({ code: 'storage-error' });
    mounted = mountReadOnlyFile({ core, path: `/models/${file.path}`, source: { size: access.getSize(), read({ destination, offset }) {
      return access.read(destination, { at: offset });
    } }, maxChunkBytes: 8 * 1024 * 1024 });
    const params = core.allocRecord({ name: 'mtmd_context_params' }); allocations.push(params);
    await core.api.mtmd_context_params_default(params);
    core.setField({ name: 'mtmd_context_params', pointer: params, field: 'use_gpu', value: usesWebGpu({ profile }) ? 1 : 0 });
    core.setField({ name: 'mtmd_context_params', pointer: params, field: 'n_threads', value: 1 });
    switch (debug) {
    case 'on': trace = createProjectorTrace({ core }); break;
    case 'off': break;
    default: { const exhaustive: never = debug; throw new Error(String(exhaustive)); }
    }
    core.setField({ name: 'mtmd_context_params', pointer: params, field: 'cb_eval', value: trace ? BigInt(trace.pointer) : 0n });
    core.setField({ name: 'mtmd_context_params', pointer: params, field: 'cb_eval_user_data', value: 0n });
    const path = core.utf8({ text: `/models/${file.path}` }); allocations.push(path);
    checkCancelled();
    await logOperation({ diagnostic: { event: 'operation-start', stage: 'projector-load', profile } });
    pointer = await core.api.mtmd_init_from_file(path, model, params);
    await logOperation({ diagnostic: { event: 'operation-complete', stage: 'projector-load', statusCode: pointer === 0n ? 1 : 0, profile } });
    checkCancelled();
    if (pointer === 0n) throw new LlamaCppBrowserError({ code: 'unsupported-input' });

  } catch (error) {
    logFailure({ stage: 'projector-load', error });
    await release(); throw error;
  } finally {
    await cleanupTemporary();
  }
  // Transfer native ownership only after temporary filesystem resources are closed.
  return { pointer, debug, release };
}
export const TEST_ONLY = {
};
