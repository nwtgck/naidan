import { describe, expect, it, vi } from 'vitest';
import { runCandidateDownloadOrchestration } from '@/features/transformers-js/download-verification/logic/run-candidate-download-orchestration';
import type {
  DownloadVerificationCandidateAcceptanceObservation,
  DownloadVerificationCandidatePreparationObservation,
} from '@/features/transformers-js/download-verification/types';
import type { TransformersJsPrefetchResult, TransformersJsProductionInvestigationCandidate } from '@/features/transformers-js/types';

const REVISION = '0123456789abcdef0123456789abcdef01234567';

function emptyPrefetch(): TransformersJsPrefetchResult {
  return {
    requestedCount: 0,
    cachedCount: 0,
    downloadedCount: 0,
    failedCount: 0,
    complete: true,
    files: [],
  };
}

function accepted({ candidate }: { candidate: TransformersJsProductionInvestigationCandidate }): DownloadVerificationCandidateAcceptanceObservation {
  return {
    modelId: 'org/model',
    resolvedRevision: REVISION,
    loaderRevisionOption: null,
    candidate,
    status: 'accepted',
    observationMethod: 'production-cache-only-runtime-preparation',
    error: undefined,
  };
}

function rejected({ candidate, message }: { candidate: TransformersJsProductionInvestigationCandidate; message: string }): DownloadVerificationCandidateAcceptanceObservation {
  return {
    modelId: 'org/model',
    resolvedRevision: REVISION,
    loaderRevisionOption: null,
    candidate,
    status: 'rejected',
    observationMethod: 'production-cache-only-runtime-preparation',
    error: { name: 'Error', message },
  };
}

const ready = (): DownloadVerificationCandidatePreparationObservation => ({ status: 'ready', prefetch: emptyPrefetch() });

function failedAcceptance({ candidate, message }: { candidate: TransformersJsProductionInvestigationCandidate; message: string }): DownloadVerificationCandidateAcceptanceObservation {
  return {
    modelId: 'org/model',
    resolvedRevision: REVISION,
    loaderRevisionOption: null,
    candidate,
    status: 'failed',
    observationMethod: 'production-cache-only-runtime-preparation',
    error: { name: 'MissingDownloadedArtifact', message },
  };
}


describe('runCandidateDownloadOrchestration', () => {
  it('downloads q4f16, falls through after runtime rejection, then accepts q4', async () => {
    const events: string[] = [];
    const prepareCandidate = vi.fn(async ({ candidate }: { candidate: TransformersJsProductionInvestigationCandidate }) => {
      events.push(`prepare:${candidate.device}/${candidate.dtype}`);
      return ready();
    });
    const acceptCandidate = vi.fn(async ({ candidate }: { candidate: TransformersJsProductionInvestigationCandidate }) => {
      events.push(`accept:${candidate.device}/${candidate.dtype}`);
      return candidate.dtype === 'q4f16'
        ? rejected({ candidate, message: 'WebGPU q4f16 runtime rejected' })
        : accepted({ candidate });
    });

    const result = await runCandidateDownloadOrchestration({ prepareCandidate, acceptCandidate });

    expect(result.status).toBe('accepted');
    expect(result.selectedCandidate).toEqual({ device: 'webgpu', dtype: 'q4' });
    expect(events).toEqual([
      'prepare:webgpu/q4f16',
      'accept:webgpu/q4f16',
      'prepare:webgpu/q4',
      'accept:webgpu/q4',
    ]);
    expect(result.attempts).toHaveLength(2);
  });

  it('skips an unavailable repository candidate without running runtime acceptance', async () => {
    const acceptCandidate = vi.fn(async ({ candidate }: { candidate: TransformersJsProductionInvestigationCandidate }) => accepted({ candidate }));
    const result = await runCandidateDownloadOrchestration({
      prepareCandidate: vi.fn(async ({ candidate }): Promise<DownloadVerificationCandidatePreparationObservation> => candidate.dtype === 'q4f16'
        ? { status: 'unavailable', reason: 'q4f16 files do not exist', prefetch: emptyPrefetch() }
        : ready()),
      acceptCandidate,
    });

    expect(result.status).toBe('accepted');
    expect(result.selectedCandidate).toEqual({ device: 'webgpu', dtype: 'q4' });
    expect(acceptCandidate).toHaveBeenCalledTimes(1);
  });

  it('stops on transport/preparation failure instead of misclassifying it as candidate unavailability', async () => {
    const acceptCandidate = vi.fn();
    const result = await runCandidateDownloadOrchestration({
      prepareCandidate: vi.fn(async (): Promise<DownloadVerificationCandidatePreparationObservation> => ({
        status: 'failed',
        error: { name: 'TypeError', message: 'network connection failed' },
        prefetch: undefined,
      })),
      acceptCandidate,
    });

    expect(result).toMatchObject({
      status: 'failed',
      selectedCandidate: undefined,
      error: { name: 'TypeError', message: 'network connection failed' },
    });
    expect(acceptCandidate).not.toHaveBeenCalled();
  });


  it('stops when cache-only acceptance exposes a missing downloaded artifact', async () => {
    const prepareCandidate = vi.fn(async () => ready());
    const acceptCandidate = vi.fn(async ({ candidate }) => failedAcceptance({
      candidate,
      message: 'required model artifact is missing from OPFS',
    }));

    const result = await runCandidateDownloadOrchestration({ prepareCandidate, acceptCandidate });

    expect(result).toMatchObject({
      status: 'failed',
      selectedCandidate: undefined,
      error: { name: 'MissingDownloadedArtifact' },
    });
    expect(prepareCandidate).toHaveBeenCalledTimes(1);
    expect(acceptCandidate).toHaveBeenCalledTimes(1);
  });

  it('reports exhausted when every prepared runtime candidate is rejected', async () => {
    const result = await runCandidateDownloadOrchestration({
      prepareCandidate: vi.fn(async () => ready()),
      acceptCandidate: vi.fn(async ({ candidate }) => rejected({ candidate, message: 'runtime rejected' })),
    });

    expect(result.status).toBe('exhausted');
    expect(result.selectedCandidate).toBeUndefined();
    expect(result.attempts.map(attempt => attempt.candidate)).toEqual([
      { device: 'webgpu', dtype: 'q4f16' },
      { device: 'webgpu', dtype: 'q4' },
      { device: 'wasm', dtype: 'q4' },
    ]);
  });
});
