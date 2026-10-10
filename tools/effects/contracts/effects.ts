/** Effect rows are upper bounds, not obligations to execute every listed operation. */
export type Effect =
  | { kind: 'operation', name: string, target: { kind: 'all' } | { kind: 'literal', value: string } | undefined }
  | { kind: 'callback', path: readonly string[] };

export function printEffect({ effect }: { effect: Effect }): string {
  switch (effect.kind) {
  case 'callback': return `call(${effect.path.join('.')})`;
  case 'operation': {
    const { name, target, kind: _kind, ...rest } = effect;
    rest satisfies Record<PropertyKey, never>;
    if (target === undefined) return name;
    switch (target.kind) {
    case 'all': return `${name}(*)`;
    case 'literal': return `${name}(${JSON.stringify(target.value)})`;
    default: { const exhaustive: never = target; throw new Error(String(exhaustive)); }
    }
  }
  default: { const exhaustive: never = effect; throw new Error(String(exhaustive)); }
  }
}

export function effectCovered({ effect, allowed }: { effect: Effect, allowed: Iterable<Effect> }): boolean {
  const key = printEffect({ effect });
  for (const candidate of allowed) {
    if (printEffect({ effect: candidate }) === key) return true;
    if (effect.kind === 'operation' && candidate.kind === 'operation'
      && effect.name === candidate.name && effect.target !== undefined && candidate.target?.kind === 'all') return true;
  }
  return false;
}

export function effectsContained({ source, target }: { source: Iterable<Effect>, target: readonly Effect[] }): boolean {
  for (const effect of source) if (!effectCovered({ effect, allowed: target })) return false;
  return true;
}

export function mergeEffects({ groups }: { groups: Iterable<Iterable<Effect>> }): Effect[] {
  const values = new Map<string, Effect>();
  for (const group of groups) for (const effect of group) values.set(printEffect({ effect }), effect);
  return [...values.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, value]) => value);
}

export function operationEffect({ name }: { name: string }): Effect {
  return { kind: 'operation', name, target: { kind: 'all' } };
}
