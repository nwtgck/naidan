import { describe, expect, it } from 'vitest';
import { printEffect, operationEffect, type Effect } from '../contracts/effects.ts';
import { solveEffects, type EffectNode, type EffectEdge } from './solve.ts';

const location = { file: 'fixture.ts', start: 0, length: 1 };
const read = operationEffect({ name: 'opfs.read' });
const write = operationEffect({ name: 'opfs.write' });
const network = operationEffect({ name: 'network.http' });

function node({ id, direct }: { id: number, direct: readonly Effect[] }): EffectNode {
  return { id, label: String(id), location, declared: [], direct };
}

describe('fixed-point edges with explicit operation suppression', () => {
  it('filters only the boundary edge and preserves an independent bypass', () => {
    const nodes = [node({ id: 0, direct: [read, write] }), node({ id: 1, direct: [] }), node({ id: 2, direct: [] })];
    const edges: EffectEdge[] = [
      { source: 0, target: 1, location, bindings: new Map(), reason: 'boundary', suppress: [write] },
      { source: 1, target: 2, location, bindings: new Map(), reason: 'caller' },
      { source: 0, target: 2, location, bindings: new Map(), reason: 'independent call' },
    ];
    const result = solveEffects({ nodes, edges, budget: 100 });
    expect(result.rows.get(0)).toEqual([read, write]);
    expect(result.rows.get(1)).toEqual([read]);
    expect(result.rows.get(2)).toEqual([read, write]);
    expect(result.causes.get(`2:${printEffect({ effect: write })}`)?.reason).toBe('independent call');
  });

  it('substitutes concrete callbacks before applying a boundary filter', () => {
    const callback: Effect = { kind: 'callback', path: ['arg0'] };
    const nodes = [node({ id: 0, direct: [callback] }), node({ id: 1, direct: [read, write] }), node({ id: 2, direct: [] })];
    const edges: EffectEdge[] = [{ source: 0, target: 2, bindings: new Map([['call(arg0)', 1]]), location, reason: 'specialized', suppress: [write] }];
    expect(solveEffects({ nodes, edges, budget: 100 }).rows.get(2)).toEqual([read]);
  });

  it('does not subtract one literal target from an unknown wildcard operation', () => {
    const literal: Effect = { kind: 'operation', name: 'opfs.write', target: { kind: 'literal', value: 'probe' } };
    const nodes = [node({ id: 0, direct: [write] }), node({ id: 1, direct: [] })];
    const edges: EffectEdge[] = [{ source: 0, target: 1, bindings: new Map(), location, reason: 'narrow filter', suppress: [literal] }];
    expect(solveEffects({ nodes, edges, budget: 100 }).rows.get(1)).toEqual([write]);
  });

  it('can hide a known literal operation without hiding another target', () => {
    const literal: Effect = { kind: 'operation', name: 'opfs.write', target: { kind: 'literal', value: 'probe' } };
    const other: Effect = { kind: 'operation', name: 'opfs.write', target: { kind: 'literal', value: 'user' } };
    const nodes = [node({ id: 0, direct: [literal, other] }), node({ id: 1, direct: [] })];
    const edges: EffectEdge[] = [{ source: 0, target: 1, bindings: new Map(), location, reason: 'narrow filter', suppress: [literal] }];
    expect(solveEffects({ nodes, edges, budget: 100 }).rows.get(1)).toEqual([other]);
  });

  it('matches a separate set-union oracle on 200 seeded cyclic graphs and reversed order', () => {
    let seed = 173;
    const random = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed;
    };
    const domain = [read, write, network];
    for (let sample = 0; sample < 200; sample++) {
      const nodes = Array.from({ length: 18 }, (_, id) => node({ id, direct: random() % 3 === 0 ? [domain[random() % 3]!] : [] }));
      const edges: EffectEdge[] = Array.from({ length: 38 }, () => ({
        source: random() % 18,
        target: random() % 18,
        location,
        bindings: new Map(),
        reason: 'generated',
        suppress: random() % 3 === 0 ? [domain[random() % 3]!] : [],
      }));
      const expected = new Map(nodes.map(item => [item.id, new Set(item.direct.map(effect => printEffect({ effect })))]));
      let changed: boolean;
      do {
        changed = false;
        for (const edge of edges) {
          const masks = new Set((edge.suppress ?? []).map(effect => printEffect({ effect })));
          for (const effect of expected.get(edge.source)!) {
            const target = expected.get(edge.target)!;
            if (!masks.has(effect) && !target.has(effect)) {
              target.add(effect); changed = true;
            }
          }
        }
      } while (changed);
      for (const ordering of [edges, [...edges].reverse()]) {
        const actual = solveEffects({ nodes, edges: ordering, budget: 100_000 });
        for (const item of nodes) expect(actual.rows.get(item.id)!.map(effect => printEffect({ effect }))).toEqual([...expected.get(item.id)!].sort());
      }
    }
  });
});
