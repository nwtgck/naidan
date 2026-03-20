import type { JsonValue, JqFilter, JqPath, JqPathSegment } from './ast';
import { evaluateBuiltin } from './builtins';
import { cloneJson, normalizeArrayIndex } from './path';

export interface JqRuntimeError {
  message: string;
}

export type JqRuntimeFilterEvaluator = (options: {
  filter: JqFilter;
  input: JsonValue;
}) => { ok: true; outputs: JsonValue[] } | { ok: false; error: JqRuntimeError };

function truthy({
  value,
}: {
  value: JsonValue;
}): boolean {
  return value !== false && value !== null;
}

function deepEqual({
  left,
  right,
}: {
  left: JsonValue;
  right: JsonValue;
}): boolean {
  if (left === right) return true;
  if (typeof left !== typeof right) return false;
  if (left === null || right === null) return left === right;

  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right)) return false;
    if (left.length !== right.length) return false;
    for (let index = 0; index < left.length; index++) {
      if (!deepEqual({ left: left[index]!, right: right[index]! })) return false;
    }
    return true;
  }

  if (typeof left === 'object' && typeof right === 'object') {
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    if (leftKeys.length !== rightKeys.length) return false;
    for (const key of leftKeys) {
      if (!Object.hasOwn(right, key)) return false;
      if (!deepEqual({ left: left[key]!, right: right[key]! })) return false;
    }
    return true;
  }

  return false;
}

