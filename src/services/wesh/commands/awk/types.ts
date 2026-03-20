export type AwkValue = string | number | RegExp;

export interface AwkProgram {
  rules: AwkRule[];
}

export interface AwkRule {
  pattern: AwkPattern;
  statements: AwkStatement[];
}

export type AwkPattern =
  | { kind: 'begin' }
  | { kind: 'end' }
  | { kind: 'always' }
  | { kind: 'expression'; expression: AwkExpression };

export type AwkStatement =
  | { kind: 'print'; expressions: AwkExpression[] }
  | { kind: 'assign'; name: string; expression: AwkExpression }
  | { kind: 'expression'; expression: AwkExpression }
  | { kind: 'if'; condition: AwkExpression; thenStatements: AwkStatement[]; elseStatements: AwkStatement[] | undefined }
  | { kind: 'next' };

export type AwkExpression =
  | { kind: 'number'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'regex'; value: RegExp }
  | { kind: 'identifier'; name: string }
  | { kind: 'field'; index: number }
  | { kind: 'binary'; operator: AwkBinaryOperator; left: AwkExpression; right: AwkExpression }
  | { kind: 'unary'; operator: AwkUnaryOperator; expression: AwkExpression };

export type AwkBinaryOperator =
  | 'concat'
  | '||'
  | '&&'
  | '+'
  | '-'
  | '*'
  | '=='
  | '!='
  | '<'
  | '<='
  | '>'
  | '>='
  | '~'
  | '!~';

export type AwkUnaryOperator = '!';

export type AwkToken =
  | { kind: 'identifier'; value: string }
  | { kind: 'number'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'regex'; value: string }
  | { kind: 'field'; value: number }
  | { kind: 'operator'; value: string }
  | { kind: 'punctuation'; value: '{' | '}' | '(' | ')' | ',' | ';' }
  | { kind: 'newline' }
  | { kind: 'eof' };
