import { observeProductionModelArtifactCandidateRequests } from '@/features/transformers-js/download-verification/logic/observe-production-model-artifact-requests';
import { awaitWithAbort } from '@/features/transformers-js/download-verification/logic/await-with-abort';
import { sanitizeDiagnosticText } from '@/features/transformers-js/download-verification/logic/run-browser-download-verification';
import type { DownloadVerificationCandidatePreparationObservation } from '@/features/transformers-js/download-verification/types';
import { normalizeTransformersJsProductionModelId } from '@/features/transformers-js/production-routing';
import { createTransformersJsDownloadWorkerClient } from '@/features/transformers-js/download-verification/download-worker/client-hosted';
import { observeDownloadSafely } from '@/features/transformers-js/download-progress';
import { downloadResourcePath } from '@/features/transformers-js/download-progress';
import { createDownloadMeasurementClock, disposeWithDownloadTiming, publishDownloadTiming, type DownloadTimingCallback, type DownloadPrefetchTiming } from '@/features/transformers-js/download-timing';
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

function exactRevisionModelArtifactUrl({ modelId, revision, path }: {
  modelId: string;
  revision: string;
  path: string;
}): string {
  const encodedModelId = modelId.split('/').map(part => encodeURIComponent(part)).join('/');
  const encodedPath = path.split('/').map(part => encodeURIComponent(part)).join('/');
  return `https://huggingface.co/${encodedModelId}/resolve/${encodeURIComponent(revision)}/${encodedPath}`;
}

export async function prepareProductionModelCandidate({
  modelId,
  revision,
  candidate,
  progressCallback = () => undefined,
  signal,
  requiredModelPaths,
  onPlan,
  onTiming,
}: {
  modelId: string;
  revision: string;
  candidate: TransformersJsProductionInvestigationCandidate;
  progressCallback?: TransformersJsProgressCallback;
  signal?: AbortSignal;
  requiredModelPaths?: readonly string[];
  onPlan?: ({ paths }: { paths: readonly string[] }) => void;
  onTiming?: DownloadTimingCallback;
}): Promise<DownloadVerificationCandidatePreparationObservation> {
  signal?.throwIfAborted();
  if (!requiredModelPaths?.length) {
    return { status: 'failed', error: { name: 'MissingProductionResourcePlan', message: 'Candidate transfer requires an explicit completed Production resource plan' }, prefetch: undefined };
  }
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

  const plannedPaths = new Set(requiredModelPaths);
  if (requestObservation.requests.some(request => !plannedPaths.has(request.path))) {
    return {
      status: 'failed',
      error: { name: 'ProductionResourcePlanMismatch', message: 'The real loader observed a model artifact outside the completed Production resource plan' },
      prefetch: undefined,
    };
  }

  const client = createTransformersJsDownloadWorkerClient();
  const clock = createDownloadMeasurementClock();
  let rpcStarted: number | undefined;
  let rpcSettled: number | undefined;
  let observedResult: Awaited<ReturnType<typeof client.prefetchUrls>> | undefined;
  let hostSettlement: DownloadPrefetchTiming['hostSettlement'] = 'fulfilled';
  let cleanupOutcome: DownloadPrefetchTiming['cleanupOutcome'] = 'unknown';
  try {
    // The shared selector supplies a completed plan. Observation remains a
    // compatibility check, never a quiet-time completeness certificate or an
    // authority to add Registry-only artifacts to the transfer set.
    const urls = [...plannedPaths].map(path => exactRevisionModelArtifactUrl({
      modelId: normalizedModelId, revision, path,
    }));
    // Publish the existing transfer set before starting any GET. Display code
    // cannot add paths or turn an observation failure into a transfer failure.
    observeDownloadSafely({ observe: onPlan === undefined ? undefined : () => onPlan({ paths: [...plannedPaths] }) });
    rpcStarted = clock.read();
    const operation = client.prefetchUrls({
      urls,
      progressCallback,
    });
    const prefetchResult = await awaitWithAbort({ operation, signal });
    rpcSettled ??= clock.read();
    observedResult = prefetchResult;

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
    rpcSettled ??= clock.read();
    if (signal?.aborted === true) {
      hostSettlement = 'rejected';
      throw signal.reason ?? new DOMException('Aborted', 'AbortError');
    }
    return { status: 'failed', error: serializedError({ error }), prefetch: undefined };
  } finally {
    try {
      await disposeWithDownloadTiming({ dispose: () => client.dispose(), onOutcome: ({ outcome }) => {
        cleanupOutcome = outcome;
        switch (outcome) {
        case 'completed': break;
        case 'failed': hostSettlement = 'rejected'; break;
        default: {
          const exhaustive: never = outcome;
          throw new Error(`Unhandled disposal outcome: ${exhaustive}`);
        }
        }
      } });
    } finally {
      observeDownloadSafely({ observe: () => {
        const hostRoundtripMs = clock.elapsed({ start: rpcStarted, end: rpcSettled });
        const hostFinalizationMs = clock.elapsed({ start: rpcSettled, end: clock.read() });
        const files: DownloadPrefetchTiming['files'] = [];
        let droppedFiles = 0;
        for (const file of observedResult?.files ?? []) {
          const path = downloadResourcePath({ url: file.url });
          if (path === undefined || files.length >= 127) {
            droppedFiles++; continue;
          }
          const bytes = (() => {
            switch (file.status) {
            case 'failed': return file.transferObservation?.receivedBytes;
            case 'cached':
            case 'downloaded': return file.byteLength;
            default: {
              const exhaustive: never = file;
              throw new Error(`Unhandled prefetch result: ${String(exhaustive)}`);
            }
            }
          })();
          files.push({ path, outcome: file.status, bytes, timing: file.timing });
        }
        publishDownloadTiming({ callback: onTiming, observation: {
          kind: 'prefetch', version: 1, revision, candidate, clockId: clock.clockId,
          timingStatus: hostRoundtripMs === undefined || hostFinalizationMs === undefined ? 'unavailable' : 'measured',
          hostRoundtripMs, hostFinalizationMs, cleanupOutcome, hostSettlement, source: observedResult?.timing, files, droppedFiles,
        } });
      } });
    }
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
  exactRevisionModelArtifactUrl,
};
