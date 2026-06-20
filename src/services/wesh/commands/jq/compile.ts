import type { JqBuiltinName, JqFilter, JqProgram } from './ast';

const builtinArities = {
  abs: [0],
  add: [0],
  all: [0, 1],
  ascii_downcase: [0],
  ascii_upcase: [0],
  arrays: [0],
  any: [0, 1],
  booleans: [0],
  bsearch: [1],
  ceil: [0],
  combinations: [0, 1],
  contains: [1],
  del: [1],
  delpaths: [1],
  empty: [0],
  endswith: [1],
  error: [0, 1],
  explode: [0],
  first: [0, 1],
  flatten: [0],
  floor: [0],
  from_entries: [0],
  fromjson: [0],
  getpath: [1],
  group_by: [1],
  has: [1],
  implode: [0],
  index: [1],
  indices: [1],
  inside: [1],
  isempty: [1],
  join: [1],
  keys: [0],
  keys_unsorted: [0],
  last: [0, 1],
  length: [0],
  limit: [2],
  log: [0],
  log10: [0],
  log2: [0],
  ltrimstr: [1],
  map: [1],
  map_values: [1],
  max: [0],
  max_by: [1],
  min: [0],
  min_by: [1],
  nth: [2],
  nulls: [0],
  numbers: [0],
  objects: [0],
  path: [1],
  paths: [0],
  pick: [1],
  pow: [2],
  range: [1, 2, 3],
  recurse: [0, 1],
  reverse: [0],
  rindex: [1],
  round: [0],
  rtrimstr: [1],
  scalars: [0],
  select: [1],
  setpath: [2],
  sort: [0],
  sort_by: [1],
  split: [1],
  sqrt: [0],
  startswith: [1],
  strings: [0],
  to_entries: [0],
  tojson: [0],
  tonumber: [0],
  transpose: [0],
  type: [0],
  unique: [0],
  unique_by: [1],
  utf8bytelength: [0],
  values: [0],
  tostring: [0],
  walk: [1],
  with_entries: [1],
} as const satisfies Readonly<Record<JqBuiltinName, readonly number[]>>;

export type JqCompileResult =
  | { ok: true }
  | { ok: false; message: string };

function validateChildren({
  children,
  variables,
}: {
  children: readonly JqFilter[];
  variables: ReadonlySet<string>;
}): string | undefined {
  for (const child of children) {
    const message = validateFilter({ filter: child, variables });
    if (message !== undefined) return message;
  }
  return undefined;
}

function validateFilter({
  filter,
  variables,
}: {
  filter: JqFilter;
  variables: ReadonlySet<string>;
}): string | undefined {
  switch (filter.kind) {
  case 'identity':
  case 'literal':
    return undefined;
  case 'variable':
    return variables.has(filter.name) ? undefined : `$${filter.name} is not defined`;
  case 'string': {
    const children: JqFilter[] = [];
    for (const part of filter.parts) {
      switch (part.kind) {
      case 'text':
        break;
      case 'interpolation':
        children.push(part.filter);
        break;
      default: {
        const _ex: never = part;
        throw new Error(`Unhandled jq string part: ${((_ex satisfies never) as { readonly kind: string }).kind}`);
      }
      }
    }
    return validateChildren({ children, variables });
  }
  case 'array':
    return validateChildren({ children: filter.items, variables });
  case 'object': {
    const children: JqFilter[] = [];
    for (const entry of filter.entries) {
      switch (entry.key.kind) {
      case 'static':
        break;
      case 'dynamic':
        children.push(entry.key.filter);
        break;
      default: {
        const _ex: never = entry.key;
        throw new Error(`Unhandled jq object key: ${((_ex satisfies never) as { readonly kind: string }).kind}`);
      }
      }
      children.push(entry.value);
    }
    return validateChildren({ children, variables });
  }
  case 'field':
  case 'index':
  case 'iterate':
  case 'recursive_descent':
    return validateFilter({ filter: filter.input, variables });
  case 'dynamic_index':
    return validateChildren({ children: [filter.input, filter.index], variables });
  case 'slice':
    return validateChildren({
      children: [filter.input, ...(filter.start === undefined ? [] : [filter.start]), ...(filter.end === undefined ? [] : [filter.end])],
      variables,
    });
  case 'optional':
    return validateFilter({ filter: filter.body, variables });
  case 'pipe':
  case 'comma':
  case 'binary':
    return validateChildren({ children: [filter.left, filter.right], variables });
  case 'conditional':
    return validateChildren({
      children: [filter.condition, filter.thenBranch, filter.elseBranch],
      variables,
    });
  case 'trycatch':
    return validateChildren({ children: [filter.body, filter.catchBranch], variables });
  case 'call': {
    const arities = builtinArities[filter.name];
    if (!arities.some((arity) => arity === filter.args.length)) {
      return `${filter.name}/${filter.args.length} is not defined`;
    }
    return validateChildren({ children: filter.args, variables });
  }
  case 'unary':
    return validateFilter({ filter: filter.value, variables });
  case 'bind': {
    const bindingMessage = validateFilter({ filter: filter.binding, variables });
    if (bindingMessage !== undefined) return bindingMessage;
    const bodyVariables = new Set(variables);
    bodyVariables.add(filter.name);
    return validateFilter({ filter: filter.body, variables: bodyVariables });
  }
  case 'assign':
  case 'update':
    return validateFilter({ filter: filter.value, variables });
  default: {
    const _ex: never = filter;
    return `unsupported jq filter: ${JSON.stringify(_ex)}`;
  }
  }
}

export function validateJqProgram({
  program,
  variables,
}: {
  program: JqProgram;
  variables: readonly string[];
}): JqCompileResult {
  const message = validateFilter({
    filter: program.filter,
    variables: new Set(variables),
  });
  return message === undefined ? { ok: true } : { ok: false, message };
}
