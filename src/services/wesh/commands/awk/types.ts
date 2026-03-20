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
  | { kind: 'assign'; target: AwkAssignmentTarget; expression: AwkExpression }
  | { kind: 'expression'; expression: AwkExpression }
  | { kind: 'if'; condition: AwkExpression; thenStatements: AwkStatement[]; elseStatements: AwkStatement[] | undefined }
  | { kind: 'next' };

export type AwkAssignmentTarget =
  | { kind: 'variable'; name: string }
  | { kind: 'indexed'; name: string; index: AwkExpression };

export type AwkExpression =
  | { kind: 'number'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'regex'; value: RegExp }
  | { kind: 'identifier'; name: string }
  | { kind: 'indexed'; name: string; index: AwkExpression }
  | { kind: 'field'; index: number }
  | { kind: 'binary'; operator: AwkBinaryOperator; left: AwkExpression; right: AwkExpression }
  | { kind: 'unary'; operator: AwkUnaryOperator; expression: AwkExpression }
  | { kind: 'call'; callee: string; args: AwkExpression[] }
  | { kind: 'update'; target: AwkAssignmentTarget; operator: AwkUpdateOperator; position: AwkUpdatePosition };

export type AwkBinaryOperator =
  | 'concat'
  | '||'
  | '&&'
  | 'in'
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

export type AwkUpdateOperator = '++' | '--';

export type AwkUpdatePosition = 'prefix' | 'postfix';

export type AwkToken =
  | { kind: 'identifier'; value: string }
  | { kind: 'number'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'regex'; value: string }
  | { kind: 'field'; value: number }
  | { kind: 'operator'; value: string }
  | { kind: 'punctuation'; value: '{' | '}' | '(' | ')' | '[' | ']' | ',' | ';' }
  | { kind: 'newline' }
  | { kind: 'eof' };
