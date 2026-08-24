import type { JsonValue, JqBuiltinName, JqFilter, JqPathExpression, JqProgram, JqUserDefinition } from './ast';
import { instantiateJqUserDefinition } from './user-definition';
import {
  compareJsonValues,
  createJsonObject,
  defineJsonProperty,
  formatJqObjectKeyError,
  isJsonObject,
  jsonValuesEqual,
  mergeJsonObjects,
  normalizeJqArithmeticResult,
  toJqArithmeticNumber,
} from './value';

const builtinArities = {
  IN: [1, 2],
  INDEX: [1, 2],
  JOIN: [2, 3, 4],
  '@base64': [0],
  '@base64d': [0],
  '@csv': [0],
  '@html': [0],
  '@json': [0],
  '@sh': [0],
  '@text': [0],
  '@tsv': [0],
  '@uri': [0],
  abs: [0],
  acos: [0],
  acosh: [0],
  add: [0],
  all: [0, 1, 2],
  ascii_downcase: [0],
  ascii_upcase: [0],
  arrays: [0],
  asin: [0],
  asinh: [0],
  atan: [0],
  atanh: [0],
  atan2: [2],
  any: [0, 1, 2],
  booleans: [0],
  bsearch: [1],
  capture: [1, 2],
  cbrt: [0],
  ceil: [0],
  combinations: [0, 1],
  contains: [1],
  copysign: [2],
  cos: [0],
  cosh: [0],
  del: [1],
  delpaths: [1],
  debug: [0, 1],
  drem: [2],
  empty: [0],
  endswith: [1],
  exp: [0],
  exp2: [0],
  exp10: [0],
  expm1: [0],
  error: [0, 1],
  explode: [0],
  first: [0, 1],
  flatten: [0, 1],
  frexp: [0],
  floor: [0],
  fabs: [0],
  fdim: [2],
  fmax: [2],
  fmin: [2],
  fmod: [2],
  finites: [0],
  format: [1],
  fromdate: [0],
  fromdateiso8601: [0],
  from_entries: [0],
  fromjson: [0],
  fromstream: [1],
  getpath: [1],
  gmtime: [0],
  group_by: [1],
  gsub: [2, 3],
  hypot: [2],
  has: [1],
  halt: [0],
  halt_error: [0, 1],
  implode: [0],
  index: [1],
  indices: [1],
  input: [0],
  input_filename: [0],
  input_line_number: [0],
  inputs: [0],
  in: [1],
  infinite: [0],
  inside: [1],
  isfinite: [0],
  isinfinite: [0],
  isnan: [0],
  isnormal: [0],
  isempty: [1],
  iterables: [0],
  join: [1],
  keys: [0],
  keys_unsorted: [0],
  last: [0, 1],
  length: [0],
  ldexp: [2],
  limit: [2],
  log: [0],
  log10: [0],
  log2: [0],
  log1p: [0],
  logb: [0],
  localtime: [0],
  match: [1, 2],
  ltrimstr: [1],
  map: [1],
  map_values: [1],
  mktime: [0],
  modf: [0],
  max: [0],
  max_by: [1],
  min: [0],
  min_by: [1],
  nth: [1, 2],
  nan: [0],
  nearbyint: [0],
  nextafter: [2],
  nexttoward: [2],
  nulls: [0],
  normals: [0],
  not: [0],
  now: [0],
  numbers: [0],
  objects: [0],
  path: [1],
  paths: [0, 1],
  pick: [1],
  pow: [2],
  range: [1, 2, 3],
  remainder: [2],
  recurse: [0, 1, 2],
  repeat: [1],
  reverse: [0],
  rint: [0],
  rindex: [1],
  round: [0],
  scan: [1, 2],
  rtrimstr: [1],
  scalars: [0],
  scalb: [2],
  scalbln: [2],
  select: [1],
  setpath: [2],
  significand: [0],
  sin: [0],
  sinh: [0],
  sort: [0],
  sort_by: [1],
  split: [1, 2],
  splits: [1, 2],
  sqrt: [0],
  sub: [2, 3],
  startswith: [1],
  stderr: [0],
  strftime: [1],
  strptime: [1],
  strings: [0],
  strflocaltime: [1],
  tan: [0],
  tanh: [0],
  to_entries: [0],
  todate: [0],
  todateiso8601: [0],
  tostream: [0],
  test: [1, 2],
  tojson: [0],
  tonumber: [0],
  transpose: [0],
  truncate_stream: [1],
  trunc: [0],
  type: [0],
  until: [2],
  unique: [0],
  unique_by: [1],
  utf8bytelength: [0],
  values: [0],
  tostring: [0],
  walk: [1],
  while: [2],
  with_entries: [1],
} as const satisfies Readonly<Record<JqBuiltinName, readonly number[]>>;

