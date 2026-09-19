import type {
  DownloadVerificationModelArtifactRequestObservation,
  DownloadVerificationModelArtifactRequestPairingResult,
} from '@/features/transformers-js/download-verification/types';

function sameCandidate({
  left,
  right,
}: {
  left: DownloadVerificationModelArtifactRequestObservation['candidate'];
  right: DownloadVerificationModelArtifactRequestObservation['candidate'];
}): boolean {
  return left.device === right.device && left.dtype === right.dtype;
}

function requestMap({
  observation,
}: {
  observation: DownloadVerificationModelArtifactRequestObservation;
}): { status: 'ok'; requests: Map<string, string> } | { status: 'failed'; reason: string } {
  const requests = new Map<string, string>();
  for (const request of observation.requests) {
    const existing = requests.get(request.path);
    if (existing !== undefined && existing !== request.url) {
      return {
        status: 'failed',
        reason: `Observed more than one URL for model artifact path: ${request.path}`,
      };
    }
    requests.set(request.path, request.url);
  }

  const observedPaths = [...new Set(observation.paths)].sort((a, b) => a.localeCompare(b));
  const requestPaths = [...requests.keys()].sort((a, b) => a.localeCompare(b));
  if (observedPaths.length !== requestPaths.length || observedPaths.some((path, index) => path !== requestPaths[index])) {
    return {
      status: 'failed',
      reason: 'Observed model artifact paths and request records are inconsistent',
    };
  }
  return { status: 'ok', requests };
}

export function pairModelArtifactRequests({
  immutableObservation,
  cacheIdentityObservation,
}: {
  immutableObservation: DownloadVerificationModelArtifactRequestObservation;
  cacheIdentityObservation: DownloadVerificationModelArtifactRequestObservation;
}): DownloadVerificationModelArtifactRequestPairingResult {
  switch (immutableObservation.status) {
  case 'observed':
    break;
  case 'failed':
    return { status: 'failed', reason: 'Immutable-revision model artifact observation failed' };
  default: {
    const _ex: never = immutableObservation.status;
    throw new Error(`Unhandled immutable observation status: ${_ex}`);
  }
  }
  switch (cacheIdentityObservation.status) {
  case 'observed':
    break;
  case 'failed':
    return { status: 'failed', reason: 'Production-cache model artifact observation failed' };
  default: {
    const _ex: never = cacheIdentityObservation.status;
    throw new Error(`Unhandled cache identity observation status: ${_ex}`);
  }
  }
  if (immutableObservation.modelId !== cacheIdentityObservation.modelId) {
    return { status: 'failed', reason: 'Model artifact observations target different model IDs' };
  }
  if (immutableObservation.autoClass !== cacheIdentityObservation.autoClass) {
    return { status: 'failed', reason: 'Model artifact observations resolved different Production Auto classes' };
  }
  if (!sameCandidate({ left: immutableObservation.candidate, right: cacheIdentityObservation.candidate })) {
    return { status: 'failed', reason: 'Model artifact observations target different Production candidates' };
  }

  const immutableResult = requestMap({ observation: immutableObservation });
  let immutableRequests: Map<string, string>;
  switch (immutableResult.status) {
  case 'ok':
    immutableRequests = immutableResult.requests;
    break;
  case 'failed':
    return immutableResult;
  default: {
    const _ex: never = immutableResult;
    throw new Error(`Unhandled immutable request-map result: ${String(_ex)}`);
  }
  }

  const cacheIdentityResult = requestMap({ observation: cacheIdentityObservation });
  let cacheIdentityRequests: Map<string, string>;
  switch (cacheIdentityResult.status) {
  case 'ok':
    cacheIdentityRequests = cacheIdentityResult.requests;
    break;
  case 'failed':
    return cacheIdentityResult;
  default: {
    const _ex: never = cacheIdentityResult;
    throw new Error(`Unhandled cache identity request-map result: ${String(_ex)}`);
  }
  }

  const immutablePaths = [...immutableRequests.keys()].sort((a, b) => a.localeCompare(b));
  const cachePaths = [...cacheIdentityRequests.keys()].sort((a, b) => a.localeCompare(b));
  if (immutablePaths.length !== cachePaths.length || immutablePaths.some((path, index) => path !== cachePaths[index])) {
    return {
      status: 'failed',
      reason: 'Immutable revision and Production cache revision resolved different model artifact paths',
    };
  }

  return {
    status: 'paired',
    modelId: immutableObservation.modelId,
    autoClass: immutableObservation.autoClass,
    candidate: immutableObservation.candidate,
    fetchRevision: immutableObservation.revision,
    cacheRevision: cacheIdentityObservation.revision,
    requests: immutablePaths.map(path => ({
      path,
      fetchUrl: immutableRequests.get(path)!,
      cacheUrl: cacheIdentityRequests.get(path)!,
    })),
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
