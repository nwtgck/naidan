export type DownloadVerificationProbeMethod = 'HEAD' | 'GET-range';

export interface DownloadVerificationRepositoryFile {
  path: string;
  size: number | undefined;
  blobId: string | undefined;
  lfsOid: string | undefined;
  lfsSha256: string | undefined;
  lfsSize: number | undefined;
}

export interface DownloadVerificationTransportObservation {
  path: string;
  method: DownloadVerificationProbeMethod;
  status: number | undefined;
  redirected: boolean | undefined;
  finalUrl: string | undefined;
  finalOrigin: string | undefined;
  contentLength: number | undefined;
  contentRange: string | undefined;
  acceptRanges: string | undefined;
  contentType: string | undefined;
  etag: string | undefined;
  rangeHonored: boolean | undefined;
  bytesConsumed: number;
  abortedByByteBudget: boolean;
  error: {
    name: string;
    message: string;
  } | undefined;
}

export interface DownloadVerificationResolvedRepository {
  modelId: string;
  normalizedModelId: string;
  requestedRevision: 'main';
  resolvedRevision: string;
  repositoryFiles: DownloadVerificationRepositoryFile[];
}

export interface DownloadVerificationRun {
  modelId: string;
  normalizedModelId: string;
  requestedRevision: 'main';
  resolvedRevision: string;
  repositoryFileCount: number;
  repositoryFiles: DownloadVerificationRepositoryFile[];
  transportObservations: DownloadVerificationTransportObservation[];
  skippedModelArtifactCount: number;
  bytesConsumed: number;
  maximumBytes: number;
  startedAt: string;
  finishedAt: string;
}

export interface DownloadVerificationModelArtifactRequest {
  path: string;
  url: string;
}

export interface DownloadVerificationModelArtifactRequestObservation {
  modelId: string;
  revision: string;
  autoClass: import('@/features/transformers-js/types').TransformersJsProductionInvestigationAutoClass;
  candidate: import('@/features/transformers-js/types').TransformersJsProductionInvestigationCandidate;
  status: 'observed' | 'failed';
  observationMethod: 'held-model-artifact-fetch-quiescence';
  quiescenceMs: number;
  timeoutMs: number;
  paths: string[];
  requests: DownloadVerificationModelArtifactRequest[];
  error: {
    name: string;
    message: string;
  } | undefined;
}


export interface DownloadVerificationModelArtifactRequestPair {
  path: string;
  fetchUrl: string;
  cacheUrl: string;
}

export type DownloadVerificationModelArtifactRequestPairingResult =
  | {
      status: 'paired';
      modelId: string;
      autoClass: import('@/features/transformers-js/types').TransformersJsProductionInvestigationAutoClass;
      candidate: import('@/features/transformers-js/types').TransformersJsProductionInvestigationCandidate;
      fetchRevision: string;
      cacheRevision: string;
      requests: DownloadVerificationModelArtifactRequestPair[];
    }
  | {
      status: 'failed';
      reason: string;
    };


export type DownloadVerificationCandidatePreparationObservation =
  | {
      status: 'ready';
      prefetch: import('@/features/transformers-js/types').TransformersJsPrefetchResult;
    }
  | {
      status: 'unavailable';
      reason: string;
      prefetch: import('@/features/transformers-js/types').TransformersJsPrefetchResult;
    }
  | {
      status: 'failed';
      error: { name: string; message: string };
      prefetch: import('@/features/transformers-js/types').TransformersJsPrefetchResult | undefined;
    };

export type DownloadVerificationRuntimeArtifactPreparationObservation =
  | {
      modelId: string;
      revision: string;
      status: 'prepared';
      processor: import('@/features/transformers-js/types').TransformersJsProductionInvestigationProcessor;
      modelType: string | undefined;
      observationMethod: 'transformers-runtime-artifact-preparation';
      error: undefined;
    }
  | {
      modelId: string;
      revision: string;
      status: 'failed';
      processor: undefined;
      modelType: undefined;
      observationMethod: 'transformers-runtime-artifact-preparation';
      error: { name: string; message: string };
    };

export interface DownloadVerificationCandidateOrchestrationAttempt {
  candidate: import('@/features/transformers-js/types').TransformersJsProductionInvestigationCandidate;
  preparation: DownloadVerificationCandidatePreparationObservation;
  acceptance: DownloadVerificationCandidateAcceptanceObservation | undefined;
}

export interface DownloadVerificationCandidateOrchestrationResult {
  status: 'accepted' | 'exhausted' | 'failed';
  selectedCandidate: import('@/features/transformers-js/types').TransformersJsProductionInvestigationCandidate | undefined;
  attempts: DownloadVerificationCandidateOrchestrationAttempt[];
  error: { name: string; message: string } | undefined;
}

export interface DownloadVerificationCandidateAcceptanceObservation {
  modelId: string;
  resolvedRevision: string;
  loaderRevisionOption: string | null;
  candidate: import('@/features/transformers-js/types').TransformersJsProductionInvestigationCandidate;
  status: 'accepted' | 'rejected' | 'failed';
  observationMethod: 'production-cache-only-runtime-preparation';
  error: {
    name: string;
    message: string;
  } | undefined;
}

export interface DownloadVerificationRevisionAcceptanceObservation {
  modelId: string;
  repositoryResolvedRevision: string | null;
  cacheRevision: string;
  loaderRevisionOption: string | null;
  status: 'accepted' | 'rejected' | 'failed';
  selectedDevice: import('@/features/transformers-js/types').TransformersJsProductionInvestigationDevice | undefined;
  selectedDtype: import('@/features/transformers-js/types').TransformersJsProductionInvestigationDtype | undefined;
  observationMethod: 'production-cache-only-revision-runtime-preparation';
  error: {
    name: string;
    message: string;
  } | undefined;
}

export interface DownloadVerificationModelArtifactPathParity {
  status: 'match' | 'mismatch' | 'observation-failed';
  expectedPaths: string[];
  observedPaths: string[];
  missingPaths: string[];
  unexpectedPaths: string[];
}

export interface DownloadVerificationModelArtifactRequestWorker {
  observeModelArtifactRequests({ modelId, revision, candidate }: {
    modelId: string;
    revision: string;
    candidate: import('@/features/transformers-js/types').TransformersJsProductionInvestigationCandidate;
  }): Promise<DownloadVerificationModelArtifactRequestObservation>;
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
