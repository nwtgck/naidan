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

function insideJson({
  input,
  expected,
}: {
  input: JsonValue;
  expected: JsonValue;
}): boolean {
  return containsJson({
    input: expected,
    expected: input,
  });
}

function addValues({
  left,
  right,
}: {
  left: JsonValue;
  right: JsonValue;
}): JsonValue | undefined {
  if (typeof left === 'number' && typeof right === 'number') {
    return left + right;
  }
  if (typeof left === 'string' && typeof right === 'string') {
    return `${left}${right}`;
  }
  if (Array.isArray(left) && Array.isArray(right)) {
    return [...left, ...right];
  }
  if (
    left !== null &&
    right !== null &&
    typeof left === 'object' &&
    typeof right === 'object' &&
    !Array.isArray(left) &&
    !Array.isArray(right)
  ) {
    return { ...left, ...right };
  }
  return undefined;
}

function flattenJson({
  value,
}: {
  value: JsonValue;
}): JsonValue[] {
  if (!Array.isArray(value)) return [value];
  const flattened: JsonValue[] = [];
  for (const item of value) {
    flattened.push(...flattenJson({ value: item }));
  }
  return flattened;
}

function trimStartPrefix({
  value,
  prefix,
}: {
  value: string;
  prefix: string;
}): string {
  return value.startsWith(prefix) ? value.slice(prefix.length) : value;
}

function trimEndSuffix({
  value,
  suffix,
}: {
  value: string;
  suffix: string;
}): string {
  return value.endsWith(suffix) ? value.slice(0, value.length - suffix.length) : value;
}

function evaluateSingleOutput({
  filter,
  input,
  evaluate,
}: {
  filter: import('./ast').JqFilter;
  input: JsonValue;
  evaluate: JqRuntimeFilterEvaluator;
}): { ok: true; value: JsonValue } | { ok: false; error: JqRuntimeError } {
  const result = evaluate({ filter, input });
  if (!result.ok) return result;
  if (result.outputs.length !== 1) {
    return { ok: false, error: { message: 'filter must yield exactly one value here' } };
  }
  return { ok: true, value: result.outputs[0] ?? null };
}

function walkValue({
  value,
  mapper,
}: {
  value: JsonValue;
  mapper: (options: { input: JsonValue }) => { ok: true; value: JsonValue } | { ok: false; error: JqRuntimeError };
}): { ok: true; value: JsonValue } | { ok: false; error: JqRuntimeError } {
  if (Array.isArray(value)) {
    const mappedItems: JsonValue[] = [];
    for (const item of value) {
      const walked = walkValue({
        value: item,
        mapper,
      });
      if (!walked.ok) return walked;
      mappedItems.push(walked.value);
    }
    return mapper({ input: mappedItems });
  }

  if (value !== null && typeof value === 'object') {
    const mappedObject: Record<string, JsonValue> = {};
    for (const [key, nested] of Object.entries(value)) {
      const walked = walkValue({
        value: nested,
        mapper,
      });
      if (!walked.ok) return walked;
      mappedObject[key] = walked.value;
    }
    return mapper({ input: mappedObject });
  }

  return mapper({ input: value });
}

function recurseChildren({
  input,
}: {
  input: JsonValue;
}): JsonValue[] {
  if (Array.isArray(input)) {
    return [...input];
  }
  if (input !== null && typeof input === 'object') {
    return Object.values(input);
  }
  return [];
}

function recurseValues({
  input,
  evaluateNext,
}: {
  input: JsonValue;
  evaluateNext: (options: { input: JsonValue }) => { ok: true; values: JsonValue[] } | { ok: false; error: JqRuntimeError };
}): { ok: true; values: JsonValue[] } | { ok: false; error: JqRuntimeError } {
  const outputs: JsonValue[] = [input];
  const next = evaluateNext({ input });
  if (!next.ok) return next;

  for (const child of next.values) {
    const nested = recurseValues({
      input: child,
      evaluateNext,
    });
    if (!nested.ok) return nested;
    outputs.push(...nested.values);
  }

  return { ok: true, values: outputs };
}