function compareValues({
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

function normalizeSliceBound({
  length,
  bound,
  fallback,
}: {
  length: number;
  bound: number | undefined;
  fallback: 0 | 'length';
}): number {
  const raw = bound ?? (fallback === 'length' ? length : 0);
  const normalized = raw < 0 ? length + raw : raw;
  return Math.min(Math.max(normalized, 0), length);
}

function applyPathAssignment({
  root,
  path,
  assignValue,
  mode,
}: {
  root: JsonValue;
  path: JqPath;
  assignValue: (options: { currentValue: JsonValue | undefined }) => { ok: true; value: JsonValue } | { ok: false; error: JqRuntimeError };
  mode: 'assign' | 'update';
}): { ok: true; value: JsonValue } | { ok: false; error: JqRuntimeError } {
  if (path.segments.length === 0) {
    return assignValue({ currentValue: root });
  }

  const nextRoot = cloneJson({ value: root });
  const result = assignIntoPath({
    container: nextRoot,
    segments: path.segments,
    assignValue,
    mode,
  });
  if (!result.ok) return result;
  return { ok: true, value: nextRoot };
}

function assignIntoPath({
  container,
  segments,
  assignValue,
  mode,
}: {
  container: JsonValue;
  segments: JqPathSegment[];
  assignValue: (options: { currentValue: JsonValue | undefined }) => { ok: true; value: JsonValue } | { ok: false; error: JqRuntimeError };
  mode: 'assign' | 'update';
}): { ok: true } | { ok: false; error: JqRuntimeError } {
  const [head, ...tail] = segments;
  if (head === undefined) {
    return { ok: false, error: { message: 'empty assignment path' } };
  }

  const isLeaf = tail.length === 0;
  switch (head.kind) {
  case 'field': {
    if (container === null || Array.isArray(container) || typeof container !== 'object') {
      return { ok: false, error: { message: `cannot index field '${head.key}' on non-object` } };
    }

    if (isLeaf) {
      const current = container[head.key];
      const assigned = assignValue({ currentValue: current });
      if (!assigned.ok) return assigned;
      container[head.key] = assigned.value;
      return { ok: true };
    }

    const existing = container[head.key];
    if (existing === undefined) {
      container[head.key] = {};
    } else if (existing === null || Array.isArray(existing) || typeof existing !== 'object') {
      return { ok: false, error: { message: `cannot descend into '${head.key}'` } };
    }

    return assignIntoPath({
      container: container[head.key]!,
      segments: tail,
      assignValue,
      mode,
    });
  }
  case 'index': {
    if (!Array.isArray(container)) {
      return { ok: false, error: { message: `cannot index [${head.index}] on non-array` } };
    }
    const normalizedIndex = normalizeArrayIndex({
      array: container,
      index: head.index,
    });
    if (normalizedIndex === undefined) {
      return { ok: false, error: { message: `invalid array index ${head.index}` } };
    }

    if (isLeaf) {
      const current = container[normalizedIndex];
      const assigned = assignValue({ currentValue: current });
      if (!assigned.ok) return assigned;
      container[normalizedIndex] = assigned.value;
      return { ok: true };
    }

    const existing = container[normalizedIndex];
    if (existing === undefined || existing === null || Array.isArray(existing) || typeof existing !== 'object') {
      return { ok: false, error: { message: `cannot descend into [${head.index}]` } };
    }
    return assignIntoPath({
      container: existing,
      segments: tail,
      assignValue,
      mode,
    });
  }
  default: {
    const _ex: never = head;
    throw new Error(`Unhandled jq path segment: ${JSON.stringify(_ex)}`);
  }
  }
}

export function evaluateJqFilter({
  filter,
  input,
}: {
  filter: JqFilter;
  input: JsonValue;
}): { ok: true; outputs: JsonValue[] } | { ok: false; error: JqRuntimeError } {
  const evaluate: JqRuntimeFilterEvaluator = ({ filter: nestedFilter, input: nestedInput }) =>
    evaluateJqFilter({ filter: nestedFilter, input: nestedInput });

  switch (filter.kind) {
  case 'identity':
    return { ok: true, outputs: [input] };
  case 'literal':
    return { ok: true, outputs: [cloneJson({ value: filter.value })] };
  case 'field': {
    const parent = evaluate({ filter: filter.input, input });
    if (!parent.ok) return parent;
    const outputs: JsonValue[] = [];
    for (const value of parent.outputs) {
      if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
        outputs.push(Object.hasOwn(value, filter.key) ? value[filter.key]! : null);
        continue;
      }
      if (filter.optional) {
        continue;
      }
      return { ok: false, error: { message: `cannot access field '${filter.key}' on non-object` } };
    }
    return { ok: true, outputs };
  }
  case 'index': {
    const parent = evaluate({ filter: filter.input, input });
    if (!parent.ok) return parent;
    const outputs: JsonValue[] = [];
    for (const value of parent.outputs) {
      if (Array.isArray(value)) {
        const normalizedIndex = normalizeArrayIndex({
          array: value,
          index: filter.index,
        });
        outputs.push(normalizedIndex === undefined ? null : (value[normalizedIndex] ?? null));
        continue;
      }
      if (filter.optional) {
        continue;
      }
      return { ok: false, error: { message: `cannot index [${filter.index}] on non-array` } };
    }
    return { ok: true, outputs };
  }
  case 'slice': {
    const parent = evaluate({ filter: filter.input, input });
    if (!parent.ok) return parent;
    const outputs: JsonValue[] = [];
    for (const value of parent.outputs) {
      if (Array.isArray(value)) {
        const start = normalizeSliceBound({
          length: value.length,
          bound: filter.start,
          fallback: 0,
        });
        const end = normalizeSliceBound({
          length: value.length,
          bound: filter.end,
          fallback: 'length',
        });
        outputs.push(value.slice(start, end));
        continue;
      }
      if (typeof value === 'string') {
        const start = normalizeSliceBound({
          length: value.length,
          bound: filter.start,
          fallback: 0,
        });
        const end = normalizeSliceBound({
          length: value.length,
          bound: filter.end,
          fallback: 'length',
        });
        outputs.push(value.slice(start, end));
        continue;
      }
      if (filter.optional) {
        continue;
      }
      return { ok: false, error: { message: 'cannot slice non-array/string' } };
    }
    return { ok: true, outputs };
  }
  case 'iterate': {
    const parent = evaluate({ filter: filter.input, input });
    if (!parent.ok) return parent;
    const outputs: JsonValue[] = [];
    for (const value of parent.outputs) {
      if (Array.isArray(value)) {
        outputs.push(...value);
        continue;
      }
      if (value !== null && typeof value === 'object') {
        outputs.push(...Object.values(value));
        continue;
      }
      if (filter.optional) {
        continue;
      }
      return { ok: false, error: { message: 'cannot iterate over non-array/object' } };
    }
    return { ok: true, outputs };
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
    return { ok: true, outputs };
  }
  case 'comma': {
    const left = evaluate({ filter: filter.left, input });
    if (!left.ok) return left;
    const right = evaluate({ filter: filter.right, input });
    if (!right.ok) return right;
    return { ok: true, outputs: [...left.outputs, ...right.outputs] };
  }
  case 'conditional': {
    const condition = evaluate({ filter: filter.condition, input });
    if (!condition.ok) return condition;
    const selectedBranch = truthy({ value: condition.outputs[0] ?? null })
      ? filter.thenBranch
      : filter.elseBranch;
    return evaluate({ filter: selectedBranch, input });
  }
  case 'array': {
    const array: JsonValue[] = [];
    for (const item of filter.items) {
      const itemResult = evaluate({ filter: item, input });
      if (!itemResult.ok) return itemResult;
      array.push(...itemResult.outputs);
    }
    return { ok: true, outputs: [array] };
  }
  case 'object': {
    const object: { [key: string]: JsonValue } = {};
    for (const entry of filter.entries) {
      const value = evaluate({ filter: entry.value, input });
      if (!value.ok) return value;
      object[entry.key] = value.outputs.length <= 1
        ? value.outputs[0] ?? null
        : value.outputs;
    }
    return { ok: true, outputs: [object] };
  }
  case 'call':
    return evaluateBuiltin({
      name: filter.name,
      args: filter.args,
      input,
      evaluate,
    });
  case 'binary': {
    const left = evaluate({ filter: filter.left, input });
    if (!left.ok) return left;
    const right = evaluate({ filter: filter.right, input });
    if (!right.ok) return right;
    const leftValue = left.outputs[0] ?? null;
    const rightValue = right.outputs[0] ?? null;

    switch (filter.operator) {
    case 'pipe':
    case 'comma':
      return { ok: false, error: { message: `unexpected operator ${filter.operator}` } };
    case 'alternative': {
      const truthyOutputs = left.outputs.filter((output) => truthy({ value: output }));
      if (truthyOutputs.length > 0) {
        return { ok: true, outputs: truthyOutputs };
      }
      return right;
    }
    case 'or':
      return { ok: true, outputs: [truthy({ value: leftValue }) || truthy({ value: rightValue })] };
    case 'and':
      return { ok: true, outputs: [truthy({ value: leftValue }) && truthy({ value: rightValue })] };
    case 'eq':
      return { ok: true, outputs: [deepEqual({ left: leftValue, right: rightValue })] };
    case 'ne':
      return { ok: true, outputs: [!deepEqual({ left: leftValue, right: rightValue })] };
    case 'lt':
      return { ok: true, outputs: [compareValues({ left: leftValue, right: rightValue }) < 0] };
    case 'le':
      return { ok: true, outputs: [compareValues({ left: leftValue, right: rightValue }) <= 0] };
    case 'gt':
      return { ok: true, outputs: [compareValues({ left: leftValue, right: rightValue }) > 0] };
    case 'ge':
      return { ok: true, outputs: [compareValues({ left: leftValue, right: rightValue }) >= 0] };
    case 'add':
      if (typeof leftValue === 'number' && typeof rightValue === 'number') {
        return { ok: true, outputs: [leftValue + rightValue] };
      }
      if (typeof leftValue === 'string' && typeof rightValue === 'string') {
        return { ok: true, outputs: [`${leftValue}${rightValue}`] };
      }
      if (Array.isArray(leftValue) && Array.isArray(rightValue)) {
        return { ok: true, outputs: [[...leftValue, ...rightValue]] };
      }
      if (
        leftValue !== null &&
        rightValue !== null &&
        typeof leftValue === 'object' &&
        typeof rightValue === 'object' &&
        !Array.isArray(leftValue) &&
        !Array.isArray(rightValue)
      ) {
        return { ok: true, outputs: [{ ...leftValue, ...rightValue }] };
      }
      return { ok: false, error: { message: 'unsupported operands for +' } };
    case 'sub':
      if (typeof leftValue === 'number' && typeof rightValue === 'number') {
        return { ok: true, outputs: [leftValue - rightValue] };
      }
      return { ok: false, error: { message: 'unsupported operands for -' } };
    case 'mul':
      if (typeof leftValue === 'number' && typeof rightValue === 'number') {
        return { ok: true, outputs: [leftValue * rightValue] };
      }
      return { ok: false, error: { message: 'unsupported operands for *' } };
    case 'div':
      if (typeof leftValue === 'number' && typeof rightValue === 'number') {
        return { ok: true, outputs: [leftValue / rightValue] };
      }
      return { ok: false, error: { message: 'unsupported operands for /' } };
    }
    throw new Error('Unreachable jq binary operator');
  }
  case 'unary': {
    const value = evaluate({ filter: filter.value, input });
    if (!value.ok) return value;
    switch (filter.operator) {
    case 'not':
      return { ok: true, outputs: [!truthy({ value: value.outputs[0] ?? null })] };
    case 'neg': {
      const unaryValue = value.outputs[0] ?? null;
      if (typeof unaryValue !== 'number') {
        return { ok: false, error: { message: 'unary - expects a number' } };
      }
      return { ok: true, outputs: [-unaryValue] };
    }
    }
    throw new Error('Unreachable jq unary operator');
  }
  case 'assign': {
    const assigned = applyPathAssignment({
      root: input,
      path: filter.path,
      mode: 'assign',
      assignValue: () => {
        const result = evaluate({ filter: filter.value, input });
        if (!result.ok) return result;
        return { ok: true, value: result.outputs[0] ?? null };
      },
    });
    if (!assigned.ok) return assigned;
    return { ok: true, outputs: [assigned.value] };
  }
  case 'update': {
    const updated = applyPathAssignment({
      root: input,
      path: filter.path,
      mode: 'update',
      assignValue: ({ currentValue }) => {
        const result = evaluate({ filter: filter.value, input: currentValue ?? null });
        if (!result.ok) return result;
        if (result.outputs.length !== 1) {
          return { ok: false, error: { message: '|= right-hand side must yield exactly one value' } };
        }
        return { ok: true, value: result.outputs[0]! };
      },
    });
    if (!updated.ok) return updated;
    return { ok: true, outputs: [updated.value] };
  }
  default: {
    const _ex: never = filter;
    throw new Error(`Unhandled jq filter: ${JSON.stringify(_ex)}`);
  }
  }
}
