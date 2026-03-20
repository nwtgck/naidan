import type { JsonValue, JqBuiltinName } from './ast';
import type { JqRuntimeError, JqRuntimeFilterEvaluator } from './runtime';

function truthy({
  value,
}: {
  value: JsonValue;
}): boolean {
  return value !== false && value !== null;
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
  case 'empty':
    if (args.length !== 0) {
      return { ok: false, error: { message: 'empty does not take arguments' } };
    }
    return { ok: true, outputs: [] };
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
  default: {
    const _ex: never = name;
    throw new Error(`Unhandled jq builtin: ${_ex}`);
  }
  }
}
