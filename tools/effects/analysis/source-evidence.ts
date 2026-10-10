import { FRESH_IMAGE } from '../models/browser/dom.ts';
import type { Value } from './values.ts';

/** Facts about an evaluated immutable string, never a TypeScript assertion. */
export type StringEvidence =
  | { kind: 'literal', values: readonly string[] }
  | { kind: 'object-url' };

export function commonStringEvidence({ values }: { values: readonly Extract<Value, { kind: 'scalar' }>[] }): StringEvidence | undefined {
  if (values.length === 0 || values.some(value => value.stringEvidence === undefined)) return undefined;
  const facts = values.map(value => value.stringEvidence!);
  if (facts.every(fact => fact.kind === 'object-url')) return { kind: 'object-url' };
  if (facts.every(fact => fact.kind === 'literal')) return { kind: 'literal', values: [...new Set(facts.flatMap(fact => fact.values))] };
  // Do not turn a mix of an object URL and an unknown protocol into local evidence.
  return undefined;
}

/** Mutable storage retains its contract, not its first URL or image-candidate state. */
export function withoutSourceEvidence({ value }: { value: Value }): Value {
  switch (value.kind) {
  case 'scalar': {
    const { stringEvidence: _stringEvidence, ...rest } = value;
    return rest;
  }
  case 'choice': return { kind: 'choice', values: value.values.map(item => withoutSourceEvidence({ value: item })) };
  case 'record': return {
    ...value,
    fields: new Map([...value.fields].map(([key, field]) => [key, { ...field, value: withoutSourceEvidence({ value: field.value }) }])),
    reflected: value.reflected === undefined ? undefined : withoutSourceEvidence({ value: value.reflected }),
    indexValue: value.indexValue === undefined ? undefined : withoutSourceEvidence({ value: value.indexValue }),
  };
  case 'native': return value.name === FRESH_IMAGE ? { kind: 'native', name: 'HTMLImageElement', receiver: undefined } : value;
  case 'function': case 'promise': case 'unknown': return value;
  default: { const exhaustive: never = value; throw new Error(String(exhaustive)); }
  }
}
