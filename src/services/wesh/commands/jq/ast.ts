export type JsonPrimitive = null | boolean | number | string;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export interface JqProgram {
  filter: JqFilter;
}

export type JqFilter =
  | { kind: 'identity' }
  | { kind: 'literal'; value: JsonValue }
  | { kind: 'array'; items: JqFilter[] }
  | { kind: 'object'; entries: JqObjectEntry[] }
  | { kind: 'field'; input: JqFilter; key: string; optional: boolean }
  | { kind: 'index'; input: JqFilter; index: number; optional: boolean }
  | { kind: 'iterate'; input: JqFilter; optional: boolean }
  | { kind: 'pipe'; left: JqFilter; right: JqFilter }
  | { kind: 'comma'; left: JqFilter; right: JqFilter }
  | { kind: 'conditional'; condition: JqFilter; thenBranch: JqFilter; elseBranch: JqFilter }
  | { kind: 'call'; name: JqBuiltinName; args: JqFilter[] }
  | { kind: 'binary'; operator: JqBinaryOperator; left: JqFilter; right: JqFilter }
  | { kind: 'unary'; operator: JqUnaryOperator; value: JqFilter }
  | { kind: 'assign'; path: JqPath; value: JqFilter }
  | { kind: 'update'; path: JqPath; value: JqFilter };

export interface JqObjectEntry {
  key: string;
  value: JqFilter;
}

export interface JqPath {
  segments: JqPathSegment[];
}

export type JqPathSegment =
  | { kind: 'field'; key: string }
  | { kind: 'index'; index: number };

export type JqBuiltinName =
  | 'all'
  | 'any'
  | 'contains'
  | 'del'
  | 'empty'
  | 'fromjson'
  | 'select'
  | 'map'
  | 'length'
  | 'keys'
  | 'keys_unsorted'
  | 'reverse'
  | 'sort'
  | 'startswith'
  | 'type'
  | 'endswith'
  | 'has'
  | 'tojson'
  | 'values'
  | 'tostring';

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
  | 'div';

export type JqUnaryOperator = 'not' | 'neg';

export type JqToken =
  | { kind: 'dot' }
  | { kind: 'identifier'; value: string }
  | { kind: 'number'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'keyword'; value: 'true' | 'false' | 'null' | 'and' | 'or' | 'not' | 'if' | 'then' | 'else' | 'end' }
  | { kind: 'operator'; value: '|' | '//' | ',' | '==' | '!=' | '<' | '<=' | '>' | '>=' | '=' | '|=' | '+' | '-' | '*' | '/' | ':' | '?' }
  | { kind: 'punctuation'; value: '[' | ']' | '{' | '}' | '(' | ')' }
  | { kind: 'eof' };
