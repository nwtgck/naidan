import type { JqNumberOrigin } from './number-origin';

export type JsonPrimitive = null | boolean | number | string;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export interface JqProgram {
  filter: JqFilter,
  userDefinitions: readonly JqUserDefinition[],
}

export type JqUserParameter =
  | { kind: 'value', name: string }
  | { kind: 'filter', name: string };

export interface JqUserDefinition {
  readonly id: number,
  readonly name: string,
  readonly parameters: readonly JqUserParameter[],
  readonly body: JqFilter,
}

export type JqStringPart =
  | { kind: 'text', value: string }
  | { kind: 'interpolation', filter: JqFilter };

export type JqObjectKey =
  | { kind: 'static', value: string }
  | { kind: 'dynamic', filter: JqFilter };

export type JqCompoundAssignmentOperator =
  | 'alternative'
  | 'add'
  | 'sub'
  | 'mul'
  | 'div'
  | 'mod';

export type JqUpdateMode =
  | { kind: 'first' }
  | { kind: 'compound', operator: JqCompoundAssignmentOperator };

export type JqFilter =
  | { kind: 'identity' }
  | { kind: 'variable', name: string }
  | { kind: 'literal', value: JsonValue, numberOrigin?: JqNumberOrigin }
  | { kind: 'string', parts: JqStringPart[] }
  | { kind: 'array', items: JqFilter[] }
  | { kind: 'object', entries: JqObjectEntry[] }
  | { kind: 'field', input: JqFilter, key: string, optional: boolean }
  | { kind: 'index', input: JqFilter, index: number, optional: boolean }
  | { kind: 'dynamic_index', input: JqFilter, index: JqFilter, optional: boolean }
  | {
    kind: 'slice',
    input: JqFilter,
    start: JqFilter | undefined,
    end: JqFilter | undefined,
    optional: boolean,
  }
  | { kind: 'iterate', input: JqFilter, optional: boolean }
  | { kind: 'recursive_descent', input: JqFilter }
  | { kind: 'optional', body: JqFilter }
  | { kind: 'pipe', left: JqFilter, right: JqFilter }
  | { kind: 'comma', left: JqFilter, right: JqFilter }
  | { kind: 'conditional', condition: JqFilter, thenBranch: JqFilter, elseBranch: JqFilter }
  | { kind: 'trycatch', body: JqFilter, catchBranch: JqFilter }
  | { kind: 'call', name: JqBuiltinName, args: JqFilter[] }
  | { kind: 'user_call', definitionId: number, args: JqFilter[] }
  | { kind: 'unresolved_user_call', name: string, args: JqFilter[] }
  | { kind: 'binary', operator: JqBinaryOperator, left: JqFilter, right: JqFilter }
  | { kind: 'unary', operator: JqUnaryOperator, value: JqFilter }
  | { kind: 'bind', binding: JqFilter, name: string, body: JqFilter }
  | { kind: 'label', id: number, name: string, body: JqFilter }
  | { kind: 'break', id: number, name: string }
  | { kind: 'reduce', generator: JqFilter, name: string, initial: JqFilter, update: JqFilter }
  | { kind: 'foreach', generator: JqFilter, name: string, initial: JqFilter, update: JqFilter, extract: JqFilter }
  | { kind: 'assign', pathExpression: JqPathExpression, value: JqFilter }
  | {
    kind: 'update',
    pathExpression: JqPathExpression,
    value: JqFilter,
    mode: JqUpdateMode,
  };

export interface JqObjectEntry {
  key: JqObjectKey,
  value: JqFilter,
}


export type JqPathExpression =
  | { kind: 'path', path: JqPath }
  | { kind: 'sequence', items: JqPathExpression[] }
  | { kind: 'append', parent: JqPathExpression, segment: JqPathSegment }
  | { kind: 'dynamic_index', parent: JqPathExpression, index: JqFilter, optional: boolean }
  | {
    kind: 'dynamic_slice',
    parent: JqPathExpression,
    start: JqFilter | undefined,
    end: JqFilter | undefined,
    optional: boolean,
  }
  | { kind: 'iterate', parent: JqPathExpression, optional: boolean };

export interface JqPath {
  segments: JqPathSegment[],
}

export type JqPathSegment =
  | { kind: 'field', key: string, optional: boolean }
  | { kind: 'index', index: number, optional: boolean }
  | { kind: 'slice', start: number | undefined, end: number | undefined, optional: boolean };

