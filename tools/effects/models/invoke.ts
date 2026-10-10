import ts from 'typescript';
import { evaluateBrowserOperation } from './browser/operations.ts';
import { scalarArguments as checkedScalarArguments } from './browser/guards.ts';
import type { OperationDecision } from './operation.ts';
import type { EffectsConfig } from '../config.ts';
import type { EffectDiagnostic } from '../diagnostics.ts';
import { type Effect } from '../contracts/effects.ts';
import { parseEffectRow } from '../syntax/expression.ts';
import type { ContractOwner, FunctionValue, Value } from '../analysis/values.ts';
import { SCALAR, UNKNOWN } from '../analysis/values.ts';
import { isCallableValue, isRecordValue, isScalarValue } from '../analysis/value-guards.ts';

export type NativeModelContext = {
  config: EffectsConfig,
  recordOperation: (input: Omit<OperationDecision, 'file' | 'start' | 'length' | 'owner'> & { owner: ContractOwner | undefined, node: ts.Node }) => void,
  observeVueCallback: (input: { callable: FunctionValue, node: ts.Node }) => void,
  registerWatcherCleanup: (input: { callback: FunctionValue, owner: ContractOwner | undefined, node: ts.Node }) => void,
  consumeWatcherCleanup: (input: { callback: FunctionValue, owner: ContractOwner | undefined, node: ts.Node }) => void,
  invokeDetached: (input: { callable: FunctionValue, args: readonly Value[], owner: ContractOwner | undefined, node: ts.Node }) => Value,
  addEffects: (input: { owner: ContractOwner | undefined, effects: readonly Effect[], node: ts.Node, reason: string }) => void,
  native: (input: { name: string, receiver: Value | undefined }) => Value,
  issue: (input: { node: ts.Node, code: EffectDiagnostic['code'], message: string }) => void,
  invoke: (input: { callable: Value, args: readonly Value[], owner: ContractOwner | undefined, node: ts.Node }) => Value,
  settle: (input: { value: Value, node: ts.Node }) => Value,
  compatible: (input: { source: Value, target: Value, node: ts.Node, mode: 'value' | 'shared' }) => void,
  replacementShape: (input: { source: Value, target: Value, node: ts.Node, depth: number }) => void,
};

function lockSignal({ value }: { value: Value }): boolean {
  switch (value.kind) {
  // Primitives are absent/undefined or fail Web IDL's interface brand check;
  // neither path invokes object coercion hooks or proves a valid signal.
  case 'scalar': return true;
  case 'native': return value.name === 'AbortSignal';
  case 'choice': return value.values.length > 0 && value.values.every(item => lockSignal({ value: item }));
  case 'record': case 'function': case 'promise': case 'unknown': return false;
  default: { const exhaustive: never = value; throw new Error(String(exhaustive)); }
  }
}

function initialReadableStreamPullPossible({ node }: { node: ts.Node }): boolean {
  const strategy = ts.isNewExpression(node) ? node.arguments?.[1] : undefined;
  if (strategy === undefined || !ts.isObjectLiteralExpression(strategy)) return true;
  let highWaterMark: ts.Expression | undefined;
  for (const property of strategy.properties) {
    if (!ts.isPropertyAssignment(property) || !ts.isIdentifier(property.name) && !ts.isStringLiteral(property.name)) return true;
    if (property.name.text === 'highWaterMark') highWaterMark = property.initializer;
  }
  return highWaterMark === undefined || !ts.isNumericLiteral(highWaterMark) || Number(highWaterMark.text) !== 0;
}

