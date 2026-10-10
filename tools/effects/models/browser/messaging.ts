import { isScalarValue } from '../../analysis/value-guards.ts';
import ts from 'typescript';
import type { Value } from '../../analysis/values.ts';
import { SCALAR, UNKNOWN } from '../../analysis/values.ts';
import type { OperationInput, OperationRule } from '../operation.ts';
import { scalarArguments } from './guards.ts';
import { passiveMessageData } from './message-data.ts';

export const CROSS_ORIGIN_SEND = 'messaging.crossorigin.send';

function unwrap({ expression }: { expression: ts.Expression }): ts.Expression {
  let value = expression;
  while (ts.isParenthesizedExpression(value) || ts.isAsExpression(value) || ts.isTypeAssertionExpression(value)
    || ts.isNonNullExpression(value) || ts.isSatisfiesExpression(value)) value = value.expression;
  return value;
}

function argument({ input, index }: { input: OperationInput, index: number }): ts.Expression | undefined {
  return ts.isCallExpression(input.node) ? input.node.arguments[index] : undefined;
}

/** Only the value of void, not an identifier spelled undefined, proves a default. */
function isDefault({ expression }: { expression: ts.Expression | undefined }): boolean {
  if (expression === undefined) return true;
  const value = unwrap({ expression });
  return ts.isVoidExpression(value) || value.kind === ts.SyntaxKind.NullKeyword;
}

type Member = { kind: 'missing' } | { kind: 'unknown' } | { kind: 'value', expression: ts.Expression };

/** Last property wins. A later spread/computed key prevents a false default. */
function freshMember({ expression, key }: { expression: ts.Expression | undefined, key: string }): Member {
  if (expression === undefined) return { kind: 'unknown' };
  const value = unwrap({ expression });
  if (!ts.isObjectLiteralExpression(value)) return { kind: 'unknown' };
  for (let index = value.properties.length - 1; index >= 0; index--) {
    const property = value.properties[index]!;
    if (ts.isSpreadAssignment(property) || property.name === undefined || ts.isComputedPropertyName(property.name)) return { kind: 'unknown' };
    const name = ts.isIdentifier(property.name) || ts.isStringLiteralLike(property.name) ? property.name.text : undefined;
    if (name === undefined) return { kind: 'unknown' };
    if (name !== key) continue;
    return ts.isPropertyAssignment(property) ? { kind: 'value', expression: property.initializer } : { kind: 'unknown' };
  }
  return { kind: 'missing' };
}

function checkedDictionary({ value }: { value: Value | undefined }): Extract<Value, { kind: 'record' }> | undefined {
  const actual = value?.kind === 'record' && value.reflected?.kind === 'record' ? value.reflected : value;
  return actual?.kind === 'record' && actual.shape === 'closed' && actual.indexValue === undefined ? actual : undefined;
}

function literalOriginEffects({ values }: { values: readonly string[] }): readonly string[] {
  // Exact "/" is the browser-enforced same-origin restriction. No deployment
  // origin is inferred from an absolute URL, an opaque "null", or a target view.
  return values.length > 0 && values.every(value => value === '/') ? [] : [CROSS_ORIGIN_SEND];
}

function scalarOriginEffects({ value }: { value: Value | undefined }): readonly string[] {
  if (value?.kind === 'scalar' && value.stringEvidence?.kind === 'literal') return literalOriginEffects({ values: value.stringEvidence.values });
  return [CROSS_ORIGIN_SEND];
}

/** Policy only: the guards below still run when the selected effect set is empty. */
export function windowMessageEffects({ input }: { input: OperationInput }): readonly string[] {
  const raw = argument({ input, index: 1 });
  const options = input.args[1];
  if (input.args.length >= 3) return scalarOriginEffects({ value: options });
  if (isDefault({ expression: raw })) return [];
  if (options !== undefined && isScalarValue(options)) return scalarOriginEffects({ value: options });
  const dictionary = checkedDictionary({ value: options });
  if (dictionary === undefined) return [CROSS_ORIGIN_SEND];
  const member = freshMember({ expression: raw, key: 'targetOrigin' });
  switch (member.kind) {
  case 'missing': return [];
  case 'value': {
    if (isDefault({ expression: member.expression })) {
      // null is converted to the string "null" for this DOMString field;
      // only void means the default. The options dictionary itself accepts null.
      return ts.isVoidExpression(unwrap({ expression: member.expression })) ? [] : [CROSS_ORIGIN_SEND];
    }
    const expression = unwrap({ expression: member.expression });
    return ts.isStringLiteralLike(expression) ? literalOriginEffects({ values: [expression.text] }) : [CROSS_ORIGIN_SEND];
  }
  case 'unknown': return dictionary.fields.has('targetOrigin') ? [CROSS_ORIGIN_SEND] : [];
  default: { const exhaustive: never = member; throw new Error(String(exhaustive)); }
  }
}

