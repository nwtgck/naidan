import path from 'node:path';
import ts from 'typescript';
import type { ContractOwner } from '../analysis/values.ts';

export type TidySelection = {
  owner: number,
  file: string,
  start: number,
  label: string,
  disposition: 'infer' | 'preserve',
  reason: string,
};

/**
 * Tidy is opt-in for implementation declarations, not a rewrite of every callable
 * storage contract. In particular an arrow property's empty initializer is not a
 * reason to remove permissions for future assignments. More owner forms can be
 * supported later, with explicit selection and compatibility tests.
 */
export function selectTidyOwners({ owners, files }: {
  owners: readonly ContractOwner[], files: ReadonlySet<string>,
}): readonly TidySelection[] {
  const selections: TidySelection[] = [];
  for (const owner of owners) {
    switch (owner.role) {
    case 'body': case 'module': case 'symbolic': continue;
    case 'implementation': case 'slot': case 'signature': break;
    default: { const exhaustive: never = owner.role; throw new Error(String(exhaustive)); }
    }
    let disposition: TidySelection['disposition'] = 'preserve';
    let reason: string;
    const file = path.resolve(owner.location.file);
    if (!files.has(file)) {
      reason = 'Outside the explicitly selected tidy files; its public bound is fixed.';
    } else if (owner.annotation === undefined) {
      reason = 'Missing contract; run the widening fix before maintenance.';
    } else if (owner.role === 'implementation' && ts.isFunctionDeclaration(owner.anchor) && owner.anchor.body !== undefined) {
      disposition = 'infer';
      reason = 'Selected function declaration with a checked body; infer from operations and fixed contract boundaries.';
    } else {
      reason = 'Callable slots, signatures, methods and expression-owned contracts remain fixed in this tidy version.';
    }
    selections.push({ owner: owner.id, file, start: owner.location.start, label: owner.label, disposition, reason });
  }
  return selections;
}
