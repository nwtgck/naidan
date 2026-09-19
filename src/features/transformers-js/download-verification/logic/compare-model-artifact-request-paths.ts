import type {
  DownloadVerificationModelArtifactPathParity,
  DownloadVerificationModelArtifactRequestObservation,
} from '@/features/transformers-js/download-verification/types';

function sortedUniquePaths({ paths }: { paths: readonly string[] }): string[] {
  return [...new Set(paths)].sort((left, right) => left.localeCompare(right));
}

export function compareModelArtifactRequestPaths({ expectedPaths, observation }: {
  expectedPaths: readonly string[];
  observation: DownloadVerificationModelArtifactRequestObservation;
}): DownloadVerificationModelArtifactPathParity {
  const expected = sortedUniquePaths({ paths: expectedPaths });
  const observed = sortedUniquePaths({ paths: observation.paths });
  const expectedSet = new Set(expected);
  const observedSet = new Set(observed);
  const missingPaths = expected.filter(path => !observedSet.has(path));
  const unexpectedPaths = observed.filter(path => !expectedSet.has(path));

  const status: DownloadVerificationModelArtifactPathParity['status'] = (() => {
    switch (observation.status) {
    case 'observed':
      return missingPaths.length === 0 && unexpectedPaths.length === 0 ? 'match' : 'mismatch';
    case 'failed':
      return 'observation-failed';
    default: {
      const _ex: never = observation.status;
      throw new Error(`Unhandled observation status: ${_ex}`);
    }
    }
  })();

  return {
    status,
    expectedPaths: expected,
    observedPaths: observed,
    missingPaths,
    unexpectedPaths,
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
  sortedUniquePaths,
};