function checkPayload({ input }: { input: OperationInput }): void {
  if (input.args.length === 0 || !passiveMessageData({ value: input.args[0] ?? UNKNOWN, seen: new Set() })) {
    input.context.issue({ node: input.node, code: 'unsupported', message: 'Message serialization requires checked scalar/closed data or Blob/File. Open shapes, arrays, getters, functions and transferables need a dedicated model.' });
  }
}

function emptyTransfer({ expression }: { expression: ts.Expression | undefined }): boolean {
  if (expression === undefined) return true;
  const value = unwrap({ expression });
  return ts.isVoidExpression(value) || ts.isArrayLiteralExpression(value) && value.elements.length === 0;
}

function checkWindowMessage({ input }: { input: OperationInput }): Value {
  checkPayload({ input });
  const raw = argument({ input, index: 1 });
  const options = input.args[1];
  const issue = ({ message }: { message: string }) => input.context.issue({ node: input.node, code: 'unsupported', message });
  if (!emptyTransfer({ expression: argument({ input, index: 2 }) })) issue({ message: 'Message transfer needs a separate endpoint/ownership model; only an explicit empty transfer list is supported.' });
  // Three arguments select the legacy DOMString overload even when argument
  // two is an object. A cast cannot stop its conversion hooks from running.
  if (input.args.length >= 3) {
    if (options === undefined || !isScalarValue(options)) issue({ message: 'Legacy targetOrigin conversion requires a primitive value, not an options dictionary or conversion hook.' });
    return SCALAR;
  }
  if (isDefault({ expression: raw })) return SCALAR;
  if (options !== undefined && isScalarValue(options)) return SCALAR;
  const dictionary = checkedDictionary({ value: options });
  if (dictionary === undefined) {
    issue({ message: 'Window message options require a checked closed dictionary or primitive targetOrigin; hidden accessors are not passive.' }); return SCALAR;
  }
  const target = dictionary.fields.get('targetOrigin')?.value;
  if (target !== undefined && target.kind !== 'scalar') issue({ message: 'targetOrigin conversion requires a primitive value, not an object with conversion hooks.' });
  if (dictionary.fields.has('transfer')) {
    const transfer = freshMember({ expression: raw, key: 'transfer' });
    if (transfer.kind !== 'value' || !emptyTransfer({ expression: transfer.expression })) {
      issue({ message: 'Message options transfer must be an explicit empty list or void; a mutable alias cannot prove an empty transfer list.' });
    }
  }
  return SCALAR;
}

/**
 * External information paths are the policy boundary, not every message event.
 * Same-origin transport is intentionally none, not an exemption for serialization,
 * argument evaluation, listeners, storage used for synchronization, or worker APIs.
 * Bare postMessage/self are deliberately not aliases of Window.postMessage: the
 * same source spelling is also a worker transport, even with DOM ambient types.
 */
export const MESSAGING_OPERATIONS: readonly OperationRule[] = [
  {
    id: 'window.message.send',
    definedIn: import.meta.url,
    access: 'call',
    targets: ['Window.postMessage'],
    policy: {
      kind: 'conditional',
      possibleEffects: [CROSS_ORIGIN_SEND],
      reason: 'Window delivery restricted to the incumbent origin by the default or exact "/" is internal. Wildcard, explicit absolute or unverified primitive targets may cross origins. Serialization and receiver identity are checked separately.',
      select: input => windowMessageEffects({ input }),
    },
    evaluate: input => checkWindowMessage({ input }),
  },
  {
    id: 'broadcast-channel.construct',
    definedIn: import.meta.url,
    access: 'construct',
    targets: ['BroadcastChannel'],
    policy: { kind: 'intentional-none', reason: 'BroadcastChannel is confined to its storage key and channel name. Creating this internal endpoint is not network or persistent content I/O.' },
    evaluate: input => {
      scalarArguments(input);
      return input.context.native({ name: 'BroadcastChannel', receiver: undefined });
    },
  },
  {
    id: 'broadcast-channel.send',
    definedIn: import.meta.url,
    access: 'call',
    targets: ['BroadcastChannel.postMessage'],
    policy: { kind: 'intentional-none', reason: 'Broadcast delivery within the same storage key is internal messaging. Serialization still runs; localStorage writes and explicit worker requests are not exempted.' },
    evaluate: input => {
      checkPayload({ input }); return SCALAR;
    },
  },
  {
    id: 'broadcast-channel.close',
    definedIn: import.meta.url,
    access: 'call',
    targets: ['BroadcastChannel.close'],
    policy: { kind: 'intentional-none', reason: 'Closing this browser-internal channel is not external communication. No listener is executed by this model.' },
    evaluate: () => SCALAR,
  },
  {
    id: 'broadcast-channel.name',
    definedIn: import.meta.url,
    access: 'read',
    targets: ['BroadcastChannel.name'],
    policy: { kind: 'intentional-none', reason: 'Reading the local channel name is not external information retrieval.' },
    evaluate: () => SCALAR,
  },
];
