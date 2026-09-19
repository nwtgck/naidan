import type { DownloadVerificationEvidenceInput } from '@/features/transformers-js/download-verification/evidence/types';

/** Bounded observation completion, not Production cache or model acceptance. */
export function downloadProbeOutcome({ evidence }: { evidence: DownloadVerificationEvidenceInput }) {
  const errors: Array<{ name: string; message: string }> = [];
  if (evidence.modelArtifactObservationError !== undefined) errors.push({ name: 'ArtifactObservationError', message: evidence.modelArtifactObservationError });
  if (evidence.cacheInspectionError !== undefined) errors.push({ name: 'CacheInspectionError', message: evidence.cacheInspectionError });
  for (const observation of evidence.modelArtifactObservations) {
    switch (observation.status) {
    case 'observed': break;
    case 'failed':
      errors.push(observation.error ?? { name: 'ArtifactObservationError', message: `Artifact request observation failed for ${observation.candidate.device}/${observation.candidate.dtype}` });
      break;
    default: { const exhaustive: never = observation.status; throw new Error(`Unhandled artifact observation: ${exhaustive}`); }
    }
  }
  for (const observation of evidence.run.transportObservations) {
    if (observation.error !== undefined) errors.push(observation.error);
  }
  const observed = evidence.modelArtifactObservations.filter(item => item.status === 'observed').length;
  const status = errors.length > 0 ? 'failed' as const : observed === 0 ? 'blocked' as const : 'passed' as const;
  const detail = `${observed} actual candidate artifact-request observations and ${evidence.run.transportObservations.length} bounded transport probes collected; ${errors.length} observation errors; ${observed === 0 ? 'no successful artifact-request observation; ' : ''}bounded probe collection ended; Production runtime cache acceptance is a separate observation`;
  return { status, detail, errors };
}

export const TEST_ONLY = {
};
