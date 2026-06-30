import type { JsonValue, JqBuiltinName, JqFilter } from './ast';
import { applyPathDeletion, applyPathUpdate, extractJqPath } from './path';
import type { JqRuntimeError, JqRuntimeFilterEvaluator } from './runtime';
import {
  compareJsonValues,
  createJsonObject,
  defineJsonProperty,
  isJsonObject,
  mergeJsonObjects,
  normalizeJsonValue,
  stringifyJson,
} from './value';

function truthy({
  value,
}: {
  value: JsonValue,
}): boolean {
  return value !== false && value !== null;
}


function containsJson({
  input,
  expected,
}: {
  input: JsonValue,
  expected: JsonValue,
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
  input: JsonValue,
  expected: JsonValue,
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
  left: JsonValue,
  right: JsonValue,
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
    return mergeJsonObjects({ left, right });
  }
  return undefined;
}

function flattenJson({
  value,
}: {
  value: JsonValue,
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
  value: string,
  prefix: string,
}): string {
  return value.startsWith(prefix) ? value.slice(prefix.length) : value;
}

function trimEndSuffix({
  value,
  suffix,
}: {
  value: string,
  suffix: string,
}): string {
  return value.endsWith(suffix) ? value.slice(0, value.length - suffix.length) : value;
}

function parseStrictNumber({
  value,
}: {
  value: string,
}): number | undefined {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(trimmed)) {
    return undefined;
  }
  const number = Number(trimmed);
  return Number.isFinite(number) ? number : undefined;
}

function evaluateSingleOutput({
  filter,
  input,
  evaluate,
}: {
  filter: import('./ast').JqFilter,
  input: JsonValue,
  evaluate: JqRuntimeFilterEvaluator,
}): { ok: true, value: JsonValue } | { ok: false, error: JqRuntimeError } {
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
  value: JsonValue,
  mapper: ({ input }: { input: JsonValue }) => { ok: true, value: JsonValue } | { ok: false, error: JqRuntimeError },
}): { ok: true, value: JsonValue } | { ok: false, error: JqRuntimeError } {
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
    const mappedObject = createJsonObject();
    for (const [key, nested] of Object.entries(value)) {
      const walked = walkValue({
        value: nested,
        mapper,
      });
      if (!walked.ok) return walked;
      defineJsonProperty({ object: mappedObject, key, value: walked.value });
    }
    return mapper({ input: mappedObject });
  }

  return mapper({ input: value });
}

