import { commonStringEvidence } from './source-evidence.ts';
import type { Field, Value } from './values.ts';
import { isScalarValue } from './value-guards.ts';

function alternatives({ value }: { value: Value }): readonly Value[] {
  switch (value.kind) {
  case 'choice': return value.values.flatMap(item => alternatives({ value: item }));
  case 'function': case 'native': case 'promise': case 'record': case 'scalar': case 'unknown': return [value];
  default: { const exhaustive: never = value; throw new Error(String(exhaustive)); }
  }
}

/** Preserve finite string keys without treating scalar branches as object alternatives. */
export function choiceValue({ values }: { values: readonly Value[] }): Value {
  const flattened = values.flatMap(value => alternatives({ value }));
  if (flattened.length === 1) return flattened[0]!;
  if (flattened.length > 0 && flattened.every(isScalarValue)) {
    const first = flattened[0]!;
    return {
      kind: 'scalar',
      ...(commonStringEvidence({ values: flattened }) === undefined ? {} : { stringEvidence: commonStringEvidence({ values: flattened })! }),
      keys: flattened.every(value => value.keys !== undefined) ? [...new Set(flattened.flatMap(value => value.keys ?? []))] : undefined,
      truthiness: flattened.every(value => value.truthiness === first.truthiness) ? first.truthiness : 'unknown',
    };
  }
  return { kind: 'choice', values: flattened };
}

/** Only value alternatives are narrowed. Both expressions are still effect-checked. */
export function logicalValue({ left, right, operator }: { left: Value, right: Value, operator: 'and' | 'or' }): Value {
  const values: Value[] = [];
  for (const item of alternatives({ value: left })) {
    const truthiness = (() => {
      switch (item.kind) {
      case 'scalar': return item.truthiness;
      case 'unknown': case 'native': return 'unknown';
      case 'function': case 'promise': case 'record': case 'choice': return 'truthy';
      default: { const exhaustive: never = item; throw new Error(String(exhaustive)); }
      }
    })();
    const leftBranch = (() => {
      switch (operator) {
      case 'and': return 'falsy';
      case 'or': return 'truthy';
      default: { const exhaustive: never = operator; throw new Error(String(exhaustive)); }
      }
    })();
    if (truthiness === leftBranch || truthiness === 'unknown') {
      values.push(isScalarValue(item) ? { ...item, truthiness: leftBranch } : item);
    }
    if (truthiness !== leftBranch) values.push(right);
  }
  return choiceValue({ values });
}

/** A conditional spread is closed only if every possible own-property source is closed. */
export function spreadRecords({ value }: { value: Value }): Extract<Value, { kind: 'record' }> | undefined {
  const fields = new Map<string, Field>();
  for (const item of alternatives({ value })) {
    // Known falsy scalars have no enumerable own properties (including the empty string).
    if (item.kind === 'scalar' && item.truthiness === 'falsy') continue;
    const actual = item.kind === 'record' && item.reflected?.kind === 'record' ? item.reflected : item;
    if (actual.kind !== 'record' || actual.shape !== 'closed') return undefined;
    for (const [key, field] of actual.fields) {
      const previous = fields.get(key);
      fields.set(key, { access: 'writable', value: previous === undefined || previous.value === field.value ? field.value : { kind: 'choice', values: [previous.value, field.value] } });
    }
  }
  return { kind: 'record', fields, shape: 'closed', reflected: undefined, indexValue: undefined };
}
