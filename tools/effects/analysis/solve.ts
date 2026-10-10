import { effectCovered, mergeEffects, printEffect, type Effect } from '../contracts/effects.ts';
import type { SourceLocation } from '../diagnostics.ts';

export type EffectNode = {
  id: number,
  label: string,
  location: SourceLocation,
  declared: readonly Effect[],
  direct: readonly Effect[],
};
export type EffectEdge = {
  source: number,
  target: number,
  bindings: ReadonlyMap<string, number>,
  location: SourceLocation,
  reason: string,
  /** The call executes in another framework registration region, not the current watcher. */
  cleanupBoundary?: true,
  /** Only the implementation-to-public edge may hide explicitly listed operations. */
  suppress?: readonly Effect[],
};
export type EffectSolution = {
  rows: ReadonlyMap<number, readonly Effect[]>,
  causes: ReadonlyMap<string, EffectEdge>,
  steps: number,
};

/** Monotone worklist; a callback binding is an additional dependency of the edge. */
export function solveEffects({ nodes, edges, budget }: { nodes: readonly EffectNode[], edges: readonly EffectEdge[], budget: number }): EffectSolution {
  const rows = new Map(nodes.map(node => [node.id, mergeEffects({ groups: [node.declared, node.direct] })]));
  const reverse = new Map<number, Set<EffectEdge>>(nodes.map(node => [node.id, new Set()]));
  const pending = [...nodes.map(node => node.id)];
  const queued = new Set(pending);
  const causes = new Map<string, EffectEdge>();
  for (const edge of edges) {
    const dependencies = new Set([edge.source, ...edge.bindings.values()]);
    for (const dependency of dependencies) {
      const entry = reverse.get(dependency);
      if (entry === undefined || !rows.has(edge.target)) throw new Error('Invalid effect graph reference.');
      entry.add(edge);
    }
  }
  let steps = 0;
  for (let head = 0; head < pending.length; head++) {
    const changed = pending[head]!;
    queued.delete(changed);
    for (const edge of reverse.get(changed) ?? []) {
      if (++steps > budget) throw new Error('Effect propagation exceeded its explicit analysis budget.');
      const target = rows.get(edge.target)!;
      const incoming: Effect[] = [];
      for (const effect of rows.get(edge.source)!) {
        const binding = edge.bindings.get(printEffect({ effect }));
        incoming.push(...(binding === undefined ? [effect] : rows.get(binding)!));
      }
      const additions = incoming.filter(effect => !effectCovered({ effect, allowed: edge.suppress ?? [] }) && !effectCovered({ effect, allowed: target }));
      if (additions.length === 0) continue;
      rows.set(edge.target, mergeEffects({ groups: [target, additions] }));
      for (const effect of additions) causes.set(`${edge.target}:${printEffect({ effect })}`, edge);
      if (!queued.has(edge.target)) {
        queued.add(edge.target); pending.push(edge.target);
      }
    }
  }
  return { rows, causes, steps };
}
