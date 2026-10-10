import type { Value, FunctionValue } from './values.ts';

export function isFunctionValue(value: Value | undefined): value is FunctionValue {
  return value?.kind === 'function';
}

export function isCallableValue(value: Value): value is FunctionValue | Extract<Value, { kind: 'native' }> {
  return value.kind === 'function' || value.kind === 'native';
}

export function isRecordValue(value: Value | undefined): value is Extract<Value, { kind: 'record' }> {
  return value?.kind === 'record';
}

export function isScalarValue(value: Value): value is Extract<Value, { kind: 'scalar' }> {
  return value.kind === 'scalar';
}

export function isNativeValue(value: Value): value is Extract<Value, { kind: 'native' }> {
  return value.kind === 'native';
}

export function isPromiseValue(value: Value): value is Extract<Value, { kind: 'promise' }> {
  return value.kind === 'promise';
}

/** Only evidence-backed own data shapes are safe for implicit native conversions. */
export function passiveData({ value, seen }: { value: Value, seen: Set<Value> }): boolean {
  if (seen.has(value)) return false;
  seen.add(value);
  switch (value.kind) {
  case 'scalar': return true;
  case 'native': return value.name === 'Array' && value.receiver !== undefined && passiveData({ value: value.receiver, seen });
  case 'record': {
    const actual = isRecordValue(value.reflected) ? value.reflected : value;
    if (actual.shape !== 'closed' && actual.indexValue?.kind !== 'scalar') return false;
    return [...actual.fields.values()].every(field => passiveData({ value: field.value, seen: new Set(seen) }));
  }
  case 'choice': return value.values.every(item => passiveData({ value: item, seen: new Set(seen) }));
  case 'function': case 'promise': case 'unknown': return false;
  default: { const exhaustive: never = value; throw new Error(String(exhaustive)); }
  }
}
