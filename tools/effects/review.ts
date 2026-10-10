import type { EffectOrigin, EffectsAnalysis } from './analysis/analyze.ts';
import type { ContractOwner } from './analysis/values.ts';
import type { EffectEdge } from './analysis/solve.ts';
import type { SourceLocation } from './diagnostics.ts';
import { effectCovered, printEffect, type Effect } from './contracts/effects.ts';

export type EffectWitness = {
  effect: string,
  basis: 'modeled-operation' | 'declared-upper-bound' | 'callback-contract' | 'truncated' | 'unavailable',
  path: readonly (SourceLocation & { label: string, reason: string })[],
};
export type EffectContractReview = SourceLocation & {
  owner: number,
  label: string,
  role: ContractOwner['role'],
  declared: readonly string[],
  outward: readonly string[],
  missing: readonly string[],
  witnesses: readonly EffectWitness[],
};

type ReviewContext = {
  analysis: EffectsAnalysis,
  owners: ReadonlyMap<number, ContractOwner>,
  origins: ReadonlyMap<number, EffectsAnalysis['origins']>,
  incoming: ReadonlyMap<number, readonly EffectEdge[]>,
  budget: number,
};
type Search = { owner: number, effect: Effect, path: EffectWitness['path'] };

/**
 * Build one bounded contract-dependency witness, not a runtime execution trace.
 * An existing annotation must not hide modeled causes after a successful fix.
 * A deliberately wider annotation remains a valid leaf when no operation supports
 * that part of the upper bound. Diagnostics and assumptions remain separate.
 */
function witness({ context, owner, effect }: { context: ReviewContext, owner: number, effect: Effect }): EffectWitness {
  const pending: Search[] = [{ owner, effect, path: [] }];
  const visited = new Set<string>();
  const effectText = printEffect({ effect });
  let fallback: EffectWitness | undefined;
  let steps = 0;
  for (let head = 0; head < pending.length; head++) {
    if (++steps > context.budget) return { effect: effectText, basis: 'truncated', path: pending[head]?.path ?? [] };
    const current = pending[head]!;
    const key = `${current.owner}:${printEffect({ effect: current.effect })}`;
    if (visited.has(key)) continue;
    visited.add(key);
    const entry = context.owners.get(current.owner);
    if (entry === undefined) continue;
    const direct = (context.origins.get(entry.id) ?? []).find(origin => effectCovered({ effect: current.effect, allowed: [origin.effect] }));
    if (direct !== undefined) return {
      effect: effectText,
      basis: 'modeled-operation',
      path: [...current.path, { ...direct.location, label: entry.label, reason: direct.reason }],
    };
    if (fallback === undefined && effectCovered({ effect: current.effect, allowed: entry.declared })) {
      fallback = {
        effect: effectText,
        basis: (() => {
          switch (entry.role) {
          case 'symbolic': return 'callback-contract';
          case 'implementation': case 'slot': case 'signature': case 'module': case 'body': return 'declared-upper-bound';
          default: { const exhaustive: never = entry.role; throw new Error(String(exhaustive)); }
          }
        })(),
        path: [...current.path, { ...entry.location, label: entry.label, reason: 'Declared upper bound; not an obligation to execute this effect.' }],
      };
    }
    for (const edge of context.incoming.get(entry.id) ?? []) {
      if (++steps > context.budget) return { effect: effectText, basis: 'truncated', path: current.path };
      for (const sourceEffect of context.analysis.solution.rows.get(edge.source) ?? []) {
        const binding = edge.bindings.get(printEffect({ effect: sourceEffect }));
        const candidates = binding === undefined ? [sourceEffect] : context.analysis.solution.rows.get(binding) ?? [];
        for (const candidate of candidates) {
          if (++steps > context.budget) return { effect: effectText, basis: 'truncated', path: current.path };
          if (!effectCovered({ effect: current.effect, allowed: [candidate] })
            || effectCovered({ effect: candidate, allowed: edge.suppress ?? [] })) continue;
          const callee = context.owners.get(edge.source)?.label ?? '<unknown>';
          const reason = binding === undefined ? `${edge.reason}: ${callee}`
            : `${edge.reason}: ${callee}; substitute ${printEffect({ effect: sourceEffect })}`;
          pending.push({
            owner: binding ?? edge.source,
            effect: candidate,
            path: [...current.path, { ...edge.location, label: entry.label, reason }],
          });
        }
      }
    }
  }
  return fallback ?? { effect: effectText, basis: 'unavailable', path: [] };
}

/** Review is opt-in and informational. It never changes checking, fixing or policy. */
export function reviewEffects({ analysis, budget }: { analysis: EffectsAnalysis, budget: number }): readonly EffectContractReview[] {
  if (!Number.isSafeInteger(budget) || budget < 1) throw new Error('Effect review budget must be a positive safe integer.');
  const incoming = new Map<number, EffectEdge[]>();
  for (const edge of analysis.dependencies) {
    const values = incoming.get(edge.target) ?? [];
    values.push(edge);
    incoming.set(edge.target, values);
  }
  for (const values of incoming.values()) values.sort((left, right) => left.location.file.localeCompare(right.location.file)
    || left.location.start - right.location.start || left.source - right.source);
  const origins = new Map<number, EffectOrigin[]>();
  for (const origin of analysis.origins) {
    const values = origins.get(origin.owner) ?? [];
    values.push(origin);
    origins.set(origin.owner, values);
  }
  const context: ReviewContext = { analysis, origins, owners: new Map(analysis.owners.map(owner => [owner.id, owner])), incoming, budget };
  return analysis.owners.filter(owner => owner.role !== 'symbolic' && owner.role !== 'body')
    .map(owner => {
      const row = analysis.solution.rows.get(owner.id) ?? [];
      return {
        ...owner.location,
        owner: owner.id,
        label: owner.label,
        role: owner.role,
        declared: owner.declared.map(effect => printEffect({ effect })),
        outward: row.map(effect => printEffect({ effect })),
        missing: row.filter(effect => !effectCovered({ effect, allowed: owner.declared })).map(effect => printEffect({ effect })),
        witnesses: row.map(effect => witness({ context, owner: owner.id, effect })),
      };
    })
    .sort((left, right) => left.file.localeCompare(right.file) || left.start - right.start || left.owner - right.owner);
}
