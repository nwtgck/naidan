import type { JsonValue, JqBuiltinName } from './ast';
import { applyPathDeletion, extractJqPath } from './path';
import type { JqRuntimeError, JqRuntimeFilterEvaluator } from './runtime';

function truthy({
  value,
}: {
  value: JsonValue;
}): boolean {
  return value !== false && value !== null;
}

function compareJsonValues({
  left,
  right,
}: {
  left: JsonValue;
  right: JsonValue;
}): number {
  if (typeof left === 'number' && typeof right === 'number') {
    if (left === right) return 0;
    return left < right ? -1 : 1;
  }
  if (typeof left === 'string' && typeof right === 'string') {
    if (left === right) return 0;
    return left < right ? -1 : 1;
  }
  const leftJson = JSON.stringify(left);
  const rightJson = JSON.stringify(right);
  if (leftJson === rightJson) return 0;
  return leftJson < rightJson ? -1 : 1;
}

function containsJson({
  input,
  expected,
}: {
  input: JsonValue;
  expected: JsonValue;
}): boolean {
  if (typeof input === 'string' && typeof expected === 'string') {
    return input.includes(expected);
  }
  if (Array.isArray(input) && Array.isArray(expected)) {
    return expected.every((expectedItem) =>
      input.some((inputItem) => containsJson({ input: inputItem, expected: expectedItem })));
  }
  if (
    input !== null &&
    expected !== null &&
    typeof input === 'object' &&
    typeof expected === 'object' &&
    !Array.isArray(input) &&
    !Array.isArray(expected)
  ) {
    return Object.entries(expected).every(([key, value]) =>
      Object.hasOwn(input, key) && containsJson({ input: input[key]!, expected: value }));
  }
  return compareJsonValues({ left: input, right: expected }) === 0;
}

