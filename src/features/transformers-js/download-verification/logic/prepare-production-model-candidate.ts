import { observeProductionModelArtifactCandidateRequests } from '@/features/transformers-js/download-verification/logic/observe-production-model-artifact-requests';
import { awaitWithAbort } from '@/features/transformers-js/download-verification/logic/await-with-abort';
import { sanitizeDiagnosticText } from '@/features/transformers-js/download-verification/logic/run-browser-download-verification';
import type { DownloadVerificationCandidatePreparationObservation } from '@/features/transformers-js/download-verification/types';
import { normalizeTransformersJsProductionModelId } from '@/features/transformers-js/production-routing';
import { createTransformersJsWorkerClient } from '@/features/transformers-js/worker/client';
import type {
  TransformersJsPrefetchFileResult,
  TransformersJsProductionInvestigationCandidate,
  TransformersJsProgressCallback,
} from '@/features/transformers-js/types';


function requestRevision({ url }: { url: string }): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  const parts = parsed.pathname.split('/').filter(Boolean);
  const resolveIndex = parts.indexOf('resolve');
  if (resolveIndex < 0 || resolveIndex + 1 >= parts.length) return undefined;
  try {
    return decodeURIComponent(parts[resolveIndex + 1]!);
  } catch {
    return parts[resolveIndex + 1];
  }
}

function serializedError({ error }: { error: unknown }): { name: string; message: string } {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: sanitizeDiagnosticText({ value: error.message }),
    };
  }
  return {
    name: 'Error',
    message: sanitizeDiagnosticText({ value: String(error) }),
  };
}

function isRepositoryUnavailableFailure({ file }: {
  file: Extract<TransformersJsPrefetchFileResult, { status: 'failed' }>,
}): boolean {
  return file.failureStage === 'response-status' && (file.httpStatus === 404 || file.httpStatus === 410);
}

function failedPrefetchFiles({ files }: { files: TransformersJsPrefetchFileResult[] }): Extract<TransformersJsPrefetchFileResult, { status: 'failed' }>[] {
  return files.filter((file): file is Extract<TransformersJsPrefetchFileResult, { status: 'failed' }> => file.status === 'failed');
}

export async function prepareProductionModelCandidate({ modelId, revision, candidate, progressCallback = () => undefined, signal }: {
  modelId: string;
  revision: string;
  candidate: TransformersJsProductionInvestigationCandidate;
  progressCallback?: TransformersJsProgressCallback;
  signal?: AbortSignal;
}): Promise<DownloadVerificationCandidatePreparationObservation> {
  signal?.throwIfAborted();
  const requestObservation = await observeProductionModelArtifactCandidateRequests({
    modelId,
    revision,
    candidate,
    signal,
  });
  switch (requestObservation.status) {
  case 'failed':
    return {
      status: 'failed',
      error: requestObservation.error ?? {
        name: 'ModelArtifactRequestObservationFailed',
        message: 'Transformers.js model artifact request observation failed without an error detail',
      },
      prefetch: undefined,
    };
  case 'observed':
    break;
  default: {
    const _ex: never = requestObservation.status;
    throw new Error(`Unhandled model artifact request observation status: ${_ex}`);
  }
  }

  const normalizedModelId = normalizeTransformersJsProductionModelId({ modelId });
  const identityMatches = requestObservation.modelId === normalizedModelId
    && requestObservation.revision === revision
    && requestObservation.candidate.device === candidate.device
    && requestObservation.candidate.dtype === candidate.dtype;
  const revisionsMatch = requestObservation.requests.every(request => requestRevision({ url: request.url }) === revision);
  if (!identityMatches || !revisionsMatch) {
    return {
      status: 'failed',
      error: {
        name: 'ModelArtifactRequestIdentityMismatch',
        message: 'Transformers.js model artifact request observation did not match the requested model, revision, or Production candidate',
      },
      prefetch: undefined,
    };
  }

  if (requestObservation.requests.length === 0) {
    return {
      status: 'failed',
      error: {
        name: 'EmptyModelArtifactRequestSet',
        message: 'Transformers.js did not expose any model artifact request for this Production candidate',
      },
      prefetch: undefined,
    };
  }

  const client = createTransformersJsWorkerClient();
  try {
    const operation = client.prefetchUrls({
      urls: requestObservation.requests.map(request => request.url),
      progressCallback,
    });
    const prefetchResult = await awaitWithAbort({ operation, signal });

    const failures = failedPrefetchFiles({ files: prefetchResult.files });
    const nonAvailabilityFailure = failures.find(file => !isRepositoryUnavailableFailure({ file }));
    if (nonAvailabilityFailure !== undefined) {
      return {
        status: 'failed',
        error: {
          name: nonAvailabilityFailure.error.name,
          message: sanitizeDiagnosticText({ value: nonAvailabilityFailure.error.message }),
        },
        prefetch: prefetchResult,
      };
    }
    const unavailableFailures = failures.filter(file => isRepositoryUnavailableFailure({ file }));
    if (unavailableFailures.length > 0) {
      return {
        status: 'unavailable',
        reason: unavailableFailures
          .map(file => file.path ?? file.url)
          .sort()
          .join(', '),
        prefetch: prefetchResult,
      };
    }
    if (!prefetchResult.complete || prefetchResult.failedCount !== 0) {
      return {
        status: 'failed',
        error: {
          name: 'IncompleteModelArtifactPrefetch',
          message: `Model artifact prefetch completed without an explicit file error but remained incomplete (${prefetchResult.failedCount} failures)`,
        },
        prefetch: prefetchResult,
      };
    }
    return { status: 'ready', prefetch: prefetchResult };
  } catch (error) {
    if (signal?.aborted === true) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
    return { status: 'failed', error: serializedError({ error }), prefetch: undefined };
  } finally {
    await client.dispose();
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
