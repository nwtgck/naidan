import type { ArgvSpecialParseResult } from '@/features/wesh/argv';

export type UpdateMode = 'all' | 'none' | 'none-fail' | 'older';
export type ExistingDestinationUpdateDecision = 'replace' | 'skip' | 'skip-error';

const UPDATE_MODES = ['all', 'none', 'none-fail', 'older'] as const satisfies readonly UpdateMode[];

function parseUpdateMode({ value }: { value: string }): UpdateMode | undefined {
  const exact = UPDATE_MODES.find((candidate) => candidate === value);
  if (exact !== undefined) return exact;
  if (value.length === 0) return undefined;

  const matches = UPDATE_MODES.filter((candidate) => candidate.startsWith(value));
  return matches.length === 1 ? matches[0] : undefined;
}

export function parseUpdateLongOption({
  token,
}: {
  token: string;
}): ArgvSpecialParseResult | undefined {
  if (token === '--update') {
    return {
      kind: 'matched',
      consumeCount: 1,
      effects: [{ key: 'updateMode', value: 'older' }],
      occurrences: [{
        kind: 'special',
        option: '--update',
        effects: [{ key: 'updateMode', value: 'older' }],
      }],
    };
  }

  const prefix = '--update=';
  if (!token.startsWith(prefix)) return undefined;

  const rawValue = token.slice(prefix.length);
  const mode = parseUpdateMode({ value: rawValue });
  const effects = mode === undefined
    ? [{ key: 'updateParseError', value: rawValue }]
    : [{ key: 'updateMode', value: mode }];
  return {
    kind: 'matched',
    consumeCount: 1,
    effects,
    occurrences: [{
      kind: 'special',
      option: '--update',
      effects,
    }],
  };
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
  parseUpdateMode,
};
