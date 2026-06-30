import type { JsonValue, JqBinaryOperator, JqFilter } from './ast';
import { evaluateBuiltin } from './builtins';
import { applyPathDeletion, applyPathUpdate, normalizeArrayIndex } from './path';
import {
  compareJsonValues,
  createJsonObject,
  defineJsonProperty,
  isJsonObject,
  jsonValuesEqual,
  mergeJsonObjects,
  stringifyJson,
} from './value';

export interface JqRuntimeError {
  message: string,
  value?: JsonValue,
}

interface JqRuntimeContext {
  variables: Readonly<Record<string, JsonValue>>,
  depth: number,
  state: {
    steps: number,
  },
  limits: {
    maxDepth: number,
    maxSteps: number,
    maxOutputs: number,
  },
}

export type JqRuntimeFilterEvaluator = ({ filter, input }: {
  filter: JqFilter,
  input: JsonValue,
}) => { ok: true, outputs: JsonValue[] } | { ok: false, error: JqRuntimeError };

function runtimeError({
  message,
  value,
}: {
  message: string,
  value: JsonValue | undefined,
}): { ok: false, error: JqRuntimeError } {
  return {
    ok: false,
    error: {
      message,
      value: value ?? message,
    },
  };
}

function truthy({
  value,
}: {
  value: JsonValue,
}): boolean {
  return value !== false && value !== null;
}

function isAlternativeOperator({
  operator,
}: {
  operator: JqBinaryOperator,
}): boolean {
  switch (operator) {
  case 'alternative':
    return true;
  case 'pipe':
  case 'comma':
  case 'or':
  case 'and':
  case 'eq':
  case 'ne':
  case 'lt':
  case 'le':
  case 'gt':
  case 'ge':
  case 'add':
  case 'sub':
  case 'mul':
  case 'div':
  case 'mod':
    return false;
  default: {
    const _ex: never = operator;
    throw new Error(`Unhandled jq binary operator: ${_ex}`);
  }
  }
}

function normalizeSliceBound({
  length,
  bound,
  fallback,
}: {
  length: number,
  bound: number | undefined,
  fallback: 0 | 'length',
}): number {
  const raw = bound ?? (fallback === 'length' ? length : 0);
  const normalized = raw < 0 ? length + raw : raw;
  return Math.min(Math.max(normalized, 0), length);
}

function stringifyInterpolationValue({
  value,
}: {
  value: JsonValue,
}): string {
  return typeof value === 'string'
    ? value
    : stringifyJson({
      value,
      indentation: undefined,
      sortKeys: false,
      asciiOnly: false,
    });
}

function recursiveMerge({
  left,
  right,
}: {
  left: { [key: string]: JsonValue },
  right: { [key: string]: JsonValue },
}): { [key: string]: JsonValue } {
  const merged = mergeJsonObjects({ left, right });
  for (const [key, rightValue] of Object.entries(right)) {
    const leftValue = left[key];
    if (leftValue !== undefined && isJsonObject(leftValue) && isJsonObject(rightValue)) {
      defineJsonProperty({
        object: merged,
        key,
        value: recursiveMerge({ left: leftValue, right: rightValue }),
      });
    }
  }
  return merged;
}

