export type JsonPrimitive = null | boolean | number | string;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export interface JqProgram {
  filter: JqFilter;
}

export type JqStringPart =
  | { kind: 'text'; value: string }
  | { kind: 'interpolation'; filter: JqFilter };

export type JqObjectKey =
  | { kind: 'static'; value: string }
  | { kind: 'dynamic'; filter: JqFilter };

export type JqFilter =
  | { kind: 'identity' }
  | { kind: 'variable'; name: string }
  | { kind: 'literal'; value: JsonValue }
  | { kind: 'string'; parts: JqStringPart[] }
  | { kind: 'array'; items: JqFilter[] }
  | { kind: 'object'; entries: JqObjectEntry[] }
  | { kind: 'field'; input: JqFilter; key: string; optional: boolean }
  | { kind: 'index'; input: JqFilter; index: number; optional: boolean }
  | { kind: 'dynamic_index'; input: JqFilter; index: JqFilter; optional: boolean }
  | {
    kind: 'slice';
    input: JqFilter;
    start: JqFilter | undefined;
    end: JqFilter | undefined;
    optional: boolean;
  }
  | { kind: 'iterate'; input: JqFilter; optional: boolean }
  | { kind: 'recursive_descent'; input: JqFilter }
  | { kind: 'optional'; body: JqFilter }
  | { kind: 'pipe'; left: JqFilter; right: JqFilter }
  | { kind: 'comma'; left: JqFilter; right: JqFilter }
  | { kind: 'conditional'; condition: JqFilter; thenBranch: JqFilter; elseBranch: JqFilter }
  | { kind: 'trycatch'; body: JqFilter; catchBranch: JqFilter }
  | { kind: 'call'; name: JqBuiltinName; args: JqFilter[] }
  | { kind: 'binary'; operator: JqBinaryOperator; left: JqFilter; right: JqFilter }
  | { kind: 'unary'; operator: JqUnaryOperator; value: JqFilter }
  | { kind: 'bind'; binding: JqFilter; name: string; body: JqFilter }
  | { kind: 'assign'; path: JqPath; value: JqFilter }
  | { kind: 'update'; path: JqPath; value: JqFilter };

export interface JqObjectEntry {
  key: JqObjectKey;
  value: JqFilter;
}

export interface JqPath {
  segments: JqPathSegment[];
}

export type JqPathSegment =
  | { kind: 'field'; key: string }
  | { kind: 'index'; index: number };

export type JqBuiltinName =
  | 'abs'
  | 'add'
  | 'all'
  | 'ascii_downcase'
  | 'ascii_upcase'
  | 'arrays'
  | 'any'
  | 'booleans'
  | 'bsearch'
  | 'ceil'
  | 'combinations'
  | 'contains'
  | 'del'
  | 'delpaths'
  | 'empty'
  | 'endswith'
  | 'error'
  | 'explode'
  | 'first'
  | 'flatten'
  | 'floor'
  | 'from_entries'
  | 'fromjson'
  | 'getpath'
  | 'group_by'
  | 'has'
  | 'implode'
  | 'index'
  | 'indices'
  | 'inside'
  | 'isempty'
  | 'join'
  | 'keys'
  | 'keys_unsorted'
  | 'last'
  | 'length'
  | 'limit'
  | 'log'
  | 'log10'
  | 'log2'
  | 'ltrimstr'
  | 'map'
  | 'map_values'
  | 'max'
  | 'max_by'
  | 'min'
  | 'min_by'
  | 'nth'
  | 'nulls'
  | 'numbers'
  | 'objects'
  | 'path'
  | 'paths'
  | 'pick'
  | 'pow'
  | 'range'
  | 'recurse'
  | 'reverse'
  | 'rindex'
  | 'round'
  | 'rtrimstr'
  | 'scalars'
  | 'select'
  | 'setpath'
  | 'sort'
  | 'sort_by'
  | 'split'
  | 'sqrt'
  | 'startswith'
  | 'strings'
  | 'to_entries'
  | 'tojson'
  | 'tonumber'
  | 'transpose'
  | 'type'
  | 'unique'
  | 'unique_by'
  | 'utf8bytelength'
  | 'values'
  | 'tostring'
  | 'walk'
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
  | { kind: 'text'; value: string }
  | { kind: 'interpolation'; source: string };

export type JqToken =
  | { kind: 'dot' }
  | { kind: 'recursive_descent' }
  | { kind: 'identifier'; value: string }
  | { kind: 'variable'; value: string }
  | { kind: 'number'; value: number }
  | { kind: 'string'; parts: JqStringTokenPart[] }
  | {
    kind: 'keyword';
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
      | 'as';
  }
  | {
    kind: 'operator';
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
      | '?';
  }
  | { kind: 'punctuation'; value: '[' | ']' | '{' | '}' | '(' | ')' | ';' }
  | { kind: 'eof' };