function recurseChildren({
  input,
}: {
  input: JsonValue,
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
  input: JsonValue,
  evaluateNext: ({ input }: { input: JsonValue }) => { ok: true, values: JsonValue[] } | { ok: false, error: JqRuntimeError },
}): { ok: true, values: JsonValue[] } | { ok: false, error: JqRuntimeError } {
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
  input: JsonValue,
  expected: 'array' | 'boolean' | 'null' | 'number' | 'object' | 'scalar' | 'string',
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
  input: JsonValue,
  search: JsonValue,
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
  value: JsonValue,
  current: (string | number)[],
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
  container: JsonValue,
  path: (string | number)[],
  value: JsonValue,
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
      defineJsonProperty({ object: container, key: head, value });
      return;
    }
    const next = container[head];
    if (next === undefined || next === null || typeof next !== 'object') {
      defineJsonProperty({
        object: container,
        key: head,
        value: typeof tail[0] === 'number' ? [] : createJsonObject(),
      });
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
    container[head] = typeof tail[0] === 'number' ? [] : createJsonObject();
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
  input: JsonValue,
  path: (string | number)[],
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

function parsePathArray({
  value,
}: {
  value: JsonValue,
}): { ok: true, path: (string | number)[] } | { ok: false, message: string } {
  if (!Array.isArray(value)) {
    return { ok: false, message: 'path must be an array' };
  }
  const path: (string | number)[] = [];
  for (const segment of value) {
    if (typeof segment === 'string') {
      path.push(segment);
      continue;
    }
    if (typeof segment === 'number' && Number.isInteger(segment)) {
      path.push(segment);
      continue;
    }
    return { ok: false, message: 'path components must be strings or integers' };
  }
  return { ok: true, path };
}

function toJqPath({
  path,
}: {
  path: readonly (string | number)[],
}): import('./ast').JqPath {
  return {
    segments: path.map((segment) => typeof segment === 'string'
      ? { kind: 'field' as const, key: segment }
      : { kind: 'index' as const, index: segment }),
  };
}

function createEntryObject({
  key,
  value,
}: {
  key: JsonValue,
  value: JsonValue,
}): JsonValue {
  const entry = createJsonObject();
  defineJsonProperty({ object: entry, key: 'key', value: key });
  defineJsonProperty({ object: entry, key: 'value', value });
  return entry;
}

function toEntriesValue({
  input,
}: {
  input: JsonValue,
}): JsonValue[] | undefined {
  if (Array.isArray(input)) {
    return input.map((value, key) => createEntryObject({ key, value }));
  }
  if (isJsonObject(input)) {
    return Object.entries(input).map(([key, value]) => createEntryObject({ key, value }));
  }
  return undefined;
}

function readEntryField({
  entry,
  names,
}: {
  entry: { [key: string]: JsonValue },
  names: readonly string[],
}): JsonValue | undefined {
  for (const name of names) {
    if (Object.hasOwn(entry, name)) return entry[name];
  }
  return undefined;
}

function fromEntriesValue({
  input,
}: {
  input: JsonValue,
}): { ok: true, value: JsonValue } | { ok: false, message: string } {
  if (!Array.isArray(input)) {
    return { ok: false, message: 'from_entries input must be an array' };
  }
  const object = createJsonObject();
  for (const entry of input) {
    if (!isJsonObject(entry)) {
      return { ok: false, message: 'from_entries array elements must be objects' };
    }
    const keyValue = readEntryField({ entry, names: ['key', 'Key', 'name', 'Name'] });
    const value = readEntryField({ entry, names: ['value', 'Value'] });
    if (typeof keyValue !== 'string' && typeof keyValue !== 'number') {
      return { ok: false, message: 'from_entries entry key must be a string or number' };
    }
    defineJsonProperty({ object, key: String(keyValue), value: value ?? null });
  }
  return { ok: true, value: object };
}


function flattenCommaFilter({
  filter,
}: {
  filter: JqFilter,
}): JqFilter[] {
  switch (filter.kind) {
  case 'comma':
    return [
      ...flattenCommaFilter({ filter: filter.left }),
      ...flattenCommaFilter({ filter: filter.right }),
    ];
  case 'identity':
  case 'variable':
  case 'literal':
  case 'string':
  case 'array':
  case 'object':
  case 'field':
  case 'index':
  case 'dynamic_index':
  case 'slice':
  case 'iterate':
  case 'recursive_descent':
  case 'optional':
  case 'pipe':
  case 'conditional':
  case 'trycatch':
  case 'call':
  case 'binary':
  case 'unary':
  case 'bind':
  case 'assign':
  case 'update':
    return [filter];
  default: {
    const _ex: never = filter;
    throw new Error(`Unhandled jq filter: ${((_ex satisfies never) as { readonly kind: string }).kind}`);
  }
  }
}

function evaluateCount({
  filter,
  input,
  evaluate,
  name,
}: {
  filter: import('./ast').JqFilter,
  input: JsonValue,
  evaluate: JqRuntimeFilterEvaluator,
  name: string,
}): { ok: true, value: number } | { ok: false, error: JqRuntimeError } {
  const evaluated = evaluateSingleOutput({ filter, input, evaluate });
  if (!evaluated.ok) return evaluated;
  if (typeof evaluated.value !== 'number' || !Number.isInteger(evaluated.value) || evaluated.value < 0) {
    return { ok: false, error: { message: `${name} count must be a non-negative integer` } };
  }
  return { ok: true, value: evaluated.value };
}

function combinationsOf({
  arrays,
}: {
  arrays: JsonValue[][],
}): JsonValue[][] {
  let combinations: JsonValue[][] = [[]];
  for (const values of arrays) {
    const next: JsonValue[][] = [];
    for (const prefix of combinations) {
      for (const value of values) next.push([...prefix, value]);
    }
    combinations = next;
  }
  return combinations;
}

function transposeArray({
  input,
}: {
  input: JsonValue[],
}): { ok: true, value: JsonValue[][] } | { ok: false, message: string } {
  const rows: JsonValue[][] = [];
  for (const row of input) {
    if (!Array.isArray(row)) {
      return { ok: false, message: 'transpose input must be an array of arrays' };
    }
    rows.push(row);
  }
  const width = rows.reduce((maximum, row) => Math.max(maximum, row.length), 0);
  return {
    ok: true,
    value: Array.from({ length: width }, (_unused, column) => rows.map((row) => row[column] ?? null)),
  };
}

export function evaluateBuiltin({
  name,
  args,
  input,
  evaluate,
}: {
  name: JqBuiltinName,
  args: import('./ast').JqFilter[],
  input: JsonValue,
  evaluate: JqRuntimeFilterEvaluator,
}): { ok: true, outputs: JsonValue[] } | { ok: false, error: JqRuntimeError } {
  switch (name) {
  case 'abs':
  case 'log':
  case 'log2':
  case 'log10':
  case 'sqrt': {
    if (args.length !== 0) {
      return { ok: false, error: { message: `${name} does not take arguments` } };
    }
    if (typeof input !== 'number') {
      return { ok: false, error: { message: `${name} input must be a number` } };
    }
    const value = (() => {
      switch (name) {
      case 'abs':
        return Math.abs(input);
      case 'log':
        return Math.log(input);
      case 'log2':
        return Math.log2(input);
      case 'log10':
        return Math.log10(input);
      case 'sqrt':
        return Math.sqrt(input);
      default: {
        const _ex: never = name;
        throw new Error(`Unhandled math builtin: ${_ex}`);
      }
      }
    })();
    return { ok: true, outputs: [value] };
  }
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
    if (args.length > 1) {
      return { ok: false, error: { message: `${name} takes at most one argument` } };
    }
    const items = Array.isArray(input)
      ? input
      : isJsonObject(input)
        ? Object.values(input)
        : undefined;
    if (items === undefined) {
      return { ok: false, error: { message: `${name} input must be an array or object` } };
    }

    const predicate = args[0];
    const booleans: boolean[] = [];
    for (const item of items) {
      if (predicate === undefined) {
        booleans.push(truthy({ value: item }));
        continue;
      }
      const evaluated = evaluate({ filter: predicate, input: item });
      if (!evaluated.ok) return evaluated;
      for (const output of evaluated.outputs) {
        booleans.push(truthy({ value: output }));
      }
    }
    switch (name) {
    case 'any':
      return { ok: true, outputs: [booleans.some(Boolean)] };
    case 'all':
      return { ok: true, outputs: [booleans.every(Boolean)] };
    default: {
      const _ex: never = name;
      throw new Error(`Unhandled boolean aggregate: ${_ex}`);
    }
    }
  }
  case 'bsearch': {
    if (args.length !== 1 || args[0] === undefined) {
      return { ok: false, error: { message: 'bsearch takes exactly one argument' } };
    }
    if (!Array.isArray(input)) {
      return { ok: false, error: { message: 'bsearch input must be an array' } };
    }
    const needle = evaluateSingleOutput({ filter: args[0], input, evaluate });
    if (!needle.ok) return needle;
    let low = 0;
    let high = input.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      const compared = compareJsonValues({ left: input[middle]!, right: needle.value });
      if (compared < 0) low = middle + 1;
      else high = middle;
    }
    if (low < input.length && compareJsonValues({ left: input[low]!, right: needle.value }) === 0) {
      return { ok: true, outputs: [low] };
    }
    return { ok: true, outputs: [-low - 1] };
  }
  case 'booleans':
    if (args.length !== 0) {
      return { ok: false, error: { message: 'booleans does not take arguments' } };
    }
    return { ok: true, outputs: typeFilter({ input, expected: 'boolean' }) };
  case 'ceil':
  case 'floor':
  case 'round':
    if (args.length !== 0) {
      return { ok: false, error: { message: `${name} does not take arguments` } };
    }
    if (typeof input !== 'number') {
      return { ok: false, error: { message: `${name} input must be a number` } };
    }
    return {
      ok: true,
      outputs: [(() => {
        switch (name) {
        case 'ceil':
          return Math.ceil(input);
        case 'floor':
          return Math.floor(input);
        case 'round':
          return Math.round(input);
        default: {
          const _ex: never = name;
          throw new Error(`Unhandled numeric builtin: ${_ex}`);
        }
        }
      })()],
    };
  case 'combinations': {
    if (args.length > 1) {
      return { ok: false, error: { message: 'combinations takes at most one argument' } };
    }
    if (!Array.isArray(input)) {
      return { ok: false, error: { message: 'combinations input must be an array' } };
    }
    if (args[0] === undefined) {
      const arrays: JsonValue[][] = [];
      for (const value of input) {
        if (!Array.isArray(value)) {
          return { ok: false, error: { message: 'combinations input elements must be arrays' } };
        }
        arrays.push(value);
      }
      return { ok: true, outputs: combinationsOf({ arrays }) };
    }
    const count = evaluateCount({ filter: args[0], input, evaluate, name: 'combinations' });
    if (!count.ok) return count;
    const arrays = Array.from({ length: count.value }, () => input);
    return { ok: true, outputs: combinationsOf({ arrays }) };
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
  case 'delpaths': {
    if (args.length !== 1 || args[0] === undefined) {
      return { ok: false, error: { message: 'delpaths takes exactly one argument' } };
    }
    const evaluated = evaluateSingleOutput({ filter: args[0], input, evaluate });
    if (!evaluated.ok) return evaluated;
    if (!Array.isArray(evaluated.value)) {
      return { ok: false, error: { message: 'delpaths argument must be an array of paths' } };
    }
    let result = input;
    for (const rawPath of evaluated.value) {
      const parsed = parsePathArray({ value: rawPath });
      if (!parsed.ok) return { ok: false, error: { message: parsed.message } };
      const deleted = applyPathDeletion({ root: result, path: toJqPath({ path: parsed.path }) });
      if (!deleted.ok) return { ok: false, error: { message: deleted.message } };
      result = deleted.value;
    }
    return { ok: true, outputs: [result] };
  }
  case 'empty':
    if (args.length !== 0) {
      return { ok: false, error: { message: 'empty does not take arguments' } };
    }
    return { ok: true, outputs: [] };
  case 'error': {
    if (args.length > 1) {
      return { ok: false, error: { message: 'error takes at most one argument' } };
    }
    if (args[0] === undefined) {
      return { ok: false, error: { message: JSON.stringify(input) } };
    }
    const message = evaluateSingleOutput({
      filter: args[0],
      input,
      evaluate,
    });
    if (!message.ok) return message;
    return {
      ok: false,
      error: { message: typeof message.value === 'string' ? message.value : JSON.stringify(message.value) },
    };
  }
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
  case 'from_entries': {
    if (args.length !== 0) {
      return { ok: false, error: { message: 'from_entries does not take arguments' } };
    }
    const converted = fromEntriesValue({ input });
    return converted.ok
      ? { ok: true, outputs: [converted.value] }
      : { ok: false, error: { message: converted.message } };
  }
  case 'fromjson':
    if (args.length !== 0) {
      return { ok: false, error: { message: 'fromjson does not take arguments' } };
    }
    if (typeof input !== 'string') {
      return { ok: false, error: { message: 'fromjson input must be a string' } };
    }
    try {
      return { ok: true, outputs: [normalizeJsonValue({ value: JSON.parse(input) as JsonValue })] };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, error: { message: `fromjson parse error: ${message}` } };
    }
  case 'getpath': {
    if (args.length !== 1 || args[0] === undefined) {
      return { ok: false, error: { message: 'getpath takes exactly one argument' } };
    }
    const evaluated = evaluateSingleOutput({ filter: args[0], input, evaluate });
    if (!evaluated.ok) return evaluated;
    const parsed = parsePathArray({ value: evaluated.value });
    if (!parsed.ok) return { ok: false, error: { message: parsed.message } };
    return { ok: true, outputs: [readPathValue({ input, path: parsed.path }) ?? null] };
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
    const groups: { key: JsonValue, items: JsonValue[] }[] = [];
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
        if (typeof item !== 'number') {
          return { ok: false, error: { message: 'implode input elements must be numbers' } };
        }
        const codePoint = Math.trunc(item);
        const valid = codePoint >= 0
          && codePoint <= 0x10FFFF
          && (codePoint < 0xD800 || codePoint > 0xDFFF);
        output += String.fromCodePoint(valid ? codePoint : 0xFFFD);
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
    if (Array.isArray(input)) {
      const result: JsonValue[] = [];
      for (const value of input) {
        const mapped = evaluate({ filter: mapper, input: value });
        if (!mapped.ok) return mapped;
        const first = mapped.outputs[0];
        if (first !== undefined) result.push(first);
      }
      return { ok: true, outputs: [result] };
    }
    if (!isJsonObject(input)) {
      return { ok: false, error: { message: 'map_values input must be an array or object' } };
    }

    const result = createJsonObject();
    for (const [key, value] of Object.entries(input)) {
      const mapped = evaluate({ filter: mapper, input: value });
      if (!mapped.ok) return mapped;
      const first = mapped.outputs[0];
      if (first !== undefined) defineJsonProperty({ object: result, key, value: first });
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
  case 'path': {
    if (args.length !== 1 || args[0] === undefined) {
      return { ok: false, error: { message: 'path takes exactly one argument' } };
    }
    const path = extractJqPath({ filter: args[0] });
    if (path === undefined) {
      return { ok: false, error: { message: 'path currently requires a static path expression' } };
    }
    return {
      ok: true,
      outputs: [path.segments.map((segment) => {
        switch (segment.kind) {
        case 'field':
          return segment.key;
        case 'index':
          return segment.index;
        default: {
          const _ex: never = segment;
          throw new Error(`Unhandled jq path segment: ${((_ex satisfies never) as { readonly kind: string }).kind}`);
        }
        }
      })],
    };
  }
  case 'paths':
    if (args.length !== 0) {
      return { ok: false, error: { message: 'paths does not take arguments' } };
    }
    return { ok: true, outputs: collectPaths({ value: input, current: [] }) };
  case 'pick': {
    const argument = args[0];
    if (argument === undefined || args.length !== 1) {
      return { ok: false, error: { message: 'pick takes exactly one argument' } };
    }
    const root: JsonValue = Array.isArray(input) ? [] : createJsonObject();
    for (const pathFilter of flattenCommaFilter({ filter: argument })) {
      const jqPath = extractJqPath({ filter: pathFilter });
      if (jqPath === undefined) {
        return { ok: false, error: { message: 'pick argument must contain paths' } };
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
      const value = readPathValue({ input, path: materializedPath });
      if (value === undefined) continue;
      assignPickedValue({ container: root, path: materializedPath, value });
    }
    return { ok: true, outputs: [root] };
  }
  case 'pow': {
    if (args.length !== 1 || args[0] === undefined) {
      return { ok: false, error: { message: 'pow takes exactly one argument' } };
    }
    if (typeof input !== 'number') {
      return { ok: false, error: { message: 'pow input must be a number' } };
    }
    const exponent = evaluateSingleOutput({ filter: args[0], input, evaluate });
    if (!exponent.ok) return exponent;
    if (typeof exponent.value !== 'number') {
      return { ok: false, error: { message: 'pow exponent must be a number' } };
    }
    return { ok: true, outputs: [Math.pow(input, exponent.value)] };
  }
  case 'range': {
    if (args.length === 0 || args.length > 3) {
      return { ok: false, error: { message: 'range takes one to three arguments' } };
    }
    const evaluatedArgs: JsonValue[] = [];
    for (const arg of args) {
      const evaluated = evaluateSingleOutput({
        filter: arg,
        input,
        evaluate,
      });
      if (!evaluated.ok) return evaluated;
      evaluatedArgs.push(evaluated.value);
    }
    const numericArgs: number[] = [];
    for (const value of evaluatedArgs) {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        return { ok: false, error: { message: 'range arguments must be finite numbers' } };
      }
      numericArgs.push(value);
    }
    const [start, end, step] = (() => {
      switch (numericArgs.length) {
      case 1:
        return [0, numericArgs[0]!, 1] as const;
      case 2:
        return [numericArgs[0]!, numericArgs[1]!, 1] as const;
      case 3:
        return [numericArgs[0]!, numericArgs[1]!, numericArgs[2]!] as const;
      default: {
        const _ex: never = numericArgs.length as never;
        throw new Error(`Unhandled range arity: ${_ex}`);
      }
      }
    })();
    if (step === 0) return { ok: true, outputs: [] };
    const outputs: JsonValue[] = [];
    if (step > 0) {
      for (let value = start; value < end; value += step) {
        outputs.push(value);
      }
      return { ok: true, outputs };
    }
    for (let value = start; value > end; value += step) {
      outputs.push(value);
    }
    return { ok: true, outputs };
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
  case 'isempty': {
    if (args.length !== 1 || args[0] === undefined) {
      return { ok: false, error: { message: 'isempty takes exactly one argument' } };
    }
    const evaluated = evaluate({ filter: args[0], input });
    if (!evaluated.ok) return evaluated;
    return { ok: true, outputs: [evaluated.outputs.length === 0] };
  }
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
  case 'limit':
  case 'nth': {
    if (args.length !== 2 || args[0] === undefined || args[1] === undefined) {
      return { ok: false, error: { message: `${name} takes exactly two arguments` } };
    }
    const count = evaluateCount({ filter: args[0], input, evaluate, name });
    if (!count.ok) return count;
    const generated = evaluate({ filter: args[1], input });
    if (!generated.ok) return generated;
    switch (name) {
    case 'limit':
      return { ok: true, outputs: generated.outputs.slice(0, count.value) };
    case 'nth':
      return generated.outputs[count.value] === undefined
        ? { ok: true, outputs: [] }
        : { ok: true, outputs: [generated.outputs[count.value]!] };
    default: {
      const _ex: never = name;
      throw new Error(`Unhandled stream count builtin: ${_ex}`);
    }
    }
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
    if (typeof input !== 'string') {
      return { ok: false, error: { message: 'ltrimstr input must be a string' } };
    }
    return {
      ok: true,
      outputs: [typeof prefix.value === 'string'
        ? trimStartPrefix({ value: input, prefix: prefix.value })
        : input],
    };
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
    if (typeof input !== 'string') {
      return { ok: false, error: { message: 'rtrimstr input must be a string' } };
    }
    return {
      ok: true,
      outputs: [typeof suffix.value === 'string'
        ? trimEndSuffix({ value: input, suffix: suffix.value })
        : input],
    };
  }
  case 'scalars':
    if (args.length !== 0) {
      return { ok: false, error: { message: 'scalars does not take arguments' } };
    }
    return { ok: true, outputs: typeFilter({ input, expected: 'scalar' }) };
  case 'setpath': {
    if (args.length !== 2 || args[0] === undefined || args[1] === undefined) {
      return { ok: false, error: { message: 'setpath takes exactly two arguments' } };
    }
    const pathValue = evaluateSingleOutput({ filter: args[0], input, evaluate });
    if (!pathValue.ok) return pathValue;
    const parsed = parsePathArray({ value: pathValue.value });
    if (!parsed.ok) return { ok: false, error: { message: parsed.message } };
    const newValue = evaluateSingleOutput({ filter: args[1], input, evaluate });
    if (!newValue.ok) return newValue;
    const updated = applyPathUpdate({
      root: input,
      path: toJqPath({ path: parsed.path }),
      update: () => ({ ok: true, value: newValue.value }),
    });
    return updated.ok
      ? { ok: true, outputs: [updated.value] }
      : { ok: false, error: { message: updated.message } };
  }
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
  case 'max_by':
  case 'min_by': {
    if (args.length !== 1 || args[0] === undefined) {
      return { ok: false, error: { message: `${name} takes exactly one argument` } };
    }
    if (!Array.isArray(input)) {
      return { ok: false, error: { message: `${name} input must be an array` } };
    }
    if (input.length === 0) return { ok: true, outputs: [null] };
    let selected: JsonValue = input[0]!;
    let selectedKey = evaluateSingleOutput({ filter: args[0], input: selected, evaluate });
    if (!selectedKey.ok) return selectedKey;
    for (const item of input.slice(1)) {
      const itemKey = evaluateSingleOutput({ filter: args[0], input: item, evaluate });
      if (!itemKey.ok) return itemKey;
      const comparison = compareJsonValues({ left: itemKey.value, right: selectedKey.value });
      const replace = (() => {
        switch (name) {
        case 'min_by':
          return comparison < 0;
        case 'max_by':
          return comparison > 0;
        default: {
          const _ex: never = name;
          throw new Error(`Unhandled keyed extremum: ${_ex}`);
        }
        }
      })();
      if (replace) {
        selected = item;
        selectedKey = itemKey;
      }
    }
    return { ok: true, outputs: [selected] };
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
  case 'transpose': {
    if (args.length !== 0) {
      return { ok: false, error: { message: 'transpose does not take arguments' } };
    }
    if (!Array.isArray(input)) {
      return { ok: false, error: { message: 'transpose input must be an array' } };
    }
    const transposed = transposeArray({ input });
    return transposed.ok
      ? { ok: true, outputs: [transposed.value] }
      : { ok: false, error: { message: transposed.message } };
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
  case 'with_entries': {
    if (args.length !== 1 || args[0] === undefined) {
      return { ok: false, error: { message: 'with_entries takes exactly one argument' } };
    }
    const entries = toEntriesValue({ input });
    if (entries === undefined) {
      return { ok: false, error: { message: 'with_entries input must be an array or object' } };
    }
    const mappedEntries: JsonValue[] = [];
    for (const entry of entries) {
      const mapped = evaluate({ filter: args[0], input: entry });
      if (!mapped.ok) return mapped;
      mappedEntries.push(...mapped.outputs);
    }
    const converted = fromEntriesValue({ input: mappedEntries });
    return converted.ok
      ? { ok: true, outputs: [converted.value] }
      : { ok: false, error: { message: converted.message } };
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
  case 'to_entries': {
    if (args.length !== 0) {
      return { ok: false, error: { message: 'to_entries does not take arguments' } };
    }
    const entries = toEntriesValue({ input });
    return entries === undefined
      ? { ok: false, error: { message: 'to_entries input must be an array or object' } }
      : { ok: true, outputs: [entries] };
  }
  case 'tojson':
    if (args.length !== 0) {
      return { ok: false, error: { message: 'tojson does not take arguments' } };
    }
    return {
      ok: true,
      outputs: [stringifyJson({
        value: input,
        indentation: undefined,
        sortKeys: false,
        asciiOnly: false,
      })],
    };
  case 'tonumber':
    if (args.length !== 0) {
      return { ok: false, error: { message: 'tonumber does not take arguments' } };
    }
    switch (typeof input) {
    case 'number':
      return { ok: true, outputs: [input] };
    case 'string': {
      const parsed = parseStrictNumber({ value: input });
      if (parsed === undefined) {
        return { ok: false, error: { message: `cannot parse number from string ${JSON.stringify(input)}` } };
      }
      return { ok: true, outputs: [parsed] };
    }
    default:
      return { ok: false, error: { message: 'tonumber input must be a string or number' } };
    }
  case 'utf8bytelength':
    if (args.length !== 0) {
      return { ok: false, error: { message: 'utf8bytelength does not take arguments' } };
    }
    if (typeof input !== 'string') {
      return { ok: false, error: { message: 'utf8bytelength input must be a string' } };
    }
    return { ok: true, outputs: [new TextEncoder().encode(input).byteLength] };
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
      : {
        ok: true,
        outputs: [stringifyJson({
          value: input,
          indentation: undefined,
          sortKeys: false,
          asciiOnly: false,
        })],
      };
  default: {
    const _ex: never = name;
    throw new Error(`Unhandled jq builtin: ${_ex}`);
  }
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {};
