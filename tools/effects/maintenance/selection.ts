import path from 'node:path';
import ts from 'typescript';
import type { ContractOwner } from '../analysis/values.ts';
import { mayOmitEffectAnnotation } from '../analysis/annotation-policy.ts';

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
 * storage contract. An already empty annotation on a trivial implementation may
 * be omitted, while wider expression-owned bounds remain fixed for future use.
 */
export function selectTidyOwners({ owners, files }: {
  owners: readonly ContractOwner[], files: ReadonlySet<string>,
}): readonly TidySelection[] {
  const selections: TidySelection[] = [];
  for (const owner of owners) {
    let module: boolean;
    switch (owner.role) {
    case 'body': case 'symbolic': continue;
    case 'module': module = true; break;
    case 'implementation': case 'slot': case 'signature': module = false; break;
    default: { const exhaustive: never = owner.role; throw new Error(String(exhaustive)); }
    }
    let disposition: TidySelection['disposition'] = 'preserve';
    let reason: string;
    const file = path.resolve(owner.location.file);
    if (!files.has(file)) {
      reason = 'Outside the explicitly selected tidy files; its public bound is fixed.';
    } else if (owner.annotation === undefined) {
      reason = mayOmitEffectAnnotation({ owner }) ? 'Trivial implementation has an implicit empty bound; there is no explicit contract to tidy.' : 'Missing contract; run the widening fix before maintenance.';
    } else if (module) {
      disposition = 'infer';
      reason = 'Selected module contract; infer from top-level operations and fixed import boundaries.';
    } else if (owner.role === 'implementation' && ts.isFunctionDeclaration(owner.anchor) && owner.anchor.body !== undefined) {
      disposition = 'infer';
      reason = 'Selected function declaration with a checked body; infer from operations and fixed contract boundaries.';
    } else if (owner.declared.length === 0 && mayOmitEffectAnnotation({ owner })) {
      disposition = 'infer';
      reason = 'Selected redundant empty annotation on a trivial implementation; retain its implicit empty bound.';
    } else {
      reason = 'Callable slots, signatures, methods and expression-owned contracts remain fixed in this tidy version.';
    }
    selections.push({ owner: owner.id, file, start: owner.location.start, label: owner.label, disposition, reason });
  }
  return selections;
}