export type JqCompileResult =
  | { ok: true }
  | { ok: false, message: string };

type ValidationTask =
  | {
    readonly kind: 'filter',
    readonly filter: JqFilter,
  }
  | {
    readonly kind: 'path',
    readonly expression: JqPathExpression,
  }
  | {
    readonly kind: 'definition',
    readonly definition: JqUserDefinition,
    readonly args: readonly JqFilter[],
  }
  | {
    readonly kind: 'finish_definition',
    readonly definitionId: number,
  }
  | {
    readonly kind: 'enter_variable',
    readonly name: string,
  }
  | {
    readonly kind: 'leave_variable',
    readonly name: string,
  };

function pushFilterValidationTasks({
  tasks,
  filters,
}: {
  tasks: ValidationTask[],
  filters: readonly JqFilter[],
}): void {
  for (let index = filters.length - 1; index >= 0; index -= 1) {
    const filter = filters[index];
    if (filter === undefined) throw new Error('jq validation child filter is missing');
    tasks.push({ kind: 'filter', filter });
  }
}

function addValidationVariable({
  counts,
  name,
}: {
  counts: Map<string, number>,
  name: string,
}): void {
  counts.set(name, (counts.get(name) ?? 0) + 1);
}

function removeValidationVariable({
  counts,
  name,
}: {
  counts: Map<string, number>,
  name: string,
}): void {
  const count = counts.get(name);
  if (count === undefined) throw new Error(`jq validation variable scope underflow: ${name}`);
  if (count === 1) {
    counts.delete(name);
    return;
  }
  counts.set(name, count - 1);
}
interface JqCompileTimeConstant {
  readonly value: JsonValue,
}

interface JqCompileTimeBudget {
  remaining: number,
}

const JQ_COMPILE_TIME_MAX_ARRAY_ITEMS = 256;

function isJqIdentityFilter({ filter }: { readonly filter: JqFilter }): boolean {
  const pending: JqFilter[] = [filter];
  let visited = 0;
  while (pending.length > 0) {
    if (visited >= 4_096) return false;
    visited += 1;
    const current = pending.pop();
    if (current === undefined) throw new Error('jq identity-filter stack is empty');
    const kind: string = current.kind;
    if (kind === 'identity') continue;
    if (kind === 'pipe') {
      const pipe = current as Extract<JqFilter, { kind: 'pipe' }>;
      pending.push(pipe.right, pipe.left);
      continue;
    }
    if (kind === 'binary') {
      const binary = current as Extract<JqFilter, { kind: 'binary' }>;
      const operator: string = binary.operator;
      if (operator === 'pipe') {
        pending.push(binary.right, binary.left);
        continue;
      }
    }
    return false;
  }
  return true;
}