/** Models describe operations; the analyzer owns identity, scopes and contract propagation. */
export function evaluateNative({ context, callable, args, owner, node }: {
  context: NativeModelContext, callable: Extract<Value, { kind: 'native' }>, args: readonly Value[], owner: ContractOwner | undefined, node: ts.Node,
}): Value {
  const { name, receiver, kind: _kind, ...rest } = callable;
  rest satisfies Record<PropertyKey, never>;
  const promise = ({ value }: { value: Value }): Value => ({ kind: 'promise', value });
  const native = ({ value }: { value: string }) => context.native({ name: value, receiver: undefined });
  const scalarArguments = () => {
    if (args.some(argument => !isScalarValue(argument))) context.issue({ node, code: 'unsupported', message: `Implicit argument coercion is not verified for ${name}.` });
  };
  if (name.startsWith('model:')) {
    const model = context.config.models.find(item => `model:${item.file}#${item.export}` === name);
    if (model === undefined) throw new Error('Missing selected external effect model.');
    context.addEffects({ owner, effects: parseEffectRow({ value: model.effects, definitions: context.config.definitions }), node, reason: `Reviewed external model: ${model.file}#${model.export}` });
    switch (model.returnValue) {
    case 'scalar-value':
      context.issue({ node, code: 'unsupported', message: 'A modeled scalar value is not callable.' }); return UNKNOWN;
    case 'scalar': return SCALAR;
    case 'promise-scalar': return promise({ value: SCALAR });
    default: { const exhaustive: never = model.returnValue; throw new Error(String(exhaustive)); }
    }
  }
  const browser = evaluateBrowserOperation({ context, callable, args, owner, node, access: ts.isNewExpression(node) ? 'construct' : 'call' });
  if (browser !== undefined) return browser;
  if (name === 'navigator.locks.request') {
    // Web IDL converts the name and options before granting a lock. Unchecked
    // conversion hooks must not disappear merely because the callback is modeled.
    // Source: https://w3c.github.io/web-locks/#api-lock-manager
    checkedScalarArguments({ context, callable, args: [args[0] ?? UNKNOWN], node });
    if (args.length >= 3) {
      const options = args[1] ?? UNKNOWN;
      const actual = isRecordValue(options) && isRecordValue(options.reflected) ? options.reflected : options;
      // A dictionary reads only these known fields. Unused data fields need not
      // be serializable, and an AbortSignal is not generic passive message data.
      // Source: https://webidl.spec.whatwg.org/#es-dictionary
      if (isRecordValue(actual) && actual.shape === 'closed' && actual.indexValue === undefined) {
        checkedScalarArguments({
          context,
          callable,
          args: ['mode', 'ifAvailable', 'steal'].flatMap(key => {
            const value = actual.fields.get(key)?.value;
            return value === undefined ? [] : [value];
          }),
          node,
        });
        const signal = actual.fields.get('signal')?.value;
        if (signal !== undefined && !lockSignal({ value: signal })) {
          context.issue({ node, code: 'unsupported', message: 'Lock options signal needs checked native AbortSignal identity; casts and unknown objects are not evidence.' });
        }
      } else if (!isScalarValue(actual)) {
        context.issue({ node, code: 'unsupported', message: 'Lock options need a checked closed dictionary; hidden field getters require a dedicated model.' });
      }
    }
    // Extra arguments are evaluated by the analyzer but ignored by Web IDL.
    const callback = args[args.length >= 3 ? 2 : 1];
    if (callback === undefined) {
      context.issue({ node, code: 'unsupported', message: 'Missing lock callback.' }); return UNKNOWN;
    }
    const result = context.invoke({ callable: callback, args: [UNKNOWN], owner, node });
    return promise({ value: context.settle({ value: result, node }) });
  }
  if (name === 'ReadableStream' && ts.isNewExpression(node)) {
    // This partial slice exposes startup callbacks without claiming a complete
    // stream/controller/strategy/consumer contract. Cancellation is not startup.
    context.issue({ node, code: 'unsupported', message: 'ReadableStream startup callbacks are analyzed; controllers, strategy conversion, consumption and cancellation still require an explicit effect model.' });
    const source = args[0];
    const actual = isRecordValue(source) && isRecordValue(source.reflected) ? source.reflected : source;
    if (isRecordValue(actual) && actual.shape === 'closed' && actual.indexValue === undefined) {
      for (const key of ['start', 'pull'] as const) {
        if (key === 'pull' && !initialReadableStreamPullPossible({ node })) continue;
        const callback = actual.fields.get(key)?.value;
        if (callback === undefined || isScalarValue(callback)) continue;
        const result = context.invoke({ callable: callback, args: [UNKNOWN], owner, node });
        context.settle({ value: result, node });
      }
    }
    return UNKNOWN;
  }
  if (name === 'Promise' && ts.isNewExpression(node)) {
    const executor = args[0] ?? UNKNOWN;
    // The executor runs synchronously; its return value is ignored. Its body
    // (including callbacks that it starts) still contributes to the caller row.
    context.invoke({ callable: executor, args: [], owner, node });
    switch (executor.kind) {
    case 'function': {
      if (executor.parameters.length === 0) return promise({ value: SCALAR });
      const resolve = executor.parameters[0];
      if (resolve?.kind === 'native' && resolve.name === 'Promise.executor.resolve') return promise({ value: resolve.receiver ?? UNKNOWN });
      break;
    }
    case 'native': case 'choice': case 'record': case 'promise': case 'scalar': case 'unknown': break;
    default: { const exhaustive: never = executor; throw new Error(String(exhaustive)); }
    }
    context.issue({ node, code: 'unsupported', message: 'Promise construction needs a direct inline executor with checked resolve/reject callbacks.' });
    return promise({ value: UNKNOWN });
  }
  if (name === 'Promise.executor.resolve') {
    // Resolving assimilates thenables. Reuse the checked settlement boundary;
    // a custom or hidden then member must not become an implicitly pure call.
    const settled = context.settle({ value: args[0] ?? SCALAR, node });
    context.compatible({ source: settled, target: receiver ?? UNKNOWN, node, mode: 'value' });
    return SCALAR;
  }
  if (name === 'Promise.executor.reject') return SCALAR;
  if (name === 'Promise.resolve') return promise({ value: context.settle({ value: args[0] ?? SCALAR, node }) });
  if (name === 'Promise.reject') return promise({ value: SCALAR });
  if (['Promise.then', 'Promise.catch', 'Promise.finally'].includes(name) && receiver?.kind === 'promise') {
    const outcomes: Value[] = [];
    for (const callback of args) {
      if (isCallableValue(callback)) outcomes.push(context.settle({ value: context.invoke({ callable: callback, args: [receiver.value], owner, node }), node }));
      else if (!isScalarValue(callback)) context.issue({ node, code: 'unsupported', message: 'Unresolved Promise callback.' });
    }
    if (name === 'Promise.finally') return promise({ value: receiver.value });
    if (name === 'Promise.catch' || args[0] === undefined || !isCallableValue(args[0])) outcomes.push(receiver.value);
    const result = outcomes.length === 1 ? outcomes[0]! : { kind: 'choice' as const, values: outcomes };
    return promise({ value: result });
  }
  if (['setTimeout', 'setInterval', 'queueMicrotask', 'requestAnimationFrame'].includes(name)) {
    if (args[0] !== undefined) context.invoke({ callable: args[0], args: [], owner, node });
    return SCALAR;
  }
  if (['clearTimeout', 'clearInterval', 'cancelAnimationFrame'].includes(name)) return SCALAR;
  if (name === 'Object.assign') {
    const target = args[0];
    if (!isRecordValue(target)) {
      context.issue({ node, code: 'unsupported', message: 'Object.assign requires checked destination slots.' }); return UNKNOWN;
    }
    for (const source of args.slice(1)) {
      const reflected = source.kind === 'record' && source.reflected?.kind === 'record' ? source.reflected : source;
      if (reflected.kind !== 'record' || reflected.shape !== 'closed') {
        context.issue({ node, code: 'unsupported', message: 'Object.assign requires a complete own-property source shape.' }); continue;
      }
      for (const [key, field] of reflected.fields) {
        const destination = target.fields.get(key);
        if (destination === undefined || destination.access !== 'writable') context.issue({ node, code: 'unsupported', message: `No writable Object.assign slot for ${key}.` });
        else {
          context.replacementShape({ source: field.value, target: destination.value, node, depth: 0 });
          context.compatible({ source: field.value, target: destination.value, node, mode: 'shared' });
        }
      }
    }
    return target;
  }
  if (name.startsWith('console.')) return SCALAR;
  if (name.startsWith('Math.')) {
    scalarArguments(); return SCALAR;
  }
  if (['String', 'Number', 'Boolean'].includes(name)) {
    if (args.some(argument => argument.kind !== 'scalar')) context.issue({ node, code: 'unsupported', message: 'Object coercion may execute user-defined hooks.' });
    return SCALAR;
  }
  if (['Error', 'TypeError', 'RangeError', 'DOMException'].includes(name)) {
    scalarArguments(); return native({ value: 'Error' });
  }
  if (['String.', 'Number.', 'Boolean.'].some(prefix => name.startsWith(prefix))) {
    for (const [index, argument] of args.entries()) {
      if ((name === 'String.replace' || name === 'String.replaceAll') && index === 1 && isCallableValue(argument)) context.invoke({ callable: argument, args: [SCALAR], owner, node });
      else if (!isScalarValue(argument)) context.issue({ node, code: 'unsupported', message: 'Native primitive conversion may invoke user code.' });
    }
    return SCALAR;
  }
  if (name.startsWith('Array.')) {
    const method = name.slice('Array.'.length);
    if (['map', 'flatMap', 'filter', 'forEach', 'some', 'every', 'find', 'findIndex', 'findLast', 'findLastIndex'].includes(method)) {
      if (args[0] !== undefined) context.invoke({ callable: args[0], args: [SCALAR, SCALAR, receiver ?? UNKNOWN], owner, node });
    } else if (args.some(argument => !isScalarValue(argument))) context.issue({ node, code: 'unsupported', message: 'Array mutation, coercion or comparison of effect-bearing values requires a model.' });
    return UNKNOWN;
  }
  if (name === 'AbortSignal.throwIfAborted') return SCALAR;
  context.issue({ node, code: 'unsupported', message: `No browser or JavaScript effect model for ${name}.` });
  return UNKNOWN;
}
