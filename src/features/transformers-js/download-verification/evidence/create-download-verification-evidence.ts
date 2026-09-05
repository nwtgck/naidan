import JSZip from 'jszip';
import { HOSTED_TRANSFORMERS_RUNTIME_ASSET_MANIFEST } from '@/features/transformers-js/runtime/runtime-asset-manifest';
import { TRANSFORMERS_JS_PRODUCTION_LOAD_CANDIDATES } from '@/features/transformers-js/production-load-candidates';
import type {
  DownloadVerificationEvidenceArchive,
  DownloadVerificationEvidenceInput,
  DownloadVerificationEvidenceStability,
} from '@/features/transformers-js/download-verification/evidence/types';
import { verifyGeneratedEvidenceArchive } from '@/features/transformers-js/model-support-investigation/logic/verify-evidence-archive';

interface DownloadVerificationCandidateEvidence {
  candidate: import('@/features/transformers-js/types').TransformersJsProductionInvestigationCandidate;
  status: 'repository-complete' | 'repository-incomplete' | 'observation-failed' | 'not-observed';
  requestedPaths: string[];
  missingRepositoryPaths: string[];
  observationError: { name: string; message: string } | undefined;
  provenance: {
    source: 'actual-transformers-js-artifact-request-observation';
    evidencePath: 'download-lane/artifact-requests.json';
    resolvedRevision: string;
    stability: DownloadVerificationEvidenceStability;
  };
}

interface DownloadVerificationTestReadinessEntry {
  domain: 'repository' | 'artifact-requests' | 'candidate-resolution' | 'transport' | 'cache' | 'runtime-acceptance' | 'load-inference';
  status: 'implementation-ready' | 'partial' | 'insufficient' | 'not-observed';
  summary: string;
  evidencePaths: string[];
  stability: DownloadVerificationEvidenceStability;
}

