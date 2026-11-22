export type UpdateMode = 'all' | 'none' | 'none-fail' | 'older';
export type ExistingDestinationUpdateDecision = 'replace' | 'skip' | 'skip-error';

const UPDATE_MODES = ['all', 'none', 'none-fail', 'older'] as const satisfies readonly UpdateMode[];

export function parseUpdateMode({ value }: { value: string }): UpdateMode | undefined {
  const exact = UPDATE_MODES.find((candidate) => candidate === value);
  if (exact !== undefined) {
    return exact;
  }
  if (value.length === 0) {
    return undefined;
  }

  const matches = UPDATE_MODES.filter((candidate) => candidate.startsWith(value));
  return matches.length === 1 ? matches[0] : undefined;
}

export function resolveExistingDestinationUpdate({
  mode,
  sourceMtime,
  destinationMtime,
}: {
  mode: UpdateMode;
  sourceMtime: number;
  destinationMtime: number;
}): ExistingDestinationUpdateDecision {
  switch (mode) {
  case 'all':
    return 'replace';
  case 'none':
    return 'skip';
  case 'none-fail':
    return 'skip-error';
  case 'older':
    return sourceMtime > destinationMtime ? 'replace' : 'skip';
  default: {
    const _ex: never = mode;
    return _ex;
  }
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
export const TEST_ONLY = {
};