export type JqBuiltinName =
  | 'IN'
  | 'INDEX'
  | 'JOIN'
  | '@base64'
  | '@base64d'
  | '@csv'
  | '@html'
  | '@json'
  | '@sh'
  | '@text'
  | '@tsv'
  | '@uri'
  | 'abs'
  | 'acos'
  | 'acosh'
  | 'add'
  | 'all'
  | 'ascii_downcase'
  | 'ascii_upcase'
  | 'arrays'
  | 'asin'
  | 'asinh'
  | 'atan'
  | 'atanh'
  | 'atan2'
  | 'any'
  | 'booleans'
  | 'bsearch'
  | 'capture'
  | 'cbrt'
  | 'ceil'
  | 'combinations'
  | 'contains'
  | 'copysign'
  | 'cos'
  | 'cosh'
  | 'del'
  | 'delpaths'
  | 'debug'
  | 'drem'
  | 'empty'
  | 'endswith'
  | 'exp'
  | 'exp2'
  | 'exp10'
  | 'expm1'
  | 'error'
  | 'explode'
  | 'first'
  | 'flatten'
  | 'frexp'
  | 'floor'
  | 'fabs'
  | 'fdim'
  | 'fmax'
  | 'fmin'
  | 'fmod'
  | 'finites'
  | 'format'
  | 'fromdate'
  | 'fromdateiso8601'
  | 'from_entries'
  | 'fromjson'
  | 'fromstream'
  | 'getpath'
  | 'gmtime'
  | 'group_by'
  | 'gsub'
  | 'hypot'
  | 'has'
  | 'halt'
  | 'halt_error'
  | 'implode'
  | 'index'
  | 'indices'
  | 'input'
  | 'input_filename'
  | 'input_line_number'
  | 'inputs'
  | 'inside'
  | 'isfinite'
  | 'isinfinite'
  | 'isnan'
  | 'isnormal'
  | 'in'
  | 'infinite'
  | 'isempty'
  | 'iterables'
  | 'join'
  | 'keys'
  | 'keys_unsorted'
  | 'last'
  | 'length'
  | 'ldexp'
  | 'limit'
  | 'log'
  | 'log10'
  | 'log2'
  | 'log1p'
  | 'logb'
  | 'localtime'
  | 'match'
  | 'ltrimstr'
  | 'map'
  | 'map_values'
  | 'mktime'
  | 'modf'
  | 'max'
  | 'max_by'
  | 'min'
  | 'min_by'
  | 'nth'
  | 'nan'
  | 'nearbyint'
  | 'nextafter'
  | 'nexttoward'
  | 'nulls'
  | 'normals'
  | 'not'
  | 'now'
  | 'numbers'
  | 'objects'
  | 'path'
  | 'paths'
  | 'pick'
  | 'pow'
  | 'range'
  | 'remainder'
  | 'recurse'
  | 'repeat'
  | 'reverse'
  | 'rint'
  | 'rindex'
  | 'round'
  | 'scan'
  | 'rtrimstr'
  | 'scalars'
  | 'scalb'
  | 'scalbln'
  | 'select'
  | 'setpath'
  | 'significand'
  | 'sin'
  | 'sinh'
  | 'sort'
  | 'sort_by'
  | 'split'
  | 'splits'
  | 'sqrt'
  | 'startswith'
  | 'stderr'
  | 'strftime'
  | 'strptime'
  | 'strings'
  | 'strflocaltime'
  | 'tan'
  | 'tanh'
  | 'sub'
  | 'to_entries'
  | 'todate'
  | 'todateiso8601'
  | 'tostream'
  | 'test'
  | 'tojson'
  | 'tonumber'
  | 'transpose'
  | 'truncate_stream'
  | 'trunc'
  | 'type'
  | 'until'
  | 'unique'
  | 'unique_by'
  | 'utf8bytelength'
  | 'values'
  | 'tostring'
  | 'walk'
  | 'while'
  | 'with_entries';

export type JqBinaryOperator =
  | 'pipe'
  | 'comma'
  | 'alternative'
  | 'or'
  | 'and'
  | 'eq'
  | 'ne'
  | 'lt'
  | 'le'
  | 'gt'
  | 'ge'
  | 'add'
  | 'sub'
  | 'mul'
  | 'div'
  | 'mod';

export type JqUnaryOperator = 'not' | 'neg';

export type JqStringTokenPart =
  | { kind: 'text', value: string }
  | { kind: 'interpolation', source: string };

export type JqToken =
  | { kind: 'dot' }
  | { kind: 'recursive_descent' }
  | { kind: 'identifier', value: string }
  | { kind: 'variable', value: string }
  | { kind: 'number', value: number, origin: JqNumberOrigin }
  | { kind: 'string', parts: JqStringTokenPart[] }
  | {
    kind: 'keyword',
    value:
      | 'true'
      | 'false'
      | 'null'
      | 'and'
      | 'or'
      | 'not'
      | 'if'
      | 'then'
      | 'elif'
      | 'else'
      | 'end'
      | 'try'
      | 'catch'
      | 'def'
      | 'reduce'
      | 'foreach'
      | 'as',
  }
  | {
    kind: 'operator',
    value:
      | '|'
      | '//'
      | ','
      | '=='
      | '!='
      | '<'
      | '<='
      | '>'
      | '>='
      | '='
      | '|='
      | '+='
      | '-='
      | '*='
      | '/='
      | '%='
      | '//='
      | '+'
      | '-'
      | '*'
      | '/'
      | '%'
      | ':'
      | '?',
  }
  | { kind: 'punctuation', value: '[' | ']' | '{' | '}' | '(' | ')' | ';' }
  | { kind: 'eof' };

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
