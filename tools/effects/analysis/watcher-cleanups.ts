import type ts from 'typescript';
import type { ContractOwner, FunctionValue } from './values.ts';
import type { EffectEdge } from './solve.ts';

export type WatcherCleanupUse = {
  callback: FunctionValue,
  owner: ContractOwner | undefined,
  node: ts.Node,
};

/**
 * A parallel contract row describes cleanup registered while a callable executes
 * in an active watcher. No reactive sources, schedules or mutation histories are
 * reconstructed. A stop operation consumes this row, not the ordinary callback.
 *
 * Registrations use the cleanup function's public contract. An unsafe exemption
 * on the registering function never exempts that independent deferred callable.
 */
export function connectWatcherCleanups({ owners, edges, registrations, stops }: {
  owners: ContractOwner[],
  edges: EffectEdge[],
  registrations: readonly WatcherCleanupUse[],
  stops: readonly WatcherCleanupUse[],
}): readonly { owner: number, node: ts.Node }[] {
  if (stops.length === 0) return [];
  const originals = [...owners];
  const dependencies = [...edges];
  const cleanups = new Map<number, ContractOwner>();
  for (const owner of originals) {
    const { id, label, location, anchor, annotation: _annotation, role: _role, declared, direct, callbackPaths, ...rest } = owner;
    rest satisfies Record<PropertyKey, never>;
    const cleanup: ContractOwner = {
      id: owners.length,
      label: `${label} <watch cleanup>`,
      location,
      anchor,
      annotation: undefined,
      role: 'body',
      // Symbolic invocation is substituted at the call site, but plain effects
      // are not evidence that a cleanup was registered.
      declared: declared.filter(effect => effect.kind === 'callback'),
      direct: direct.filter(effect => effect.kind === 'callback'),
      callbackPaths,
    };
    cleanups.set(id, cleanup);
    owners.push(cleanup);
  }
  const cleanupId = ({ id }: { id: number }): number => {
    const cleanup = cleanups.get(id);
    if (cleanup === undefined) throw new Error('Missing watcher cleanup contract.');
    return cleanup.id;
  };
  for (const edge of dependencies) {
    if (edge.cleanupBoundary) continue;
    const { source, target, bindings, location, reason, suppress: _suppress, cleanupBoundary: _boundary, ...rest } = edge;
    rest satisfies Record<PropertyKey, never>;
    edges.push({
      source: cleanupId({ id: source }),
      target: cleanupId({ id: target }),
      bindings: new Map([...bindings].map(([key, id]) => [key, cleanupId({ id })])),
      location,
      reason: `Watcher cleanup contract transfer: ${reason}`,
    });
  }
  for (const registration of registrations) {
    const { callback, owner, node, ...rest } = registration;
    rest satisfies Record<PropertyKey, never>;
    if (owner === undefined) continue;
    edges.push({
      source: callback.owner.id,
      target: cleanupId({ id: owner.id }),
      bindings: new Map(),
      location: { file: node.getSourceFile().fileName, start: node.getStart(), length: node.getWidth() },
      reason: 'Registered onWatcherCleanup callback',
    });
  }
  for (const stop of stops) {
    const { callback, owner, node, ...rest } = stop;
    rest satisfies Record<PropertyKey, never>;
    if (owner === undefined) continue;
    edges.push({
      source: cleanupId({ id: callback.owner.id }),
      target: owner.id,
      bindings: new Map(),
      location: { file: node.getSourceFile().fileName, start: node.getStart(), length: node.getWidth() },
      reason: 'Vue watcher stop: registered cleanup only',
    });
  }
  // Registration while a cleanup is itself executing depends on an ambient
  // outer watcher. The first precise-stop model explicitly rejects that extra
  // lifecycle layer instead of flattening it into a false empty stop contract.
  return registrations.map(({ callback, node }) => ({ owner: cleanupId({ id: callback.owner.id }), node }));
}
