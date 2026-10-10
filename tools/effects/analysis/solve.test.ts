import { describe, expect, it } from 'vitest';
import { mergeEffects, operationEffect, printEffect } from '../contracts/effects.ts';
import { solveEffects, type EffectEdge, type EffectNode } from './solve.ts';

const location = { file: 'test.ts', start: 0, length: 1 };
const write = operationEffect({ name: 'localstorage.write' });

describe('effect worklist', () => {
  it('propagates through a 5000-owner chain without recursion', () => {
    const nodes: EffectNode[] = Array.from({ length: 5000 }, (_, id) => ({ id, label: String(id), location, declared: [], direct: id === 0 ? [write] : [] }));
    const edges: EffectEdge[] = nodes.slice(1).map(node => ({ source: node.id - 1, target: node.id, bindings: new Map(), location, reason: 'call' }));
    const result = solveEffects({ nodes, edges, budget: 100_000 });
    expect(result.rows.get(4999)).toEqual([write]);
  });

  it('terminates on a cycle and retains declared upper bounds', () => {
    const nodes: EffectNode[] = [0, 1, 2].map(id => ({ id, label: String(id), location, declared: id === 0 ? [write] : [], direct: [] }));
    const edges: EffectEdge[] = nodes.map(node => ({ source: node.id, target: (node.id + 1) % 3, bindings: new Map(), location, reason: 'cycle' }));
    expect([...solveEffects({ nodes, edges, budget: 100 }).rows.values()]).toEqual([[write], [write], [write]]);
  });

  it('specializes a callback without widening the generic helper', () => {
    const nodes: EffectNode[] = [
      { id: 0, label: 'helper', location, declared: [{ kind: 'callback', path: ['arg0', 'operation'] }], direct: [] },
      { id: 1, label: 'callback', location, declared: [write], direct: [] },
      { id: 2, label: 'caller', location, declared: [], direct: [] },
    ];
    const edges: EffectEdge[] = [{ source: 0, target: 2, bindings: new Map([['call(arg0.operation)', 1]]), location, reason: 'callback' }];
    const result = solveEffects({ nodes, edges, budget: 100 });
    expect(result.rows.get(2)).toEqual([write]);
    expect(result.rows.get(0)).toEqual(nodes[0]!.declared);
  });

  it('matches an independent full-scan oracle for seeded graphs', () => {
    let seed = 71;
    const random = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed;
    };
    for (let sample = 0; sample < 100; sample++) {
      const nodes: EffectNode[] = Array.from({ length: 20 }, (_, id) => ({ id, label: String(id), location, declared: [], direct: random() % 7 === 0 ? [operationEffect({ name: ['opfs.read', 'opfs.write', 'network.http'][random() % 3]! })] : [] }));
      const edges: EffectEdge[] = Array.from({ length: 50 }, () => ({ source: random() % 20, target: random() % 20, bindings: new Map(), location, reason: 'generated' }));
      const expected = new Map(nodes.map(node => [node.id, node.direct]));
      for (let pass = 0; pass < 20; pass++) for (const edge of edges) expected.set(edge.target, mergeEffects({ groups: [expected.get(edge.target)!, expected.get(edge.source)!] }));
      for (const ordering of [edges, [...edges].reverse()]) {
        const actual = solveEffects({ nodes, edges: ordering, budget: 100_000 });
        for (const node of nodes) expect(actual.rows.get(node.id)?.map(effect => printEffect({ effect }))).toEqual(expected.get(node.id)?.map(effect => printEffect({ effect })));
      }
    }
  });

  it('reports budget exhaustion instead of a partial successful analysis', () => {
    const nodes: EffectNode[] = [{ id: 0, label: 'a', location, declared: [write], direct: [] }, { id: 1, label: 'b', location, declared: [], direct: [] }];
    expect(() => solveEffects({ nodes, edges: [{ source: 0, target: 1, bindings: new Map(), location, reason: 'call' }], budget: 0 })).toThrow('budget');
  });
});
