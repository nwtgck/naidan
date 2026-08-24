import type { ArgvOptionOccurrence } from '@/features/wesh/argv';

export type CopyMovePreHelpSemanticError =
  | { readonly kind: 'invalid-update', readonly value: string }
  | { readonly kind: 'multiple-target-directories' };

export function findCopyMovePreHelpSemanticError({
  occurrences,
}: {
  occurrences: readonly ArgvOptionOccurrence[],
}): CopyMovePreHelpSemanticError | undefined {
  let targetDirectoryCount = 0;

  for (const occurrence of occurrences) {
    switch (occurrence.kind) {
    case 'value':
      if (occurrence.key !== 'targetDirectory') break;
      targetDirectoryCount += 1;
      if (targetDirectoryCount > 1) return { kind: 'multiple-target-directories' };
      break;
    case 'special':
      for (const effect of occurrence.effects) {
        if (effect.key === 'updateParseError' && typeof effect.value === 'string') {
          return { kind: 'invalid-update', value: effect.value };
        }
      }
      break;
    case 'flag':
      break;
    default: {
      const _ex: never = occurrence;
      throw new Error(`Unhandled copy/move argv occurrence: ${String(_ex)}`);
    }
    }
  }

  return undefined;
}

// ESLint-required test-only export for TypeScript modules.
export const TEST_ONLY = {
};