function evaluateBinaryPair({
  operator,
  left,
  right,
}: {
  operator: JqBinaryOperator,
  left: JsonValue,
  right: JsonValue,
}): { ok: true, value: JsonValue } | { ok: false, error: JqRuntimeError } {
  switch (operator) {
  case 'pipe':
  case 'comma':
  case 'alternative':
    return runtimeError({ message: `unexpected operator ${operator}`, value: undefined });
  case 'or':
    return { ok: true, value: truthy({ value: left }) || truthy({ value: right }) };
  case 'and':
    return { ok: true, value: truthy({ value: left }) && truthy({ value: right }) };
  case 'eq':
    return { ok: true, value: jsonValuesEqual({ left, right }) };
  case 'ne':
    return { ok: true, value: !jsonValuesEqual({ left, right }) };
  case 'lt':
    return { ok: true, value: compareJsonValues({ left, right }) < 0 };
  case 'le':
    return { ok: true, value: compareJsonValues({ left, right }) <= 0 };
  case 'gt':
    return { ok: true, value: compareJsonValues({ left, right }) > 0 };
  case 'ge':
    return { ok: true, value: compareJsonValues({ left, right }) >= 0 };
  case 'add': {
    if (left === null) return { ok: true, value: right };
    if (right === null) return { ok: true, value: left };
    if (typeof left === 'number' && typeof right === 'number') {
      return { ok: true, value: left + right };
    }
    if (typeof left === 'string' && typeof right === 'string') {
      return { ok: true, value: `${left}${right}` };
    }
    if (Array.isArray(left) && Array.isArray(right)) {
      return { ok: true, value: [...left, ...right] };
    }
    if (isJsonObject(left) && isJsonObject(right)) {
      return { ok: true, value: mergeJsonObjects({ left, right }) };
    }
    return runtimeError({ message: 'unsupported operands for +', value: undefined });
  }
  case 'sub': {
    if (typeof left === 'number' && typeof right === 'number') {
      return { ok: true, value: left - right };
    }
    if (Array.isArray(left) && Array.isArray(right)) {
      return {
        ok: true,
        value: left.filter((item) => !right.some((excluded) => jsonValuesEqual({ left: item, right: excluded }))),
      };
    }
    return runtimeError({ message: 'unsupported operands for -', value: undefined });
  }
  case 'mul': {
    if (typeof left === 'number' && typeof right === 'number') {
      return { ok: true, value: left * right };
    }
    if (typeof left === 'string' && typeof right === 'number' && Number.isInteger(right) && right >= 0) {
      return { ok: true, value: left.repeat(right) };
    }
    if (typeof right === 'string' && typeof left === 'number' && Number.isInteger(left) && left >= 0) {
      return { ok: true, value: right.repeat(left) };
    }
    if (isJsonObject(left) && isJsonObject(right)) {
      return { ok: true, value: recursiveMerge({ left, right }) };
    }
    return runtimeError({ message: 'unsupported operands for *', value: undefined });
  }
  case 'div': {
    if (typeof left === 'number' && typeof right === 'number') {
      if (right === 0) return runtimeError({ message: 'number divided by zero', value: undefined });
      return { ok: true, value: left / right };
    }
    if (typeof left === 'string' && typeof right === 'string') {
      return { ok: true, value: left.split(right) };
    }
    return runtimeError({ message: 'unsupported operands for /', value: undefined });
  }
  case 'mod':
    if (typeof left === 'number' && typeof right === 'number') {
      if (right === 0) return runtimeError({ message: 'number modulo zero', value: undefined });
      return { ok: true, value: left % right };
    }
    return runtimeError({ message: 'unsupported operands for %', value: undefined });
  default: {
    const _ex: never = operator;
    throw new Error(`Unhandled binary operator: ${_ex}`);
  }
  }
}

function checkLimits({
  context,
}: {
  context: JqRuntimeContext,
}): { ok: true } | { ok: false, error: JqRuntimeError } {
  context.state.steps += 1;
  if (context.depth > context.limits.maxDepth) {
    return runtimeError({ message: 'maximum jq evaluation depth exceeded', value: undefined });
  }
  if (context.state.steps > context.limits.maxSteps) {
    return runtimeError({ message: 'maximum jq evaluation step count exceeded', value: undefined });
  }
  return { ok: true };
}

function checkOutputLimit({
  outputs,
  context,
}: {
  outputs: JsonValue[],
  context: JqRuntimeContext,
}): { ok: true, outputs: JsonValue[] } | { ok: false, error: JqRuntimeError } {
  if (outputs.length > context.limits.maxOutputs) {
    return runtimeError({ message: 'maximum jq output count exceeded', value: undefined });
  }
  return { ok: true, outputs };
}

export function evaluateJqFilter({
  filter,
  input,
  variables,
}: {
  filter: JqFilter,
  input: JsonValue,
  variables?: Readonly<Record<string, JsonValue>>,
}): { ok: true, outputs: JsonValue[] } | { ok: false, error: JqRuntimeError } {
  return evaluateJqFilterWithContext({
    filter,
    input,
    context: {
      variables: variables ?? {},
      depth: 0,
      state: { steps: 0 },
      limits: {
        maxDepth: 512,
        maxSteps: 5_000_000,
        maxOutputs: 1_000_000,
      },
    },
  });
}

