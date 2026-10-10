import type { StringEvidence } from './source-evidence.ts';
import type ts from 'typescript';
import type { EffectNode } from './solve.ts';
import type { Annotation } from '../syntax/annotations.ts';

export type ContractOwner = EffectNode & {
  anchor: ts.Node,
  annotation: Annotation | undefined,
  role: 'implementation' | 'slot' | 'signature' | 'symbolic' | 'module' | 'body',
  callbackPaths: ReadonlySet<string>,
};
export type FunctionValue = {
  kind: 'function',
  owner: ContractOwner,
  parameters: readonly Value[],
  returns: Value,
  declaration: ts.SignatureDeclaration | undefined,
  transport: 'local' | 'worker',
};
export type Field = { value: Value, access: 'writable' | 'readonly' };
export type Value =
  | { kind: 'unknown', reason: string }
  | { kind: 'scalar', keys: readonly string[] | undefined, truthiness: 'unknown' | 'truthy' | 'falsy', stringEvidence?: StringEvidence }
  | FunctionValue
  | { kind: 'record', fields: ReadonlyMap<string, Field>, shape: 'closed' | 'open', reflected: Value | undefined, indexValue: Value | undefined }
  | { kind: 'promise', value: Value }
  | { kind: 'native', name: string, receiver: Value | undefined }
  | { kind: 'choice', values: readonly Value[] };

export const SCALAR: Value = { kind: 'scalar', keys: undefined, truthiness: 'unknown' };
export const UNKNOWN: Value = { kind: 'unknown', reason: 'The value has no checked effect contract.' };

export function containsContract({ value, seen }: { value: Value, seen: Set<Value> }): boolean {
  if (seen.has(value)) return true;
  seen.add(value);
  switch (value.kind) {
  case 'scalar': return false;
  case 'function': case 'unknown': return true;
  case 'native': return value.name === 'Array' && value.receiver !== undefined ? containsContract({ value: value.receiver, seen }) : true;
  case 'promise': return containsContract({ value: value.value, seen });
  case 'record': return [...value.fields.values()].some(field => containsContract({ value: field.value, seen: new Set(seen) }));
  case 'choice': return value.values.some(item => containsContract({ value: item, seen: new Set(seen) }));
  default: { const exhaustive: never = value; throw new Error(String(exhaustive)); }
  }
}
