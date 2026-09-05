import { createDownloadVerificationCandidateAcceptanceWorkerClient } from '@/features/transformers-js/download-verification/candidate-acceptance-worker/client-hosted';
import { awaitWithAbort } from '@/features/transformers-js/download-verification/logic/await-with-abort';
import { sanitizeDiagnosticText } from '@/features/transformers-js/download-verification/logic/run-browser-download-verification';
import type { DownloadVerificationRevisionAcceptanceObservation } from '@/features/transformers-js/download-verification/types';

function revisionAcceptanceFailureStatus({ error }: { error: unknown }): 'rejected' | 'failed' {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('MUST NOT fetch model artifacts')) return 'failed';
  if (message.includes('requires a browser Worker')) return 'failed';
  return 'rejected';
}

function productionDevice({ device }: { device: string }): 'webgpu' | 'wasm' {
  switch (device) {
  case 'webgpu':
  case 'wasm':
    return device;
  default:
    throw new Error(`Unexpected Production device: ${device}`);
  }
}

function serializedError({ error }: { error: unknown }): { name: string; message: string } {
  if (error instanceof Error) {
    return {
      name: error.message.includes('MUST NOT fetch model artifacts')
        ? 'MissingDownloadedModelArtifact'
        : error.name,
      message: sanitizeDiagnosticText({ value: error.message }),
    };
  }
  return {
    name: 'Error',
    message: sanitizeDiagnosticText({ value: String(error) }),
  };
}

export async function acceptDownloadedProductionRevision({
  modelId,
  repositoryResolvedRevision,
  cacheRevision,
  loadRevision,
  signal,
}: {
  modelId: string;
  repositoryResolvedRevision: string | undefined;
  cacheRevision: string;
  loadRevision?: string;
  signal?: AbortSignal;
}): Promise<DownloadVerificationRevisionAcceptanceObservation> {
  if (loadRevision === undefined && cacheRevision !== 'main') {
    throw new Error(`A revision-less Production load can only target the legacy main cache, not ${cacheRevision}`);
  }
  if (loadRevision !== undefined && loadRevision !== cacheRevision) {
    throw new Error(`The Production loader revision ${loadRevision} does not match the cache revision ${cacheRevision}`);
  }
  signal?.throwIfAborted();
  const client = createDownloadVerificationCandidateAcceptanceWorkerClient();
  try {
    const operation = client.verifyDownloadedModelRevision({
      modelId,
      loadRevision,
      progressCallback: () => undefined,
    });
    const result = await awaitWithAbort({ operation, signal });
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
    };
  } catch (error) {
    if (signal?.aborted === true) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
    return {
      modelId,
      repositoryResolvedRevision: repositoryResolvedRevision ?? null,
      cacheRevision,
      loaderRevisionOption: loadRevision ?? null,
      status: revisionAcceptanceFailureStatus({ error }),
      selectedDevice: undefined,
      selectedDtype: undefined,
      observationMethod: 'production-cache-only-revision-runtime-preparation',
      error: serializedError({ error }),
    };
  } finally {
    await client.dispose();
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