function typeFilter({
  input,
  expected,
}: {
  input: JsonValue;
  expected: 'array' | 'boolean' | 'null' | 'number' | 'object' | 'scalar' | 'string';
}): JsonValue[] {
  switch (expected) {
  case 'array':
    return Array.isArray(input) ? [input] : [];
  case 'boolean':
    return typeof input === 'boolean' ? [input] : [];
  case 'null':
    return input === null ? [input] : [];
  case 'number':
    return typeof input === 'number' ? [input] : [];
  case 'object':
    return input !== null && typeof input === 'object' && !Array.isArray(input) ? [input] : [];
  case 'scalar':
    return input === null || typeof input === 'boolean' || typeof input === 'number' || typeof input === 'string'
      ? [input]
      : [];
  case 'string':
    return typeof input === 'string' ? [input] : [];
  default: {
    const _ex: never = expected;
    throw new Error(`Unhandled jq type filter: ${_ex}`);
  }
  }
}

function findIndices({
  input,
  search,
}: {
  input: JsonValue;
  search: JsonValue;
}): number[] | undefined {
  if (typeof input === 'string' && typeof search === 'string') {
    if (search.length === 0) {
      return Array.from({ length: input.length + 1 }, (_value, index) => index);
    }
    const indices: number[] = [];
    let start = 0;
    while (start <= input.length - search.length) {
      const index = input.indexOf(search, start);
      if (index === -1) break;
      indices.push(index);
      start = index + 1;
    }
    return indices;
  }

  if (Array.isArray(input)) {
    const indices: number[] = [];
    for (let index = 0; index < input.length; index++) {
      if (compareJsonValues({ left: input[index]!, right: search }) === 0) {
        indices.push(index);
      }
    }
    return indices;
  }

  return undefined;
}

function collectPaths({
  value,
  current,
}: {
  value: JsonValue;
  current: (string | number)[];
}): JsonValue[] {
  const paths: JsonValue[] = [];
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index++) {
      const nextPath = [...current, index];
      paths.push(nextPath);
      paths.push(...collectPaths({ value: value[index]!, current: nextPath }));
    }
    return paths;
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, nested] of Object.entries(value)) {
      const nextPath = [...current, key];
      paths.push(nextPath);
      paths.push(...collectPaths({ value: nested, current: nextPath }));
    }
  }
  return paths;
}

function assignPickedValue({
  container,
  path,
  value,
}: {
  container: JsonValue;
  path: (string | number)[];
  value: JsonValue;
}): void {
  const [head, ...tail] = path;
  if (head === undefined) {
    return;
  }

  const isLeaf = tail.length === 0;
  if (typeof head === 'string') {
    if (container === null || Array.isArray(container) || typeof container !== 'object') {
      return;
    }
    if (isLeaf) {
      container[head] = value;
      return;
    }
    const next = container[head];
    if (next === undefined) {
      container[head] = typeof tail[0] === 'number' ? [] : {};
    }
    assignPickedValue({
      container: container[head]!,
      path: tail,
      value,
    });
    return;
  }

  if (!Array.isArray(container)) {
    return;
  }
  while (container.length <= head) {
    container.push(null);
  }
  if (isLeaf) {
    container[head] = value;
    return;
  }
  const next = container[head];
  if (next === null || next === undefined || typeof next !== 'object') {
    container[head] = typeof tail[0] === 'number' ? [] : {};
  }
  assignPickedValue({
    container: container[head]!,
    path: tail,
    value,
  });
}