// Object-key validation may run before runtime only when an expression is
// provably deterministic, input-independent, side-effect-free, and single-output.
// Returning undefined preserves runtime ordering for every uncertain form.
function evaluateJqCompileTimeConstant({
  filter,
  input,
  depth = 0,
  budget = { remaining: 4_096 },
}: {
  readonly filter: JqFilter,
  readonly input?: JqCompileTimeConstant,
  readonly depth?: number,
  readonly budget?: JqCompileTimeBudget,
}): JqCompileTimeConstant | undefined {
  if (depth > 128 || budget.remaining <= 0) return undefined;
  budget.remaining -= 1;
  const evaluate = ({
    child,
    childInput = input,
  }: {
    readonly child: JqFilter,
    readonly childInput?: JqCompileTimeConstant,
  }): JqCompileTimeConstant | undefined => (
    evaluateJqCompileTimeConstant({
      filter: child,
      input: childInput,
      depth: depth + 1,
      budget,
    })
  );

  switch (filter.kind) {
  case 'identity':
    return input;
  case 'literal':
    return { value: filter.value };
  case 'string': {
    let value = '';
    for (const part of filter.parts) {
      switch (part.kind) {
      case 'text':
        value += part.value;
        break;
      case 'interpolation':
        return undefined;
      default: {
        const _ex: never = part;
        throw new Error(`Unhandled jq string part: ${JSON.stringify(_ex)}`);
      }
      }
    }
    return { value };
  }
  case 'array': {
    const value: JsonValue[] = [];
    const pending = [...filter.items].reverse();
    while (pending.length > 0) {
      if (value.length >= JQ_COMPILE_TIME_MAX_ARRAY_ITEMS || budget.remaining <= 0) return undefined;
      const item = pending.pop();
      if (item === undefined) throw new Error('jq compile-time array item stack is empty');
      const itemKind: string = item.kind;
      if (itemKind === 'comma') {
        budget.remaining -= 1;
        const comma = item as Extract<JqFilter, { kind: 'comma' }>;
        pending.push(comma.right, comma.left);
        continue;
      }
      if (itemKind === 'binary') {
        const binary = item as Extract<JqFilter, { kind: 'binary' }>;
        const operator: string = binary.operator;
        if (operator === 'comma') {
          budget.remaining -= 1;
          pending.push(binary.right, binary.left);
          continue;
        }
      }
      const itemValue = evaluate({ child: item });
      if (itemValue === undefined) return undefined;
      value.push(itemValue.value);
    }
    return { value };
  }
  case 'object': {
    const value = createJsonObject();
    for (const entry of filter.entries) {
      const key = (() => {
        switch (entry.key.kind) {
        case 'static':
          return entry.key.value;
        case 'dynamic': {
          const keyValue = evaluate({ child: entry.key.filter });
          return keyValue !== undefined && typeof keyValue.value === 'string'
            ? keyValue.value
            : undefined;
        }
        default: {
          const _ex: never = entry.key;
          throw new Error(`Unhandled jq object key: ${JSON.stringify(_ex)}`);
        }
        }
      })();
      if (key === undefined) return undefined;
      const entryValue = evaluate({ child: entry.value });
      if (entryValue === undefined) return undefined;
      defineJsonProperty({ object: value, key, value: entryValue.value });
    }
    return { value };
  }
  case 'pipe':
    if (isJqIdentityFilter({ filter: filter.left })) return evaluate({ child: filter.right, childInput: input });
    if (isJqIdentityFilter({ filter: filter.right })) return evaluate({ child: filter.left, childInput: input });
    return undefined;
  case 'unary':
    return undefined;
  case 'binary': {
    const operator = filter.operator;
    switch (operator) {
    case 'pipe':
      if (isJqIdentityFilter({ filter: filter.left })) return evaluate({ child: filter.right, childInput: input });
      if (isJqIdentityFilter({ filter: filter.right })) return evaluate({ child: filter.left, childInput: input });
      return undefined;
    case 'comma':
    case 'alternative':
    case 'or':
    case 'and':
      return undefined;
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
      break;
    default: {
      const _ex: never = operator;
      throw new Error(`Unhandled jq compile-time binary operator: ${_ex}`);
    }
    }
    const left = evaluate({ child: filter.left });
    const right = evaluate({ child: filter.right });
    if (left === undefined || right === undefined) return undefined;
    switch (operator) {
    case 'eq':
      return { value: jsonValuesEqual({ left: left.value, right: right.value }) };
    case 'ne':
      return { value: !jsonValuesEqual({ left: left.value, right: right.value }) };
    case 'lt':
      return { value: compareJsonValues({ left: left.value, right: right.value }) < 0 };
    case 'le':
      return { value: compareJsonValues({ left: left.value, right: right.value }) <= 0 };
    case 'gt':
      return { value: compareJsonValues({ left: left.value, right: right.value }) > 0 };
    case 'ge':
      return { value: compareJsonValues({ left: left.value, right: right.value }) >= 0 };
    case 'add':
      if (left.value === null) return right;
      if (right.value === null) return left;
      if (typeof left.value === 'number' && typeof right.value === 'number') {
        return { value: normalizeJqArithmeticResult({
          value: toJqArithmeticNumber({ value: left.value }) + toJqArithmeticNumber({ value: right.value }),
        }) };
      }
      if (typeof left.value === 'string' && typeof right.value === 'string') {
        return { value: `${left.value}${right.value}` };
      }
      if (Array.isArray(left.value) && Array.isArray(right.value)) {
        return { value: [...left.value, ...right.value] };
      }
      if (isJsonObject(left.value) && isJsonObject(right.value)) {
        return { value: mergeJsonObjects({ left: left.value, right: right.value }) };
      }
      return undefined;
    case 'sub':
      return typeof left.value === 'number' && typeof right.value === 'number'
        ? { value: normalizeJqArithmeticResult({
          value: toJqArithmeticNumber({ value: left.value }) - toJqArithmeticNumber({ value: right.value }),
        }) }
        : undefined;
    case 'mul':
      return typeof left.value === 'number' && typeof right.value === 'number'
        ? { value: normalizeJqArithmeticResult({
          value: toJqArithmeticNumber({ value: left.value }) * toJqArithmeticNumber({ value: right.value }),
        }) }
        : undefined;
    case 'div':
      return typeof left.value === 'number' && typeof right.value === 'number' && right.value !== 0
        ? { value: normalizeJqArithmeticResult({
          value: toJqArithmeticNumber({ value: left.value }) / toJqArithmeticNumber({ value: right.value }),
        }) }
        : undefined;
    case 'mod':
      return typeof left.value === 'number' && typeof right.value === 'number' && right.value !== 0
        ? { value: normalizeJqArithmeticResult({
          value: toJqArithmeticNumber({ value: left.value }) % toJqArithmeticNumber({ value: right.value }),
        }) }
        : undefined;
    default: {
      const _ex: never = operator;
      throw new Error(`Unhandled jq compile-time binary operator: ${_ex}`);
    }
    }
  }
  default:
    return undefined;
  }
}

