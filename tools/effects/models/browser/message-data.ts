import { isRecordValue } from '../../analysis/value-guards.ts';
import type { Value } from '../../analysis/values.ts';

/**
 * Structured serialization is not Promise settlement: it does not invoke then.
 * It does read enumerable own properties, however. A structural interface or a
 * string index signature cannot prove that hidden getters/functions are absent.
 * Keep this guard stricter than generic native argument conversion. Arrays,
 * transferables and cyclic/recursive shapes need their own provenance model.
 */
export function passiveMessageData({ value, seen }: { value: Value, seen: Set<Value> }): boolean {
  if (seen.has(value)) return false;
  const next = new Set(seen).add(value);
  switch (value.kind) {
  case 'scalar': return true;
  case 'native': return value.name === 'Blob' || value.name === 'File';
  case 'record': {
    const actual = isRecordValue(value.reflected) ? value.reflected : value;
    return actual.shape === 'closed' && actual.indexValue === undefined
      && [...actual.fields.values()].every(field => passiveMessageData({ value: field.value, seen: next }));
  }
  case 'choice': return value.values.length > 0 && value.values.every(item => passiveMessageData({ value: item, seen: next }));
  case 'function': case 'promise': case 'unknown': return false;
  default: { const exhaustive: never = value; throw new Error(String(exhaustive)); }
  }
}