function readPathValue({
  input,
  path,
}: {
  input: JsonValue;
  path: (string | number)[];
}): JsonValue | undefined {
  let current: JsonValue | undefined = input;
  for (const segment of path) {
    if (typeof segment === 'string') {
      if (current === null || Array.isArray(current) || typeof current !== 'object' || !Object.hasOwn(current, segment)) {
        return undefined;
      }
      current = current[segment];
      continue;
    }

    if (!Array.isArray(current) || segment < 0 || segment >= current.length) {
      return undefined;
    }
    current = current[segment];
  }
  return current;
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
  case 'add':
    if (args.length !== 0) {
      return { ok: false, error: { message: 'add does not take arguments' } };
    }
    if (!Array.isArray(input)) {
      return { ok: false, error: { message: 'add input must be an array' } };
    }
    if (input.length === 0) {
      return { ok: true, outputs: [null] };
    }
    {
      let accumulator: JsonValue = input[0] ?? null;
      for (const item of input.slice(1)) {
        const combined = addValues({
          left: accumulator,
          right: item,
        });
        if (combined === undefined) {
          return { ok: false, error: { message: 'add input elements must have compatible types' } };
        }
        accumulator = combined;
      }
      return { ok: true, outputs: [accumulator] };
    }
  case 'ascii_downcase':
  case 'ascii_upcase':
    if (args.length !== 0) {
      return { ok: false, error: { message: `${name} does not take arguments` } };
    }
    if (typeof input !== 'string') {
      return { ok: false, error: { message: `${name} input must be a string` } };
    }
    return {
      ok: true,
      outputs: [(() => {
        switch (name) {
        case 'ascii_downcase':
          return input.toLowerCase();
        case 'ascii_upcase':
          return input.toUpperCase();
        default: {
          const _ex: never = name;
          throw new Error(`Unhandled ascii builtin: ${_ex}`);
        }
        }
      })()],
    };
  case 'arrays':
    if (args.length !== 0) {
      return { ok: false, error: { message: 'arrays does not take arguments' } };
    }
    return { ok: true, outputs: typeFilter({ input, expected: 'array' }) };
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
  case 'booleans':
    if (args.length !== 0) {
      return { ok: false, error: { message: 'booleans does not take arguments' } };
    }
    return { ok: true, outputs: typeFilter({ input, expected: 'boolean' }) };
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
  case 'explode':
    if (args.length !== 0) {
      return { ok: false, error: { message: 'explode does not take arguments' } };
    }
    if (typeof input !== 'string') {
      return { ok: false, error: { message: 'explode input must be a string' } };
    }
    return { ok: true, outputs: [[...input].map((character) => character.codePointAt(0) ?? 0)] };
  case 'first': {
    if (args.length > 1) {
      return { ok: false, error: { message: 'first takes at most one argument' } };
    }
    if (args[0] === undefined) {
      return { ok: true, outputs: [input] };
    }
    const outputs = evaluate({
      filter: args[0],
      input,
    });
    if (!outputs.ok) return outputs;
    return { ok: true, outputs: outputs.outputs[0] === undefined ? [] : [outputs.outputs[0]] };
  }
  case 'flatten':
    if (args.length !== 0) {
      return { ok: false, error: { message: 'flatten does not take arguments' } };
    }
    if (!Array.isArray(input)) {
      return { ok: false, error: { message: 'flatten input must be an array' } };
    }
    return { ok: true, outputs: [flattenJson({ value: input })] };
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
  case 'group_by': {
    const keyFilter = args[0];
    if (keyFilter === undefined) {
      return { ok: false, error: { message: 'group_by requires one argument' } };
    }
    if (args.length !== 1) {
      return { ok: false, error: { message: 'group_by takes exactly one argument' } };
    }
    if (!Array.isArray(input)) {
      return { ok: false, error: { message: 'group_by input must be an array' } };
    }

    const keyed = [];
    for (const item of input) {
      const key = evaluateSingleOutput({
        filter: keyFilter,
        input: item,
        evaluate,
      });
      if (!key.ok) return key;
      keyed.push({ key: key.value, item });
    }

    keyed.sort((left, right) => compareJsonValues({ left: left.key, right: right.key }));
    const groups: { key: JsonValue; items: JsonValue[] }[] = [];
    for (const entry of keyed) {
      const lastGroup = groups.at(-1);
      if (lastGroup !== undefined && compareJsonValues({ left: entry.key, right: lastGroup.key }) === 0) {
        lastGroup.items.push(entry.item);
        continue;
      }
      groups.push({ key: entry.key, items: [entry.item] });
    }
    return { ok: true, outputs: [groups.map((group) => group.items)] };
  }
  case 'implode':
    if (args.length !== 0) {
      return { ok: false, error: { message: 'implode does not take arguments' } };
    }
    if (!Array.isArray(input)) {
      return { ok: false, error: { message: 'implode input must be an array' } };
    }
    {
      let output = '';
      for (const item of input) {
        if (typeof item !== 'number' || !Number.isInteger(item) || item < 0 || item > 0x10FFFF) {
          return { ok: false, error: { message: 'implode input elements must be valid Unicode code points' } };
        }
        output += String.fromCodePoint(item);
      }
      return { ok: true, outputs: [output] };
    }
  case 'index':
  case 'indices': {
    const searchFilter = args[0];
    if (searchFilter === undefined) {
      return { ok: false, error: { message: `${name} requires one argument` } };
    }
    if (args.length !== 1) {
      return { ok: false, error: { message: `${name} takes exactly one argument` } };
    }
    const searched = evaluateSingleOutput({
      filter: searchFilter,
      input,
      evaluate,
    });
    if (!searched.ok) return searched;
    const indices = findIndices({
      input,
      search: searched.value,
    });
    if (indices === undefined) {
      return { ok: false, error: { message: `${name} input must be an array or string` } };
    }
    return (() => {
      switch (name) {
      case 'indices':
        return { ok: true, outputs: [indices] } as const;
      case 'index':
        return { ok: true, outputs: [indices[0] ?? null] } as const;
      default: {
        const _ex: never = name;
        throw new Error(`Unhandled index builtin: ${_ex}`);
      }
      }
    })();
  }
  case 'inside': {
    const expected = args[0];
    if (expected === undefined) {
      return { ok: false, error: { message: 'inside requires one argument' } };
    }
    if (args.length !== 1) {
      return { ok: false, error: { message: 'inside takes exactly one argument' } };
    }
    const evaluated = evaluateSingleOutput({
      filter: expected,
      input,
      evaluate,
    });
    if (!evaluated.ok) return evaluated;
    return {
      ok: true,
      outputs: [insideJson({ input, expected: evaluated.value })],
    };
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
  case 'map_values': {
    const mapper = args[0];
    if (mapper === undefined) {
      return { ok: false, error: { message: 'map_values requires one argument' } };
    }
    if (args.length !== 1) {
      return { ok: false, error: { message: 'map_values takes exactly one argument' } };
    }
    if (input === null || Array.isArray(input) || typeof input !== 'object') {
      return { ok: false, error: { message: 'map_values input must be an object' } };
    }

    const result: Record<string, JsonValue> = {};
    for (const [key, value] of Object.entries(input)) {
      const mapped = evaluateSingleOutput({
        filter: mapper,
        input: value,
        evaluate,
      });
      if (!mapped.ok) return mapped;
      result[key] = mapped.value;
    }
    return { ok: true, outputs: [result] };
  }
  case 'nulls':
    if (args.length !== 0) {
      return { ok: false, error: { message: 'nulls does not take arguments' } };
    }
    return { ok: true, outputs: typeFilter({ input, expected: 'null' }) };
  case 'numbers':
    if (args.length !== 0) {
      return { ok: false, error: { message: 'numbers does not take arguments' } };
    }
    return { ok: true, outputs: typeFilter({ input, expected: 'number' }) };
  case 'objects':
    if (args.length !== 0) {
      return { ok: false, error: { message: 'objects does not take arguments' } };
    }
    return { ok: true, outputs: typeFilter({ input, expected: 'object' }) };
  case 'paths':
    if (args.length !== 0) {
      return { ok: false, error: { message: 'paths does not take arguments' } };
    }
    return { ok: true, outputs: collectPaths({ value: input, current: [] }) };
  case 'pick': {
    if (args.length === 0) {
      return { ok: false, error: { message: 'pick requires at least one path' } };
    }
    const root: JsonValue = Array.isArray(input) ? [] : {};
    for (const arg of args) {
      const jqPath = extractJqPath({ filter: arg });
      if (jqPath === undefined) {
        return { ok: false, error: { message: 'pick arguments must be paths' } };
      }
      const materializedPath = jqPath.segments.map((segment) => {
        switch (segment.kind) {
        case 'field':
          return segment.key;
        case 'index':
          return segment.index;
        default: {
          const _ex: never = segment;
          throw new Error(`Unhandled jq path segment: ${JSON.stringify(_ex)}`);
        }
        }
      });
      const value = readPathValue({
        input,
        path: materializedPath,
      });
      if (value === undefined) {
        continue;
      }
      assignPickedValue({
        container: root,
        path: materializedPath,
        value,
      });
    }
    return { ok: true, outputs: [root] };
  }
  case 'recurse': {
    if (args.length > 1) {
      return { ok: false, error: { message: 'recurse takes at most one argument' } };
    }
    const nextFilter = args[0];
    const recursed = recurseValues({
      input,
      evaluateNext: ({ input: nestedInput }) => {
        if (nextFilter === undefined) {
          return { ok: true, values: recurseChildren({ input: nestedInput }) };
        }
        const next = evaluate({ filter: nextFilter, input: nestedInput });
        if (!next.ok) return next;
        return { ok: true, values: next.outputs };
      },
    });
    if (!recursed.ok) return recursed;
    return { ok: true, outputs: recursed.values };
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
  case 'join': {
    const separatorFilter = args[0];
    if (separatorFilter === undefined) {
      return { ok: false, error: { message: 'join requires one argument' } };
    }
    if (args.length !== 1) {
      return { ok: false, error: { message: 'join takes exactly one argument' } };
    }
    if (!Array.isArray(input)) {
      return { ok: false, error: { message: 'join input must be an array' } };
    }
    const evaluated = evaluate({ filter: separatorFilter, input });
    if (!evaluated.ok) return evaluated;
    const separator = evaluated.outputs[0];
    if (typeof separator !== 'string') {
      return { ok: false, error: { message: 'join separator must be a string' } };
    }
    const parts: string[] = [];
    for (const item of input) {
      switch (typeof item) {
      case 'string':
      case 'number':
      case 'boolean':
        parts.push(String(item));
        break;
      case 'object':
        if (item === null) {
          parts.push('null');
          break;
        }
        return { ok: false, error: { message: 'join input elements must be scalars' } };
      default: {
        const _ex: never = item;
        throw new Error(`Unhandled jq join value: ${JSON.stringify(_ex)}`);
      }
      }
    }
    return { ok: true, outputs: [parts.join(separator)] };
  }
  case 'last': {
    if (args.length > 1) {
      return { ok: false, error: { message: 'last takes at most one argument' } };
    }
    if (args[0] === undefined) {
      return { ok: true, outputs: [input] };
    }
    const outputs = evaluate({
      filter: args[0],
      input,
    });
    if (!outputs.ok) return outputs;
    const value = outputs.outputs.at(-1);
    return { ok: true, outputs: value === undefined ? [] : [value] };
  }
  case 'ltrimstr': {
    const prefixFilter = args[0];
    if (prefixFilter === undefined) {
      return { ok: false, error: { message: 'ltrimstr requires one argument' } };
    }
    if (args.length !== 1) {
      return { ok: false, error: { message: 'ltrimstr takes exactly one argument' } };
    }
    const prefix = evaluateSingleOutput({
      filter: prefixFilter,
      input,
      evaluate,
    });
    if (!prefix.ok) return prefix;
    if (typeof input !== 'string' || typeof prefix.value !== 'string') {
      return { ok: false, error: { message: 'ltrimstr expects string input and argument' } };
    }
    return { ok: true, outputs: [trimStartPrefix({ value: input, prefix: prefix.value })] };
  }
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
  case 'rindex': {
    const searchFilter = args[0];
    if (searchFilter === undefined) {
      return { ok: false, error: { message: 'rindex requires one argument' } };
    }
    if (args.length !== 1) {
      return { ok: false, error: { message: 'rindex takes exactly one argument' } };
    }
    const searched = evaluateSingleOutput({
      filter: searchFilter,
      input,
      evaluate,
    });
    if (!searched.ok) return searched;
    const indices = findIndices({
      input,
      search: searched.value,
    });
    if (indices === undefined) {
      return { ok: false, error: { message: 'rindex input must be an array or string' } };
    }
    return { ok: true, outputs: [indices.at(-1) ?? null] };
  }
  case 'rtrimstr': {
    const suffixFilter = args[0];
    if (suffixFilter === undefined) {
      return { ok: false, error: { message: 'rtrimstr requires one argument' } };
    }
    if (args.length !== 1) {
      return { ok: false, error: { message: 'rtrimstr takes exactly one argument' } };
    }
    const suffix = evaluateSingleOutput({
      filter: suffixFilter,
      input,
      evaluate,
    });
    if (!suffix.ok) return suffix;
    if (typeof input !== 'string' || typeof suffix.value !== 'string') {
      return { ok: false, error: { message: 'rtrimstr expects string input and argument' } };
    }
    return { ok: true, outputs: [trimEndSuffix({ value: input, suffix: suffix.value })] };
  }
  case 'scalars':
    if (args.length !== 0) {
      return { ok: false, error: { message: 'scalars does not take arguments' } };
    }
    return { ok: true, outputs: typeFilter({ input, expected: 'scalar' }) };
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
  case 'sort_by': {
    const keyFilter = args[0];
    if (keyFilter === undefined) {
      return { ok: false, error: { message: 'sort_by requires one argument' } };
    }
    if (args.length !== 1) {
      return { ok: false, error: { message: 'sort_by takes exactly one argument' } };
    }
    if (!Array.isArray(input)) {
      return { ok: false, error: { message: 'sort_by input must be an array' } };
    }

    const keyed = [];
    for (const item of input) {
      const key = evaluateSingleOutput({
        filter: keyFilter,
        input: item,
        evaluate,
      });
      if (!key.ok) return key;
      keyed.push({ key: key.value, item });
    }

    keyed.sort((left, right) => compareJsonValues({ left: left.key, right: right.key }));
    return { ok: true, outputs: [keyed.map((entry) => entry.item)] };
  }
  case 'split': {
    const separatorFilter = args[0];
    if (separatorFilter === undefined) {
      return { ok: false, error: { message: 'split requires one argument' } };
    }
    if (args.length !== 1) {
      return { ok: false, error: { message: 'split takes exactly one argument' } };
    }
    const separator = evaluateSingleOutput({
      filter: separatorFilter,
      input,
      evaluate,
    });
    if (!separator.ok) return separator;
    if (typeof input !== 'string' || typeof separator.value !== 'string') {
      return { ok: false, error: { message: 'split expects string input and argument' } };
    }
    return { ok: true, outputs: [input.split(separator.value)] };
  }
  case 'max':
    if (args.length !== 0) {
      return { ok: false, error: { message: 'max does not take arguments' } };
    }
    if (!Array.isArray(input)) {
      return { ok: false, error: { message: 'max input must be an array' } };
    }
    if (input.length === 0) {
      return { ok: true, outputs: [null] };
    }
    return {
      ok: true,
      outputs: [[...input].sort((left, right) => compareJsonValues({ left, right })).at(-1) ?? null],
    };
  case 'min':
    if (args.length !== 0) {
      return { ok: false, error: { message: 'min does not take arguments' } };
    }
    if (!Array.isArray(input)) {
      return { ok: false, error: { message: 'min input must be an array' } };
    }
    if (input.length === 0) {
      return { ok: true, outputs: [null] };
    }
    return {
      ok: true,
      outputs: [[...input].sort((left, right) => compareJsonValues({ left, right }))[0] ?? null],
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
  case 'strings':
    if (args.length !== 0) {
      return { ok: false, error: { message: 'strings does not take arguments' } };
    }
    return { ok: true, outputs: typeFilter({ input, expected: 'string' }) };
  case 'unique':
    if (args.length !== 0) {
      return { ok: false, error: { message: 'unique does not take arguments' } };
    }
    if (!Array.isArray(input)) {
      return { ok: false, error: { message: 'unique input must be an array' } };
    }
    return {
      ok: true,
      outputs: [[...input].sort((left, right) => compareJsonValues({ left, right })).filter((item, index, items) => (
        index === 0 || compareJsonValues({ left: item, right: items[index - 1]! }) !== 0
      ))],
    };
  case 'unique_by': {
    const keyFilter = args[0];
    if (keyFilter === undefined) {
      return { ok: false, error: { message: 'unique_by requires one argument' } };
    }
    if (args.length !== 1) {
      return { ok: false, error: { message: 'unique_by takes exactly one argument' } };
    }
    if (!Array.isArray(input)) {
      return { ok: false, error: { message: 'unique_by input must be an array' } };
    }

    const keyed = [];
    for (const item of input) {
      const key = evaluateSingleOutput({
        filter: keyFilter,
        input: item,
        evaluate,
      });
      if (!key.ok) return key;
      keyed.push({ key: key.value, item });
    }

    keyed.sort((left, right) => compareJsonValues({ left: left.key, right: right.key }));
    const uniqueItems: JsonValue[] = [];
    let previousKey: JsonValue | undefined;
    for (const entry of keyed) {
      if (previousKey !== undefined && compareJsonValues({ left: entry.key, right: previousKey }) === 0) {
        continue;
      }
      uniqueItems.push(entry.item);
      previousKey = entry.key;
    }
    return { ok: true, outputs: [uniqueItems] };
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
  case 'walk': {
    const mapper = args[0];
    if (mapper === undefined) {
      return { ok: false, error: { message: 'walk requires one argument' } };
    }
    if (args.length !== 1) {
      return { ok: false, error: { message: 'walk takes exactly one argument' } };
    }
    const walked = walkValue({
      value: input,
      mapper: ({ input: nestedInput }) => evaluateSingleOutput({
        filter: mapper,
        input: nestedInput,
        evaluate,
      }),
    });
    if (!walked.ok) return walked;
    return { ok: true, outputs: [walked.value] };
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