async function sha256Hex({ bytes }: { bytes: Uint8Array }): Promise<string> {
  const input = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(input).set(bytes);
  const digest = await crypto.subtle.digest('SHA-256', input);
  return [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('');
}

function safeFilePart({ value }: { value: string }): string {
  const sanitized = value.replace(/[^a-zA-Z0-9._-]+/gu, '-').replace(/^-+|-+$/gu, '');
  return sanitized || 'model';
}

function candidateEvidence({ evidence }: { evidence: DownloadVerificationEvidenceInput }): DownloadVerificationCandidateEvidence[] {
  const repositoryPaths = new Set(evidence.run.repositoryFiles.map(file => file.path));
  return TRANSFORMERS_JS_PRODUCTION_LOAD_CANDIDATES.map(candidate => {
    const observation = evidence.modelArtifactObservations.find(item => (
      item.candidate.device === candidate.device && item.candidate.dtype === candidate.dtype
    ));
    if (observation === undefined) {
      return {
        candidate,
        status: 'not-observed' as const,
        requestedPaths: [],
        missingRepositoryPaths: [],
        observationError: undefined,
        provenance: {
          source: 'actual-transformers-js-artifact-request-observation' as const,
          evidencePath: 'download-lane/artifact-requests.json' as const,
          resolvedRevision: evidence.run.resolvedRevision,
          stability: 'runtime-version-specific' as const,
        },
      };
    }
    switch (observation.status) {
    case 'failed':
      return {
        candidate,
        status: 'observation-failed' as const,
        requestedPaths: observation.paths,
        missingRepositoryPaths: [],
        observationError: observation.error,
        provenance: {
          source: 'actual-transformers-js-artifact-request-observation' as const,
          evidencePath: 'download-lane/artifact-requests.json' as const,
          resolvedRevision: evidence.run.resolvedRevision,
          stability: 'runtime-version-specific' as const,
        },
      };
    case 'observed': {
      const missingRepositoryPaths = observation.paths.filter(path => !repositoryPaths.has(path));
      return {
        candidate,
        status: missingRepositoryPaths.length === 0 ? 'repository-complete' as const : 'repository-incomplete' as const,
        requestedPaths: observation.paths,
        missingRepositoryPaths,
        observationError: undefined,
        provenance: {
          source: 'actual-transformers-js-artifact-request-observation' as const,
          evidencePath: 'download-lane/artifact-requests.json' as const,
          resolvedRevision: evidence.run.resolvedRevision,
          stability: 'runtime-version-specific' as const,
        },
      };
    }
    default: {
      const exhaustiveObservation: never = observation.status;
      throw new Error(`Unhandled model artifact observation status: ${exhaustiveObservation}`);
    }
    }
  });
}

function runtimeRevisionIdentity({ evidence }: { evidence: DownloadVerificationEvidenceInput }): 'exact-resolved-revision' | 'legacy-main-unverified' | 'unverified' | undefined {
  const completion = evidence.runtimeCompletion;
  if (completion === undefined || completion.status !== 'accepted') return undefined;
  if (
    completion.cacheRevision === completion.repositoryResolvedRevision
    && completion.loaderRevisionOption === completion.repositoryResolvedRevision
  ) return 'exact-resolved-revision';
  if (completion.cacheRevision === 'main' && completion.loaderRevisionOption === null) return 'legacy-main-unverified';
  return 'unverified';
}

function testReadiness({ evidence, candidates }: {
  evidence: DownloadVerificationEvidenceInput;
  candidates: DownloadVerificationCandidateEvidence[];
}): { schemaVersion: 1; mode: 'probe-only' | 'runtime-complete'; overall: 'partial' | 'implementation-ready'; domains: DownloadVerificationTestReadinessEntry[] } {
  const observedCandidateCount = candidates.filter(candidate => (
    candidate.status === 'repository-complete' || candidate.status === 'repository-incomplete'
  )).length;
  const transportSuccessCount = evidence.run.transportObservations.filter(observation => observation.error === undefined).length;
  const transportCount = evidence.run.transportObservations.length;
  const firstRepositoryCompleteCandidate = candidates.find(candidate => candidate.status === 'repository-complete');
  const runtimeCompletion = evidence.runtimeCompletion;
  const runtimeAccepted = runtimeCompletion?.status === 'accepted';
  const acceptedRevisionIdentity = runtimeRevisionIdentity({ evidence });
  const runtimeAcceptedWithExactRevision = runtimeAccepted && acceptedRevisionIdentity === 'exact-resolved-revision';
  return {
    schemaVersion: 1,
    mode: evidence.mode,
    overall: runtimeAcceptedWithExactRevision ? 'implementation-ready' : 'partial',
    domains: [
      {
        domain: 'repository',
        status: evidence.run.resolvedRevision.length > 0 ? 'implementation-ready' : 'insufficient',
        summary: `Resolved public repository revision ${evidence.run.resolvedRevision} with ${evidence.run.repositoryFileCount} files.`,
        evidencePaths: ['download-lane/repository.json'],
        stability: 'stable',
      },
      {
        domain: 'artifact-requests',
        status: observedCandidateCount === candidates.length ? 'implementation-ready' : observedCandidateCount > 0 ? 'partial' : 'insufficient',
        summary: `${observedCandidateCount} of ${candidates.length} Production candidates have actual Transformers.js artifact-request observations.`,
        evidencePaths: ['download-lane/artifact-requests.json'],
        stability: 'runtime-version-specific',
      },
      {
        domain: 'candidate-resolution',
        status: firstRepositoryCompleteCandidate === undefined ? 'partial' : 'implementation-ready',
        summary: firstRepositoryCompleteCandidate === undefined
          ? 'No candidate was proven repository-complete by the bounded probe.'
          : `The first repository-complete Production candidate is ${firstRepositoryCompleteCandidate.candidate.device}/${firstRepositoryCompleteCandidate.candidate.dtype}; runtime acceptance is not implied.`,
        evidencePaths: ['download-lane/candidates.json'],
        stability: 'runtime-version-specific',
      },
      {
        domain: 'transport',
        status: transportCount === 0 ? 'not-observed' : transportSuccessCount === transportCount ? 'implementation-ready' : transportSuccessCount > 0 ? 'partial' : 'insufficient',
        summary: `${transportSuccessCount} of ${transportCount} bounded transport probes completed without an observed transport error.`,
        evidencePaths: ['download-lane/transport.json'],
        stability: 'environment-specific',
      },
      {
        domain: 'cache',
        status: runtimeCompletion?.cacheAfter !== undefined
          ? 'implementation-ready'
          : evidence.cacheBefore === undefined ? 'not-observed' : 'partial',
        summary: runtimeCompletion?.cacheAfter !== undefined
          ? `Observed ${runtimeCompletion.cacheAfter.revisions.length} cached revision directories after runtime completion.`
          : evidence.cacheBefore === undefined
            ? `Existing OPFS cache inventory was not available${evidence.cacheInspectionError === undefined ? '.' : `: ${evidence.cacheInspectionError}`}`
            : `Observed ${evidence.cacheBefore.revisions.length} cached revision directories without mutating them.`,
        evidencePaths: evidence.cacheBefore === undefined && runtimeCompletion?.cacheAfter === undefined ? [] : ['download-lane/cache-before.json', 'download-lane/cache-after.json'],
        stability: 'environment-specific',
      },
      {
        domain: 'runtime-acceptance',
        status: runtimeAccepted
          ? runtimeAcceptedWithExactRevision ? 'implementation-ready' : 'partial'
          : runtimeCompletion === undefined ? 'not-observed' : 'insufficient',
        summary: runtimeAccepted
          ? runtimeAcceptedWithExactRevision
            ? `Production cache-only acceptance succeeded using cache revision ${runtimeCompletion.cacheRevision ?? 'main'} and loader revision ${runtimeCompletion.loaderRevisionOption ?? 'main'} with exact frozen-revision identity.`
            : `Production cache-only acceptance succeeded using cache revision ${runtimeCompletion.cacheRevision ?? 'main'} and loader revision ${runtimeCompletion.loaderRevisionOption ?? 'main'}, but exact identity with frozen revision ${runtimeCompletion.repositoryResolvedRevision} remains unverified.`
          : runtimeCompletion === undefined
            ? 'Probe-only verification does not create an ORT session or claim Production runtime acceptance.'
            : `Runtime completion ended with status ${runtimeCompletion.status}${runtimeCompletion.error === undefined ? '.' : `: ${runtimeCompletion.error.name}: ${runtimeCompletion.error.message}`}`,
        evidencePaths: ['download-lane/cache-acceptance.json'],
        stability: 'environment-specific',
      },
      {
        domain: 'load-inference',
        status: 'not-observed',
        summary: runtimeAccepted
          ? 'Download-lane runtime acceptance is complete, but first inference and generation remain Model Support Investigation evidence domains.'
          : 'Model load, first inference, and generation are outside the probe-only portion of this lane and must come from Model Support Investigation runtime-complete evidence.',
        evidencePaths: [],
        stability: 'environment-specific',
      },
    ],
  };
}

function summaryMarkdown({ evidence, candidates }: {
  evidence: DownloadVerificationEvidenceInput;
  candidates: DownloadVerificationCandidateEvidence[];
}): string {
  const completeCandidate = candidates.find(candidate => candidate.status === 'repository-complete');
  const observationFailures = candidates.filter(candidate => candidate.status === 'observation-failed').length;
  const runtimeLine = evidence.runtimeCompletion === undefined
    ? '- Runtime completion: not run'
    : `- Runtime completion: ${evidence.runtimeCompletion.status} (${evidence.runtimeCompletion.source})`;
  return `# Download Verification Evidence\n\n- Mode: ${evidence.mode}\n- Model: ${evidence.run.normalizedModelId}\n- Requested revision: ${evidence.run.requestedRevision}\n- Resolved revision: ${evidence.run.resolvedRevision}\n- Repository files: ${evidence.run.repositoryFileCount}\n- Transport probes: ${evidence.run.transportObservations.length}\n- Transport bytes consumed: ${evidence.run.bytesConsumed} / ${evidence.run.maximumBytes}\n- Actual Transformers.js candidate observations: ${evidence.modelArtifactObservations.length}\n- Candidate observation failures: ${observationFailures}\n- First repository-complete candidate: ${completeCandidate === undefined ? 'not established' : `${completeCandidate.candidate.device}/${completeCandidate.candidate.dtype}`}\n${runtimeLine}\n\nThis archive is observational evidence. Repository completeness alone is not proof that ONNX Runtime can create a session or generate tokens. Runtime-complete mode records Production cache preparation/acceptance, but first inference and generation remain separate Model Support Investigation evidence. Model weight bodies are never embedded in this archive.\n`;
}

function prefetchNotRunReason({ evidence }: { evidence: DownloadVerificationEvidenceInput }): string {
  const completion = evidence.runtimeCompletion;
  if (completion === undefined) return 'Probe-only mode does not download full Production model artifacts into OPFS.';
  switch (completion.source) {
  case 'reused-production-cache':
    return 'A Production-accepted cached revision was reused; no model download preparation was needed.';
  case 'production-download-preparation':
  case 'cache-reuse-failed':
    return 'Production model download preparation did not produce a recorded preparation result.';
  default: {
    const _ex: never = completion.source;
    throw new Error(`Unhandled runtime completion source: ${_ex}`);
  }
  }
}


function runtimePrefetchFileEvidence({ evidence }: { evidence: DownloadVerificationEvidenceInput }): Array<{
  candidateAttemptIndex: number;
  candidate: import('@/features/transformers-js/types').TransformersJsProductionInvestigationCandidate;
  preparationStatus: 'ready' | 'unavailable' | 'failed';
  file: import('@/features/transformers-js/types').TransformersJsPrefetchFileResult;
}> {
  const preparation = evidence.runtimeCompletion?.preparation;
  if (preparation?.candidates === undefined) return [];
  return preparation.candidates.attempts.flatMap((attempt, candidateAttemptIndex) => (
    attempt.preparation.prefetch?.files.map(file => ({
      candidateAttemptIndex,
      candidate: attempt.candidate,
      preparationStatus: attempt.preparation.status,
      file,
    })) ?? []
  ));
}

function packageScope({ mode }: { mode: DownloadVerificationEvidenceInput['mode'] }): 'download-runtime-complete' | 'download-probe-only' {
  switch (mode) {
  case 'runtime-complete':
    return 'download-runtime-complete';
  case 'probe-only':
    return 'download-probe-only';
  default: {
    const _ex: never = mode;
    throw new Error(`Unhandled evidence mode: ${_ex}`);
  }
  }
}

function runtimeAcceptanceLimitation({ evidence }: { evidence: DownloadVerificationEvidenceInput }): string[] {
  const completion = evidence.runtimeCompletion;
  if (completion === undefined) return ['Repository-complete candidate evidence is not proof of runtime acceptance.'];
  switch (completion.status) {
  case 'accepted': {
    const identity = runtimeRevisionIdentity({ evidence });
    switch (identity) {
    case 'exact-resolved-revision':
      return [];
    case 'legacy-main-unverified':
    case 'unverified':
    case undefined:
      return ['Production runtime acceptance succeeded, but the accepted cache revision is not proven identical to the frozen repository revision.'];
    default: {
      const _ex: never = identity;
      throw new Error(`Unhandled runtime revision identity: ${String(_ex)}`);
    }
    }
  }
  case 'failed':
  case 'exhausted':
    return ['Repository-complete candidate evidence is not proof of runtime acceptance.'];
  default: {
    const _ex: never = completion.status;
    throw new Error(`Unhandled runtime completion status: ${_ex}`);
  }
  }
}

export function createDownloadVerificationEvidenceLaneFiles({ evidence }: {
  evidence: DownloadVerificationEvidenceInput;
}): {
  files: Record<string, string>;
  readiness: ReturnType<typeof testReadiness>;
  candidates: DownloadVerificationCandidateEvidence[];
  runtimeIdentity: {
    buildId: string;
    versions: typeof HOSTED_TRANSFORMERS_RUNTIME_ASSET_MANIFEST.versions;
  };
} {
  const candidates = candidateEvidence({ evidence });
  const readiness = testReadiness({ evidence, candidates });
  const runtimeIdentity = {
    buildId: HOSTED_TRANSFORMERS_RUNTIME_ASSET_MANIFEST.buildId,
    versions: HOSTED_TRANSFORMERS_RUNTIME_ASSET_MANIFEST.versions,
  };
  const events = [
    { at: evidence.run.startedAt, type: 'run-started', mode: evidence.mode, modelId: evidence.run.normalizedModelId },
    { at: evidence.run.finishedAt, type: 'repository-and-transport-completed', resolvedRevision: evidence.run.resolvedRevision },
    {
      at: evidence.run.finishedAt,
      type: 'artifact-request-observation-completed',
      observedCandidateCount: evidence.modelArtifactObservations.filter(item => item.status === 'observed').length,
      failedCandidateCount: evidence.modelArtifactObservations.filter(item => item.status === 'failed').length,
      observationError: evidence.modelArtifactObservationError ?? null,
    },
  ];
  const files: Record<string, string> = {
    'download-lane/repository.json': `${JSON.stringify({
      schemaVersion: 1,
      modelId: evidence.run.normalizedModelId,
      requestedRevision: evidence.run.requestedRevision,
      resolvedRevision: evidence.run.resolvedRevision,
      repositoryFileCount: evidence.run.repositoryFileCount,
      files: evidence.run.repositoryFiles,
      provenance: {
        source: 'hugging-face-public-repository-metadata',
        resolvedRevision: evidence.run.resolvedRevision,
        stability: 'stable',
      },
    }, undefined, 2)}\n`,
    'download-lane/artifact-requests.json': `${JSON.stringify({
      schemaVersion: 1,
      runtimeIdentity,
      observations: evidence.modelArtifactObservations,
      observationError: evidence.modelArtifactObservationError,
      provenance: {
        source: 'actual-transformers-js-production-autoclass-request-observation',
        resolvedRevision: evidence.run.resolvedRevision,
        stability: 'runtime-version-specific',
      },
    }, undefined, 2)}\n`,
    'download-lane/transport.json': `${JSON.stringify({
      schemaVersion: 1,
      maximumBytes: evidence.run.maximumBytes,
      bytesConsumed: evidence.run.bytesConsumed,
      skippedModelArtifactCount: evidence.run.skippedModelArtifactCount,
      observations: evidence.run.transportObservations,
      provenance: {
        source: 'browser-head-and-bounded-range-probe',
        resolvedRevision: evidence.run.resolvedRevision,
        stability: 'environment-specific',
      },
    }, undefined, 2)}\n`,
    'download-lane/candidates.json': `${JSON.stringify({
      schemaVersion: 1,
      productionOrder: TRANSFORMERS_JS_PRODUCTION_LOAD_CANDIDATES,
      candidates,
      firstRepositoryCompleteCandidate: candidates.find(candidate => candidate.status === 'repository-complete')?.candidate ?? null,
      limitation: 'Repository completeness does not prove runtime acceptance.',
    }, undefined, 2)}\n`,
    'download-lane/cache-before.json': `${JSON.stringify({
      schemaVersion: 1,
      status: evidence.cacheBefore === undefined ? 'not-observed' : 'observed',
      inventory: evidence.cacheBefore ?? null,
      error: evidence.cacheInspectionError ?? null,
      provenance: {
        source: 'opfs-revision-inventory',
        stability: 'environment-specific',
      },
    }, undefined, 2)}\n`,
    'download-lane/cache-after.json': `${JSON.stringify(evidence.runtimeCompletion === undefined ? {
      schemaVersion: 1,
      status: evidence.cacheBefore === undefined ? 'not-observed' : 'observed-no-mutation',
      inventory: evidence.cacheBefore ?? null,
      error: evidence.cacheInspectionError ?? null,
      note: 'Probe-only mode does not write model artifacts; cache-after therefore records the same bounded inventory observation as cache-before.',
      provenance: { source: 'probe-only-no-cache-mutation', stability: 'environment-specific' },
    } : {
      schemaVersion: 1,
      status: evidence.runtimeCompletion.cacheAfter === undefined ? 'not-observed' : 'observed',
      inventory: evidence.runtimeCompletion.cacheAfter ?? null,
      error: evidence.runtimeCompletion.cacheInspectionError ?? null,
      provenance: { source: 'opfs-revision-inventory-after-runtime-completion', stability: 'environment-specific' },
    }, undefined, 2)}\n`,
    'download-lane/prefetch.json': `${JSON.stringify(evidence.runtimeCompletion?.preparation === undefined ? {
      schemaVersion: 1,
      status: 'not-run',
      reason: prefetchNotRunReason({ evidence }),
    } : {
      schemaVersion: 1,
      status: evidence.runtimeCompletion.preparation.status,
      repositoryResolvedRevision: evidence.runtimeCompletion.repositoryResolvedRevision,
      runtimeArtifacts: evidence.runtimeCompletion.preparation.runtimeArtifacts,
      candidatePreparation: evidence.runtimeCompletion.preparation.candidates,
      fileObservations: runtimePrefetchFileEvidence({ evidence }),
      note: 'This evidence records file-level preparation observations and errors; model artifact bodies are not embedded in the archive.',
    }, undefined, 2)}\n`,
    'download-lane/cache-acceptance.json': `${JSON.stringify(evidence.runtimeCompletion === undefined ? {
      schemaVersion: 1,
      status: 'not-run',
      reason: 'Probe-only mode does not create a Production ORT session. Runtime acceptance requires runtime-complete investigation or a release canary.',
    } : {
      schemaVersion: 1,
      status: evidence.runtimeCompletion.status,
      source: evidence.runtimeCompletion.source,
      repositoryResolvedRevision: evidence.runtimeCompletion.repositoryResolvedRevision,
      cacheRevision: evidence.runtimeCompletion.cacheRevision,
      loaderRevisionOption: evidence.runtimeCompletion.loaderRevisionOption,
      revisionIdentity: runtimeRevisionIdentity({ evidence }) ?? null,
      selectedCandidate: evidence.runtimeCompletion.selectedCandidate ?? null,
      cacheReuse: evidence.runtimeCompletion.cacheReuse ?? null,
      error: evidence.runtimeCompletion.error ?? null,
    }, undefined, 2)}\n`,
    'download-lane/events.jsonl': `${events.map(event => JSON.stringify(event)).join('\n')}\n`,
    'download-lane/test-readiness.json': `${JSON.stringify(readiness, undefined, 2)}\n`,
  };
  return { files, readiness, candidates, runtimeIdentity };
}

export async function createDownloadVerificationEvidence({ evidence }: {
  evidence: DownloadVerificationEvidenceInput;
}): Promise<DownloadVerificationEvidenceArchive> {
  const zip = new JSZip();
  const { files: laneFiles, readiness, candidates, runtimeIdentity } = createDownloadVerificationEvidenceLaneFiles({ evidence });

  zip.file('SUMMARY.md', summaryMarkdown({ evidence, candidates }));
  zip.file('run.json', `${JSON.stringify({
    schemaVersion: 1,
    runId: evidence.runId,
    mode: evidence.mode,
    modelId: evidence.run.normalizedModelId,
    requestedRevision: evidence.run.requestedRevision,
    resolvedRevision: evidence.run.resolvedRevision,
    startedAt: evidence.run.startedAt,
    completedAt: evidence.run.finishedAt,
    runtimeIdentity,
  }, undefined, 2)}\n`);
  zip.file('test-readiness.json', `${JSON.stringify(readiness, undefined, 2)}\n`);
  for (const [path, content] of Object.entries(laneFiles)) {
    zip.file(path, content);
  }
  zip.file('package-assessment.json', `${JSON.stringify({
    schemaVersion: 1,
    status: 'valid-partial',
    runId: evidence.runId,
    scope: packageScope({ mode: evidence.mode }),
    limitations: [
      'This package records bounded repository observations and selected runtime completion facts; it does not contain model weight bodies.',
      ...runtimeAcceptanceLimitation({ evidence }),
      'First inference, generation, protocol, and continuity evidence are separate Model Support Investigation domains.',
    ],
  }, undefined, 2)}\n`);

  const manifestFiles = await Promise.all(Object.entries(zip.files)
    .filter(([, file]) => !file.dir)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(async ([path, file]) => {
      const bytes = await file.async('uint8array');
      return { path, byteLength: bytes.byteLength, sha256: await sha256Hex({ bytes }) };
    }));
  zip.file('manifest.json', `${JSON.stringify({
    schemaVersion: 1,
    runId: evidence.runId,
    generatedAt: evidence.run.finishedAt,
    files: manifestFiles,
  }, undefined, 2)}\n`);

  const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
  await verifyGeneratedEvidenceArchive({ blob });
  return {
    blob,
    fileName: `model-support-investigation-download-${safeFilePart({ value: evidence.run.normalizedModelId })}-${evidence.runId}.zip`,
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
  candidateEvidence,
  testReadiness,
};