export function evaluateBuiltin({
  name,
  args,
  input,
  evaluate,
}: {
  name: JqBuiltinName;
  args: import('./ast').JqFilter[];
  input: JsonValue;
  evaluate: JqRuntimeFilterEvaluator;
}): { ok: true; outputs: JsonValue[] } | { ok: false; error: JqRuntimeError } {
  switch (name) {
  case 'all':
  case 'any': {
    if (!Array.isArray(input)) {
      return { ok: false, error: { message: `${name} input must be an array` } };
    }
    if (args.length > 1) {
      return { ok: false, error: { message: `${name} takes at most one argument` } };
    }

    const predicate = args[0];
    const evaluateItem = ({ item }: { item: JsonValue }): { ok: true; value: boolean } | { ok: false; error: JqRuntimeError } => {
      if (predicate === undefined) {
        return { ok: true, value: truthy({ value: item }) };
      }

      const result = evaluate({ filter: predicate, input: item });
      if (!result.ok) return result;
      return { ok: true, value: truthy({ value: result.outputs[0] ?? null }) };
    };

    const mode = name;
    switch (mode) {
    case 'any':
      for (const item of input) {
        const result = evaluateItem({ item });
        if (!result.ok) return result;
        if (result.value) {
          return { ok: true, outputs: [true] };
        }
      }
      return { ok: true, outputs: [false] };
    case 'all':
      for (const item of input) {
        const result = evaluateItem({ item });
        if (!result.ok) return result;
        if (!result.value) {
          return { ok: true, outputs: [false] };
        }
      }
      return { ok: true, outputs: [true] };
    default: {
      const _ex: never = mode;
      throw new Error(`Unhandled aggregate builtin: ${_ex}`);
    }
    }
  }
  case 'contains': {
    const expected = args[0];
    if (expected === undefined) {
      return { ok: false, error: { message: 'contains requires one argument' } };
    }
    if (args.length !== 1) {
      return { ok: false, error: { message: 'contains takes exactly one argument' } };
    }
    const evaluated = evaluate({ filter: expected, input });
    if (!evaluated.ok) return evaluated;
    return {
      ok: true,
      outputs: [containsJson({ input, expected: evaluated.outputs[0] ?? null })],
    };
  }
  case 'del': {
    const pathFilter = args[0];
    if (pathFilter === undefined) {
      return { ok: false, error: { message: 'del requires one argument' } };
    }
    if (args.length !== 1) {
      return { ok: false, error: { message: 'del takes exactly one argument' } };
    }

    const path = extractJqPath({ filter: pathFilter });
    if (path === undefined) {
      return { ok: false, error: { message: 'del argument must be a path' } };
    }

    const deleted = applyPathDeletion({
      root: input,
      path,
    });
    if (!deleted.ok) {
      return { ok: false, error: { message: deleted.message } };
    }
    return { ok: true, outputs: [deleted.value] };
  }
  case 'empty':
    if (args.length !== 0) {
      return { ok: false, error: { message: 'empty does not take arguments' } };
    }
    return { ok: true, outputs: [] };
  case 'fromjson':
    if (args.length !== 0) {
      return { ok: false, error: { message: 'fromjson does not take arguments' } };
    }
    if (typeof input !== 'string') {
      return { ok: false, error: { message: 'fromjson input must be a string' } };
    }
    try {
      return { ok: true, outputs: [JSON.parse(input) as JsonValue] };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, error: { message: `fromjson parse error: ${message}` } };
    }
  case 'select': {
    const condition = args[0];
    if (condition === undefined) {
      return { ok: false, error: { message: 'select requires one argument' } };
    }
    const outputs = evaluate({ filter: condition, input });
    if (!outputs.ok) return outputs;
    const selected = outputs.outputs[0];
    return {
      ok: true,
      outputs: selected !== undefined && truthy({ value: selected }) ? [input] : [],
    };
  }
  case 'map': {
    const mapper = args[0];
    if (mapper === undefined) {
      return { ok: false, error: { message: 'map requires one argument' } };
    }
    if (!Array.isArray(input)) {
      return { ok: false, error: { message: 'map input must be an array' } };
    }

    const result: JsonValue[] = [];
    for (const item of input) {
      const mapped = evaluate({ filter: mapper, input: item });
      if (!mapped.ok) return mapped;
      result.push(...mapped.outputs);
    }
    return { ok: true, outputs: [result] };
  }
  case 'length':
    if (args.length !== 0) {
      return { ok: false, error: { message: 'length does not take arguments' } };
    }
    switch (typeof input) {
    case 'string':
      return { ok: true, outputs: [input.length] };
    case 'number':
      return { ok: true, outputs: [Math.abs(input)] };
    case 'boolean':
      return { ok: false, error: { message: 'length is not defined for booleans' } };
    case 'object':
      if (input === null) return { ok: true, outputs: [0] };
      if (Array.isArray(input)) return { ok: true, outputs: [input.length] };
      return { ok: true, outputs: [Object.keys(input).length] };
    default: {
      const _ex: never = input;
      throw new Error(`Unhandled jq value: ${JSON.stringify(_ex)}`);
    }
    }
  case 'keys':
    if (args.length !== 0) {
      return { ok: false, error: { message: 'keys does not take arguments' } };
    }
    if (Array.isArray(input)) {
      return { ok: true, outputs: [input.map((_value, index) => index)] };
    }
    if (typeof input === 'object' && input !== null) {
      return { ok: true, outputs: [Object.keys(input).sort()] };
    }
    return { ok: false, error: { message: 'keys input must be an array or object' } };
  case 'keys_unsorted':
    if (args.length !== 0) {
      return { ok: false, error: { message: 'keys_unsorted does not take arguments' } };
    }
    if (Array.isArray(input)) {
      return { ok: true, outputs: [input.map((_value, index) => index)] };
    }
    if (typeof input === 'object' && input !== null) {
      return { ok: true, outputs: [Object.keys(input)] };
    }
    return { ok: false, error: { message: 'keys_unsorted input must be an array or object' } };
  case 'endswith': {
    const suffix = args[0];
    if (suffix === undefined) {
      return { ok: false, error: { message: 'endswith requires one argument' } };
    }
    if (args.length !== 1) {
      return { ok: false, error: { message: 'endswith takes exactly one argument' } };
    }
    const evaluated = evaluate({ filter: suffix, input });
    if (!evaluated.ok) return evaluated;
    const value = evaluated.outputs[0];
    if (typeof input !== 'string' || typeof value !== 'string') {
      return { ok: false, error: { message: 'endswith expects string input and argument' } };
    }
    return { ok: true, outputs: [input.endsWith(value)] };
  }
  case 'reverse':
    if (args.length !== 0) {
      return { ok: false, error: { message: 'reverse does not take arguments' } };
    }
    if (Array.isArray(input)) {
      return { ok: true, outputs: [[...input].reverse()] };
    }
    if (typeof input === 'string') {
      return { ok: true, outputs: [[...input].reverse().join('')] };
    }
    return { ok: false, error: { message: 'reverse input must be an array or string' } };
  case 'sort':
    if (args.length !== 0) {
      return { ok: false, error: { message: 'sort does not take arguments' } };
    }
    if (!Array.isArray(input)) {
      return { ok: false, error: { message: 'sort input must be an array' } };
    }
    return {
      ok: true,
      outputs: [[...input].sort((left, right) => compareJsonValues({ left, right }))],
    };
  case 'startswith': {
    const prefix = args[0];
    if (prefix === undefined) {
      return { ok: false, error: { message: 'startswith requires one argument' } };
    }
    if (args.length !== 1) {
      return { ok: false, error: { message: 'startswith takes exactly one argument' } };
    }
    const evaluated = evaluate({ filter: prefix, input });
    if (!evaluated.ok) return evaluated;
    const value = evaluated.outputs[0];
    if (typeof input !== 'string' || typeof value !== 'string') {
      return { ok: false, error: { message: 'startswith expects string input and argument' } };
    }
    return { ok: true, outputs: [input.startsWith(value)] };
  }
  case 'type':
    if (args.length !== 0) {
      return { ok: false, error: { message: 'type does not take arguments' } };
    }
    if (input === null) return { ok: true, outputs: ['null'] };
    if (Array.isArray(input)) return { ok: true, outputs: ['array'] };
    switch (typeof input) {
    case 'boolean':
      return { ok: true, outputs: ['boolean'] };
    case 'number':
      return { ok: true, outputs: ['number'] };
    case 'string':
      return { ok: true, outputs: ['string'] };
    case 'object':
      return { ok: true, outputs: ['object'] };
    default: {
      const _ex: never = input;
      throw new Error(`Unhandled jq value: ${JSON.stringify(_ex)}`);
    }
    }
  case 'has': {
    const arg = args[0];
    if (arg === undefined) {
      return { ok: false, error: { message: 'has requires one argument' } };
    }
    const evaluated = evaluate({ filter: arg, input });
    if (!evaluated.ok) return evaluated;
    const key = evaluated.outputs[0];
    if (key === undefined) {
      return { ok: true, outputs: [false] };
    }

    if (Array.isArray(input)) {
      return {
        ok: true,
        outputs: [typeof key === 'number' && Number.isInteger(key) && key >= 0 && key < input.length],
      };
    }
    if (typeof input === 'object' && input !== null) {
      return { ok: true, outputs: [typeof key === 'string' && Object.hasOwn(input, key)] };
    }
    return { ok: false, error: { message: 'has input must be an array or object' } };
  }
  case 'tojson':
    if (args.length !== 0) {
      return { ok: false, error: { message: 'tojson does not take arguments' } };
    }
    return { ok: true, outputs: [JSON.stringify(input)] };
  case 'values':
    if (args.length !== 0) {
      return { ok: false, error: { message: 'values does not take arguments' } };
    }
    return truthy({ value: input })
      ? { ok: true, outputs: [input] }
      : { ok: true, outputs: [] };
  case 'tostring':
    if (args.length !== 0) {
      return { ok: false, error: { message: 'tostring does not take arguments' } };
    }
    return typeof input === 'string'
      ? { ok: true, outputs: [input] }
      : { ok: true, outputs: [JSON.stringify(input)] };
  default: {
    const _ex: never = name;
    throw new Error(`Unhandled jq builtin: ${_ex}`);
  }
  }
}