function evaluateJqFilterWithContext({
  filter,
  input,
  context,
}: {
  filter: JqFilter,
  input: JsonValue,
  context: JqRuntimeContext,
}): { ok: true, outputs: JsonValue[] } | { ok: false, error: JqRuntimeError } {
  const limit = checkLimits({ context });
  if (!limit.ok) return limit;

  const nestedContext: JqRuntimeContext = {
    ...context,
    depth: context.depth + 1,
  };
  const evaluate: JqRuntimeFilterEvaluator = ({ filter: nestedFilter, input: nestedInput }) =>
    evaluateJqFilterWithContext({ filter: nestedFilter, input: nestedInput, context: nestedContext });

  let result: { ok: true, outputs: JsonValue[] } | { ok: false, error: JqRuntimeError };

  switch (filter.kind) {
  case 'identity':
    result = { ok: true, outputs: [input] };
    break;
  case 'variable': {
    const value = context.variables[filter.name];
    result = value === undefined
      ? runtimeError({ message: `$${filter.name} is not defined`, value: undefined })
      : { ok: true, outputs: [value] };
    break;
  }
  case 'literal':
    result = { ok: true, outputs: [filter.value] };
    break;
  case 'string': {
    let values = [''];
    for (const part of filter.parts) {
      switch (part.kind) {
      case 'text':
        values = values.map((value) => `${value}${part.value}`);
        break;
      case 'interpolation': {
        const interpolated = evaluate({ filter: part.filter, input });
        if (!interpolated.ok) return interpolated;
        const next: string[] = [];
        for (const prefix of values) {
          for (const value of interpolated.outputs) {
            next.push(`${prefix}${stringifyInterpolationValue({ value })}`);
          }
        }
        values = next;
        break;
      }
      default: {
        const _ex: never = part;
        throw new Error(`Unhandled string part: ${JSON.stringify(_ex)}`);
      }
      }
    }
    result = { ok: true, outputs: values };
    break;
  }
  case 'field': {
    const parent = evaluate({ filter: filter.input, input });
    if (!parent.ok) return parent;
    const outputs: JsonValue[] = [];
    for (const value of parent.outputs) {
      if (value === null) {
        outputs.push(null);
      } else if (isJsonObject(value)) {
        outputs.push(Object.hasOwn(value, filter.key) ? value[filter.key]! : null);
      } else if (!filter.optional) {
        return runtimeError({ message: `cannot access field '${filter.key}' on non-object`, value: undefined });
      }
    }
    result = { ok: true, outputs };
    break;
  }
  case 'index': {
    const parent = evaluate({ filter: filter.input, input });
    if (!parent.ok) return parent;
    const outputs: JsonValue[] = [];
    for (const value of parent.outputs) {
      if (value === null) {
        outputs.push(null);
      } else if (Array.isArray(value)) {
        const normalizedIndex = normalizeArrayIndex({ array: value, index: filter.index });
        outputs.push(normalizedIndex === undefined ? null : value[normalizedIndex]!);
      } else if (!filter.optional) {
        return runtimeError({ message: `cannot index [${filter.index}] on non-array`, value: undefined });
      }
    }
    result = { ok: true, outputs };
    break;
  }
  case 'dynamic_index': {
    const parents = evaluate({ filter: filter.input, input });
    if (!parents.ok) return parents;
    const indexes = evaluate({ filter: filter.index, input });
    if (!indexes.ok) return indexes;
    const outputs: JsonValue[] = [];

    for (const parent of parents.outputs) {
      for (const index of indexes.outputs) {
        if (parent === null) {
          outputs.push(null);
        } else if (Array.isArray(parent) && typeof index === 'number' && Number.isInteger(index)) {
          const normalized = normalizeArrayIndex({ array: parent, index });
          outputs.push(normalized === undefined ? null : parent[normalized]!);
        } else if (isJsonObject(parent) && typeof index === 'string') {
          outputs.push(Object.hasOwn(parent, index) ? parent[index]! : null);
        } else if (!filter.optional) {
          return runtimeError({ message: 'cannot index value with the provided index', value: undefined });
        }
      }
    }
    result = { ok: true, outputs };
    break;
  }
  case 'slice': {
    const parents = evaluate({ filter: filter.input, input });
    if (!parents.ok) return parents;
    const starts = filter.start === undefined
      ? { ok: true as const, outputs: [null] as JsonValue[] }
      : evaluate({ filter: filter.start, input });
    if (!starts.ok) return starts;
    const ends = filter.end === undefined
      ? { ok: true as const, outputs: [null] as JsonValue[] }
      : evaluate({ filter: filter.end, input });
    if (!ends.ok) return ends;
    const outputs: JsonValue[] = [];

    for (const parent of parents.outputs) {
      for (const startValue of starts.outputs) {
        for (const endValue of ends.outputs) {
          const start = startValue === null ? undefined : startValue;
          const end = endValue === null ? undefined : endValue;
          if ((start !== undefined && typeof start !== 'number') || (end !== undefined && typeof end !== 'number')) {
            if (filter.optional) continue;
            return runtimeError({ message: 'slice bounds must be numbers or null', value: undefined });
          }
          if (Array.isArray(parent) || typeof parent === 'string') {
            const normalizedStart = normalizeSliceBound({ length: parent.length, bound: start, fallback: 0 });
            const normalizedEnd = normalizeSliceBound({ length: parent.length, bound: end, fallback: 'length' });
            outputs.push(parent.slice(normalizedStart, normalizedEnd) as JsonValue);
          } else if (parent === null) {
            outputs.push(null);
          } else if (!filter.optional) {
            return runtimeError({ message: 'cannot slice non-array/string', value: undefined });
          }
        }
      }
    }
    result = { ok: true, outputs };
    break;
  }
  case 'iterate': {
    const parent = evaluate({ filter: filter.input, input });
    if (!parent.ok) return parent;
    const outputs: JsonValue[] = [];
    for (const value of parent.outputs) {
      if (Array.isArray(value)) {
        outputs.push(...value);
      } else if (isJsonObject(value)) {
        outputs.push(...Object.values(value));
      } else if (!filter.optional) {
        return runtimeError({ message: 'cannot iterate over non-array/object', value: undefined });
      }
    }
    result = { ok: true, outputs };
    break;
  }
  case 'recursive_descent': {
    const roots = evaluate({ filter: filter.input, input });
    if (!roots.ok) return roots;
    const outputs: JsonValue[] = [];
    const stack = [...roots.outputs].reverse();
    while (stack.length > 0) {
      const value = stack.pop()!;
      outputs.push(value);
      if (Array.isArray(value)) {
        for (let index = value.length - 1; index >= 0; index -= 1) stack.push(value[index]!);
      } else if (isJsonObject(value)) {
        const children = Object.values(value);
        for (let index = children.length - 1; index >= 0; index -= 1) stack.push(children[index]!);
      }
      if (outputs.length > context.limits.maxOutputs) {
        return runtimeError({ message: 'maximum jq output count exceeded', value: undefined });
      }
    }
    result = { ok: true, outputs };
    break;
  }
  case 'optional': {
    const attempted = evaluate({ filter: filter.body, input });
    result = attempted.ok ? attempted : { ok: true, outputs: [] };
    break;
  }
  case 'pipe': {
    const left = evaluate({ filter: filter.left, input });
    if (!left.ok) return left;
    const outputs: JsonValue[] = [];
    for (const value of left.outputs) {
      const right = evaluate({ filter: filter.right, input: value });
      if (!right.ok) return right;
      outputs.push(...right.outputs);
    }
    result = { ok: true, outputs };
    break;
  }
  case 'comma': {
    const left = evaluate({ filter: filter.left, input });
    if (!left.ok) return left;
    const right = evaluate({ filter: filter.right, input });
    if (!right.ok) return right;
    result = { ok: true, outputs: [...left.outputs, ...right.outputs] };
    break;
  }
  case 'conditional': {
    const conditions = evaluate({ filter: filter.condition, input });
    if (!conditions.ok) return conditions;
    const outputs: JsonValue[] = [];
    for (const condition of conditions.outputs) {
      const branch = evaluate({
        filter: truthy({ value: condition }) ? filter.thenBranch : filter.elseBranch,
        input,
      });
      if (!branch.ok) return branch;
      outputs.push(...branch.outputs);
    }
    result = { ok: true, outputs };
    break;
  }
  case 'trycatch': {
    const attempted = evaluate({ filter: filter.body, input });
    result = attempted.ok
      ? attempted
      : evaluate({ filter: filter.catchBranch, input: attempted.error.value ?? attempted.error.message });
    break;
  }
  case 'array': {
    const array: JsonValue[] = [];
    for (const item of filter.items) {
      const itemResult = evaluate({ filter: item, input });
      if (!itemResult.ok) return itemResult;
      array.push(...itemResult.outputs);
    }
    result = { ok: true, outputs: [array] };
    break;
  }
  case 'object': {
    let objects: { [key: string]: JsonValue }[] = [createJsonObject()];
    for (const entry of filter.entries) {
      const keys = (() => {
        switch (entry.key.kind) {
        case 'static':
          return { ok: true as const, outputs: [entry.key.value] as JsonValue[] };
        case 'dynamic':
          return evaluate({ filter: entry.key.filter, input });
        default: {
          const _ex: never = entry.key;
          throw new Error(`Unhandled jq object key: ${((_ex satisfies never) as { readonly kind: string }).kind}`);
        }
        }
      })();
      if (!keys.ok) return keys;
      const values = evaluate({ filter: entry.value, input });
      if (!values.ok) return values;
      const next: { [key: string]: JsonValue }[] = [];

      for (const object of objects) {
        for (const keyValue of keys.outputs) {
          if (typeof keyValue !== 'string' && typeof keyValue !== 'number') {
            return runtimeError({ message: 'object keys must be strings or numbers', value: undefined });
          }
          const key = String(keyValue);
          for (const value of values.outputs) {
            const clone = mergeJsonObjects({ left: object, right: createJsonObject() });
            defineJsonProperty({ object: clone, key, value });
            next.push(clone);
          }
        }
      }
      objects = next;
    }
    result = { ok: true, outputs: objects };
    break;
  }
  case 'call':
    result = evaluateBuiltin({ name: filter.name, args: filter.args, input, evaluate });
    break;
  case 'binary': {
    const left = evaluate({ filter: filter.left, input });
    if (!left.ok) return left;
    if (isAlternativeOperator({ operator: filter.operator })) {
      const truthyOutputs = left.outputs.filter((value) => truthy({ value }));
      result = truthyOutputs.length > 0
        ? { ok: true, outputs: truthyOutputs }
        : evaluate({ filter: filter.right, input });
      break;
    }
    const right = evaluate({ filter: filter.right, input });
    if (!right.ok) return right;
    const outputs: JsonValue[] = [];
    for (const rightValue of right.outputs) {
      for (const leftValue of left.outputs) {
        const pair = evaluateBinaryPair({ operator: filter.operator, left: leftValue, right: rightValue });
        if (!pair.ok) return pair;
        outputs.push(pair.value);
      }
    }
    result = { ok: true, outputs };
    break;
  }
  case 'unary': {
    const values = evaluate({ filter: filter.value, input });
    if (!values.ok) return values;
    const outputs: JsonValue[] = [];
    for (const value of values.outputs) {
      switch (filter.operator) {
      case 'not':
        outputs.push(!truthy({ value }));
        break;
      case 'neg':
        if (typeof value !== 'number') {
          return runtimeError({ message: 'unary - expects a number', value: undefined });
        }
        outputs.push(-value);
        break;
      default:
        throw new Error('Unhandled unary operator');
      }
    }
    result = { ok: true, outputs };
    break;
  }
  case 'bind': {
    const binding = evaluate({ filter: filter.binding, input });
    if (!binding.ok) return binding;
    const outputs: JsonValue[] = [];
    for (const boundValue of binding.outputs) {
      const scoped = evaluateJqFilterWithContext({
        filter: filter.body,
        input,
        context: {
          ...nestedContext,
          variables: {
            ...context.variables,
            [filter.name]: boundValue,
          },
        },
      });
      if (!scoped.ok) return scoped;
      outputs.push(...scoped.outputs);
    }
    result = { ok: true, outputs };
    break;
  }
  case 'assign': {
    const values = evaluate({ filter: filter.value, input });
    if (!values.ok) return values;
    const outputs: JsonValue[] = [];
    for (const value of values.outputs) {
      const assigned = applyPathUpdate({
        root: input,
        path: filter.path,
        update: () => ({ ok: true, value }),
      });
      if (!assigned.ok) return runtimeError({ message: assigned.message, value: undefined });
      outputs.push(assigned.value);
    }
    result = { ok: true, outputs };
    break;
  }
  case 'update': {
    let updateOutputs: JsonValue[] | undefined;
    const updated = applyPathUpdate({
      root: input,
      path: filter.path,
      update: ({ currentValue }) => {
        const evaluated = evaluate({ filter: filter.value, input: currentValue ?? null });
        if (!evaluated.ok) return { ok: false, message: evaluated.error.message };
        updateOutputs = evaluated.outputs;
        if (evaluated.outputs.length === 0) {
          return { ok: true, value: null };
        }
        return { ok: true, value: evaluated.outputs[0]! };
      },
    });
    if (!updated.ok) return runtimeError({ message: updated.message, value: undefined });
    if (updateOutputs?.length === 0) {
      const deleted = applyPathDeletion({ root: input, path: filter.path });
      if (!deleted.ok) return runtimeError({ message: deleted.message, value: undefined });
      result = { ok: true, outputs: [deleted.value] };
    } else {
      result = { ok: true, outputs: [updated.value] };
    }
    break;
  }
  default: {
    const _ex: never = filter;
    throw new Error(`Unhandled jq filter: ${JSON.stringify(_ex)}`);
  }
  }

  if (!result.ok) return result;
  return checkOutputLimit({ outputs: result.outputs, context });
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {};