function validateFilter({
  filter,
  variables,
  definitions,
}: {
  filter: JqFilter,
  variables: ReadonlySet<string>,
  definitions: ReadonlyMap<number, JqUserDefinition>,
}): string | undefined {
  const tasks: ValidationTask[] = [{ kind: 'filter', filter }];
  const variableCounts = new Map<string, number>();
  for (const name of variables) {
    addValidationVariable({ counts: variableCounts, name });
  }

  const activeDefinitionIds = new Set<number>();
  const validatedDefinitionIds = new Set<number>();

  while (tasks.length > 0) {
    const task = tasks.pop();
    if (task === undefined) {
      throw new Error('jq validation task stack is empty');
    }

    switch (task.kind) {
    case 'definition': {
      if (
        activeDefinitionIds.has(task.definition.id)
          || validatedDefinitionIds.has(task.definition.id)
      ) {
        break;
      }

      activeDefinitionIds.add(task.definition.id);
      tasks.push({
        kind: 'finish_definition',
        definitionId: task.definition.id,
      });
      tasks.push({
        kind: 'filter',
        filter: instantiateJqUserDefinition({
          definition: task.definition,
          args: task.args,
        }),
      });
      break;
    }
    case 'finish_definition':
      activeDefinitionIds.delete(task.definitionId);
      validatedDefinitionIds.add(task.definitionId);
      break;
    case 'enter_variable':
      addValidationVariable({ counts: variableCounts, name: task.name });
      break;
    case 'leave_variable':
      removeValidationVariable({ counts: variableCounts, name: task.name });
      break;
    case 'path': {
      const expression = task.expression;
      switch (expression.kind) {
      case 'path':
        break;
      case 'sequence':
        for (let index = expression.items.length - 1; index >= 0; index -= 1) {
          const item = expression.items[index];
          if (item === undefined) {
            throw new Error('jq path validation child is missing');
          }
          tasks.push({ kind: 'path', expression: item });
        }
        break;
      case 'append':
      case 'iterate':
        tasks.push({ kind: 'path', expression: expression.parent });
        break;
      case 'dynamic_index':
        tasks.push({ kind: 'filter', filter: expression.index });
        tasks.push({ kind: 'path', expression: expression.parent });
        break;
      case 'dynamic_slice':
        if (expression.end !== undefined) {
          tasks.push({ kind: 'filter', filter: expression.end });
        }
        if (expression.start !== undefined) {
          tasks.push({ kind: 'filter', filter: expression.start });
        }
        tasks.push({ kind: 'path', expression: expression.parent });
        break;
      default: {
        const _ex: never = expression;
        return `unsupported jq path expression: ${JSON.stringify(_ex)}`;
      }
      }
      break;
    }
    case 'filter': {
      const current = task.filter;
      switch (current.kind) {
      case 'identity':
      case 'literal':
        break;
      case 'variable':
        if (!variableCounts.has(current.name)) {
          return `$${current.name} is not defined`;
        }
        break;
      case 'string': {
        const children: JqFilter[] = [];
        for (const part of current.parts) {
          switch (part.kind) {
          case 'text':
            break;
          case 'interpolation':
            children.push(part.filter);
            break;
          default: {
            const _ex: never = part;
            throw new Error(`Unhandled jq string part: ${JSON.stringify(_ex)}`);
          }
          }
        }
        pushFilterValidationTasks({ tasks, filters: children });
        break;
      }
      case 'array':
        pushFilterValidationTasks({ tasks, filters: current.items });
        break;
      case 'object': {
        const children: JqFilter[] = [];
        for (const entry of current.entries) {
          switch (entry.key.kind) {
          case 'static':
            break;
          case 'dynamic': {
            const compileTimeKey = evaluateJqCompileTimeConstant({
              filter: entry.key.filter,
            });
            if (compileTimeKey !== undefined && typeof compileTimeKey.value !== 'string') {
              return formatJqObjectKeyError({ key: compileTimeKey.value });
            }
            children.push(entry.key.filter);
            break;
          }
          default: {
            const _ex: never = entry.key;
            throw new Error(`Unhandled jq object key: ${JSON.stringify(_ex)}`);
          }
          }
          children.push(entry.value);
        }
        pushFilterValidationTasks({ tasks, filters: children });
        break;
      }
      case 'field':
      case 'index':
      case 'iterate':
      case 'recursive_descent':
        tasks.push({ kind: 'filter', filter: current.input });
        break;
      case 'dynamic_index':
        pushFilterValidationTasks({
          tasks,
          filters: [current.input, current.index],
        });
        break;
      case 'slice': {
        const children = [current.input];
        if (current.start !== undefined) {
          children.push(current.start);
        }
        if (current.end !== undefined) {
          children.push(current.end);
        }
        pushFilterValidationTasks({ tasks, filters: children });
        break;
      }
      case 'optional':
        tasks.push({ kind: 'filter', filter: current.body });
        break;
      case 'pipe':
      case 'comma':
      case 'binary':
        pushFilterValidationTasks({
          tasks,
          filters: [current.left, current.right],
        });
        break;
      case 'conditional':
        pushFilterValidationTasks({
          tasks,
          filters: [current.condition, current.thenBranch, current.elseBranch],
        });
        break;
      case 'trycatch':
        pushFilterValidationTasks({
          tasks,
          filters: [current.body, current.catchBranch],
        });
        break;
      case 'call': {
        const arities = builtinArities[current.name];
        if (!arities.some((arity) => arity === current.args.length)) {
          return `${current.name}/${current.args.length} is not defined`;
        }
        pushFilterValidationTasks({ tasks, filters: current.args });
        break;
      }
      case 'user_call': {
        const definition = definitions.get(current.definitionId);
        if (definition === undefined) {
          return `user-defined filter id ${current.definitionId} is not registered`;
        }
        if (
          !activeDefinitionIds.has(current.definitionId)
              && !validatedDefinitionIds.has(current.definitionId)
        ) {
          tasks.push({
            kind: 'definition',
            definition,
            args: current.args,
          });
        }
        pushFilterValidationTasks({ tasks, filters: current.args });
        break;
      }
      case 'unresolved_user_call':
        return `${current.name}/${current.args.length} is not defined`;
      case 'break':
        break;
      case 'label':
        tasks.push({ kind: 'filter', filter: current.body });
        break;
      case 'unary':
        tasks.push({ kind: 'filter', filter: current.value });
        break;
      case 'bind':
        tasks.push({ kind: 'leave_variable', name: current.name });
        tasks.push({ kind: 'filter', filter: current.body });
        tasks.push({ kind: 'enter_variable', name: current.name });
        tasks.push({ kind: 'filter', filter: current.binding });
        break;
      case 'reduce':
        tasks.push({ kind: 'leave_variable', name: current.name });
        tasks.push({ kind: 'filter', filter: current.update });
        tasks.push({ kind: 'enter_variable', name: current.name });
        tasks.push({ kind: 'filter', filter: current.initial });
        tasks.push({ kind: 'filter', filter: current.generator });
        break;
      case 'foreach':
        tasks.push({ kind: 'leave_variable', name: current.name });
        tasks.push({ kind: 'filter', filter: current.extract });
        tasks.push({ kind: 'filter', filter: current.update });
        tasks.push({ kind: 'enter_variable', name: current.name });
        tasks.push({ kind: 'filter', filter: current.initial });
        tasks.push({ kind: 'filter', filter: current.generator });
        break;
      case 'assign':
      case 'update':
        tasks.push({ kind: 'filter', filter: current.value });
        tasks.push({ kind: 'path', expression: current.pathExpression });
        break;
      default: {
        const _ex: never = current;
        return `unsupported jq filter: ${JSON.stringify(_ex)}`;
      }
      }
      break;
    }
    default: {
      const _ex: never = task;
      throw new Error(`Unhandled jq validation task: ${JSON.stringify(_ex)}`);
    }
    }
  }

  return undefined;
}

export function validateJqProgram({
  program,
  variables,
}: {
  program: JqProgram,
  variables: readonly string[],
}): JqCompileResult {
  const message = validateFilter({
    filter: program.filter,
    variables: new Set(variables),
    definitions: new Map(program.userDefinitions.map((definition) => [definition.id, definition])),
  });
  return message === undefined ? { ok: true } : { ok: false, message };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
