import { createDownloadVerificationCandidateAcceptanceWorkerClient } from '@/features/transformers-js/download-verification/candidate-acceptance-worker/client-hosted';
import { awaitWithAbort } from '@/features/transformers-js/download-verification/logic/await-with-abort';
import type { DownloadVerificationRevisionAcceptanceObservation } from '@/features/transformers-js/download-verification/types';
import type { TransformersJsProductionInvestigationCandidate } from '@/features/transformers-js/types';
import type { RuntimeAcceptanceProgressCallback } from './runtime-acceptance-progress';
import { classifyProductionAcceptanceError, productionAcceptanceFailureStatus, serializeProductionAcceptanceError } from './production-acceptance-error';
import { readProductionLoadResultReceipt } from '@/features/transformers-js/runtime/production-load-receipt';

function productionDevice({ device }: { device: string }): 'webgpu' | 'wasm' {
  switch (device) {
  case 'webgpu':
  case 'wasm':
    return device;
  default:
    throw new Error(`Unexpected Production device: ${device}`);
  }
}

export async function acceptDownloadedProductionRevision({
  modelId,
  repositoryResolvedRevision,
  cacheRevision,
  loadRevision,
  candidates,
  signal,
  onProgress,
}: {
  modelId: string;
  repositoryResolvedRevision: string | undefined;
  cacheRevision: string;
  loadRevision?: string;
  candidates?: readonly TransformersJsProductionInvestigationCandidate[];
  signal?: AbortSignal;
  onProgress?: RuntimeAcceptanceProgressCallback;
}): Promise<DownloadVerificationRevisionAcceptanceObservation> {
  if (loadRevision === undefined && cacheRevision !== 'main') {
    throw new Error(`A revision-less Production load can only target the legacy main cache, not ${cacheRevision}`);
  }
  if (loadRevision !== undefined && loadRevision !== cacheRevision) {
    throw new Error(`The Production loader revision ${loadRevision} does not match the cache revision ${cacheRevision}`);
  }
  signal?.throwIfAborted();
  const reportProgress: RuntimeAcceptanceProgressCallback = ({ progress }) => {
    if (!signal?.aborted) onProgress?.({ progress });
  };
  reportProgress({ progress: { phase: 'revision-acceptance', revision: cacheRevision, candidate: undefined, info: undefined } });
  const client = createDownloadVerificationCandidateAcceptanceWorkerClient();
  try {
    const result = await (async () => {
      if (candidates === undefined) {
        return await awaitWithAbort({
          operation: client.verifyDownloadedModelRevision({
            modelId,
            loadRevision,
            progressCallback: ({ info }) => reportProgress({ progress: { phase: 'runtime', revision: cacheRevision, candidate: undefined, info } }),
          }),
          signal,
        });
      }

      let lastError: unknown;
      let firstNonMissingError: unknown;
      for (const candidate of candidates) {
        signal?.throwIfAborted();
        reportProgress({ progress: { phase: 'candidate-acceptance', revision: cacheRevision, candidate, info: undefined } });
        try {
          return await awaitWithAbort({
            operation: client.verifyDownloadedModelCandidate({
              modelId,
              loadRevision,
              candidate,
              progressCallback: ({ info }) => reportProgress({ progress: { phase: 'runtime', revision: cacheRevision, candidate, info } }),
            }),
            signal,
          });
        } catch (error) {
          if (signal?.aborted === true) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
          // A broken ownership/cleanup contract is not another dtype's runtime
          // incompatibility, including after Comlink reconstructs the Error.
          const classification = classifyProductionAcceptanceError({ error });
          lastError = error;
          switch (classification) {
          case 'terminal': throw error;
          case 'incomplete': break;
          case 'runtime-rejected':
            firstNonMissingError ??= error;
            break;
          default: {
            const _ex: never = classification;
            throw new Error(`Unhandled Production acceptance failure: ${_ex}`);
          }
          }
        }
      }
      throw firstNonMissingError ?? lastError ?? new Error('No eligible cached Production candidate was available for revision acceptance');
    })();
    return {
      modelId,
      repositoryResolvedRevision: repositoryResolvedRevision ?? null,
      cacheRevision,
      loaderRevisionOption: loadRevision ?? null,
      status: 'accepted',
      selectedDevice: productionDevice({ device: result.device }),
      selectedDtype: result.dtype,
      observationMethod: 'production-cache-only-revision-runtime-preparation',
      error: undefined,
      receipt: readProductionLoadResultReceipt({ value: result, modelId, revision: loadRevision }),
    };
  } catch (error) {
    if (signal?.aborted === true) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
    return {
      modelId,
      repositoryResolvedRevision: repositoryResolvedRevision ?? null,
      cacheRevision,
      loaderRevisionOption: loadRevision ?? null,
      status: productionAcceptanceFailureStatus({ error }),
      selectedDevice: undefined,
      selectedDtype: undefined,
      observationMethod: 'production-cache-only-revision-runtime-preparation',
      error: serializeProductionAcceptanceError({ error }),
    };
  } finally {
    await client.dispose();
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
