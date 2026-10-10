import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { connectWatcherCleanups, type WatcherCleanupUse } from './watcher-cleanups.ts';
import { solveEffects, type EffectEdge } from './solve.ts';
import type { ContractOwner, FunctionValue } from './values.ts';
import { SCALAR } from './values.ts';
import { operationEffect, printEffect } from '../contracts/effects.ts';

const anchor = ts.createSourceFile('fixture.ts', 'function task() {}', ts.ScriptTarget.ES2023, true).statements[0]!;

function owner({ id, effects }: { id: number, effects: readonly string[] }): ContractOwner {
  return {
    id,
    label: `task${id}`,
    anchor,
    location: { file: 'fixture.ts', start: 0, length: 18 },
    role: 'implementation',
    annotation: undefined,
    declared: [],
    direct: effects.map(name => operationEffect({ name })),
    callbackPaths: new Set(),
  };
}

function callable({ owner }: { owner: ContractOwner }): FunctionValue {
  return { kind: 'function', owner, parameters: [], returns: SCALAR, declaration: undefined, transport: 'local' };
}

function unionInto({ target, source }: { target: Set<string>, source: Iterable<string> }): boolean {
  const before = target.size;
  for (const item of source) target.add(item);
  return target.size !== before;
}

describe('watcher cleanup summary compilation', () => {
  it('does not allocate the secondary graph when no stop consumes it', () => {
    const owners = [owner({ id: 0, effects: ['localstorage.write'] })];
    const edges: EffectEdge[] = [];
    expect(connectWatcherCleanups({ owners, edges, registrations: [], stops: [] })).toEqual([]);
    expect(owners).toHaveLength(1);
    expect(edges).toEqual([]);
  });

  it('matches two simultaneous fixed-point equations on 96 seeded cyclic graphs', () => {
    let seed = 7241;
    const next = (): number => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed;
    };
    for (let trial = 0; trial < 96; trial++) {
      const names = ['localstorage.write', 'sessionstorage.write', 'network.http'];
      const originals = Array.from({ length: 8 }, (_, id) => owner({ id, effects: names.filter(() => next() % 3 === 0) }));
      const dependencies: EffectEdge[] = Array.from({ length: 14 }, () => ({
        source: next() % 8,
        target: next() % 8,
        bindings: new Map(),
        location: originals[0]!.location,
        reason: 'test call',
        ...(next() % 3 === 0 ? { cleanupBoundary: true as const } : {}),
        ...(next() % 3 === 0 ? { suppress: [operationEffect({ name: 'network.http' })] } : {}),
      }));
      const registrations: WatcherCleanupUse[] = Array.from({ length: 4 }, () => ({ callback: callable({ owner: originals[next() % 8]! }), owner: originals[next() % 8]!, node: anchor }));
      const stops: WatcherCleanupUse[] = Array.from({ length: 3 }, () => ({ callback: callable({ owner: originals[next() % 8]! }), owner: originals[next() % 8]!, node: anchor }));
      const ordinary = originals.map(item => new Set(item.direct.map(effect => printEffect({ effect }))));
      const cleanup = originals.map(() => new Set<string>());
      let changed = true;
      let iterations = 0;
      while (changed) {
        changed = false;
        expect(++iterations).toBeLessThan(100);
        for (const edge of dependencies) {
          const suppressed = new Set(edge.suppress?.map(effect => printEffect({ effect })) ?? []);
          changed = unionInto({ target: ordinary[edge.target]!, source: [...ordinary[edge.source]!].filter(item => !suppressed.has(item)) }) || changed;
          if (!edge.cleanupBoundary) changed = unionInto({ target: cleanup[edge.target]!, source: cleanup[edge.source]! }) || changed;
        }
        for (const registration of registrations) changed = unionInto({ target: cleanup[registration.owner!.id]!, source: ordinary[registration.callback.owner.id]! }) || changed;
        for (const stop of stops) changed = unionInto({ target: ordinary[stop.owner!.id]!, source: cleanup[stop.callback.owner.id]! }) || changed;
      }
      for (const reverse of [false, true]) {
        const owners = [...originals];
        const edges = reverse ? [...dependencies].reverse() : [...dependencies];
        connectWatcherCleanups({ owners, edges, registrations: reverse ? [...registrations].reverse() : registrations, stops });
        const result = solveEffects({ nodes: owners, edges, budget: 100_000 });
        for (const node of originals) expect(result.rows.get(node.id)?.map(effect => printEffect({ effect })).sort()).toEqual([...ordinary[node.id]!].sort());
      }
    }
  });
});
