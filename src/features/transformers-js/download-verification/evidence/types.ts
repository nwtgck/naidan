import type { DownloadVerificationCachedRevisionInventory } from '@/features/transformers-js/download-verification/logic/inspect-cached-revisions';
import type { DownloadVerificationCachedRevisionAcceptanceResult } from '@/features/transformers-js/download-verification/logic/run-cached-revision-acceptance-orchestration';
import type { DownloadVerificationProductionDownloadPreparationRun } from '@/features/transformers-js/download-verification/logic/run-production-download-preparation';
import type { TransformersJsProductionInvestigationCandidate } from '@/features/transformers-js/types';
import type {
  DownloadVerificationModelArtifactRequestObservation,
  DownloadVerificationRun,
} from '@/features/transformers-js/download-verification/types';

export type DownloadVerificationEvidenceStability =
  | 'stable'
  | 'runtime-version-specific'
  | 'environment-specific'
  | 'volatile';

export interface DownloadVerificationRuntimeCompletionEvidence {
  schemaVersion: 1;
  status: 'accepted' | 'failed' | 'exhausted';
  source: 'reused-production-cache' | 'production-download-preparation' | 'cache-reuse-failed';
  repositoryResolvedRevision: string;
  cacheRevision: string | null;
  loaderRevisionOption: string | null;
  selectedCandidate: TransformersJsProductionInvestigationCandidate | undefined;
  cacheReuse: DownloadVerificationCachedRevisionAcceptanceResult | undefined;
  preparation: DownloadVerificationProductionDownloadPreparationRun | undefined;
  cacheAfter: DownloadVerificationCachedRevisionInventory | undefined;
  cacheInspectionError: string | undefined;
  error: { name: string; message: string } | undefined;
}

export interface DownloadVerificationEvidenceInput {
  schemaVersion: 1;
  runId: string;
  mode: 'probe-only' | 'runtime-complete';
  run: DownloadVerificationRun;
  modelArtifactObservations: DownloadVerificationModelArtifactRequestObservation[];
  modelArtifactObservationError: string | undefined;
  cacheBefore: DownloadVerificationCachedRevisionInventory | undefined;
  cacheInspectionError: string | undefined;
  runtimeCompletion?: DownloadVerificationRuntimeCompletionEvidence;
}

export type DownloadVerificationProbeEvidenceInput = Omit<
  DownloadVerificationEvidenceInput,
  'mode' | 'runtimeCompletion'
> & {
  mode: 'probe-only';
  runtimeCompletion?: undefined;
};

export interface DownloadVerificationEvidenceArchive {
  blob: Blob;
  fileName: string;
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
