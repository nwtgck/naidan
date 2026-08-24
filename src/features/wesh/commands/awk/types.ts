export interface AwkNumericString {
  kind: 'numeric-string',
  text: string,
  numberValue: number,
}

export type AwkValue = string | number | RegExp | AwkNumericString;

export interface AwkProgram {
  rules: AwkRule[],
  functions: AwkFunctionDefinition[],
}

export interface AwkFunctionDefinition {
  name: string,
  parameters: string[],
  statements: AwkStatement[],
}

export interface AwkRule {
  pattern: AwkPattern,
  statements: AwkStatement[],
}

export type AwkPattern =
  | { kind: 'begin' }
  | { kind: 'end' }
  | { kind: 'always' }
  | { kind: 'expression', expression: AwkExpression }
  | { kind: 'range', start: AwkExpression, end: AwkExpression };

export interface AwkOutputRedirection {
  operator: '>' | '>>' | '|',
  target: AwkExpression,
}

export type AwkGetlineSource =
  | { kind: 'current-input' }
  | { kind: 'file', expression: AwkExpression }
  | { kind: 'command', expression: AwkExpression };

export type AwkStatement =
  | { kind: 'print', expressions: AwkExpression[], redirection: AwkOutputRedirection | undefined }
  | { kind: 'printf', format: AwkExpression, arguments: AwkExpression[], redirection: AwkOutputRedirection | undefined }
  | { kind: 'assign', target: AwkAssignmentTarget, operator: AwkAssignmentOperator, expression: AwkExpression }
  | { kind: 'expression', expression: AwkExpression }
  | { kind: 'if', condition: AwkExpression, thenStatements: AwkStatement[], elseStatements: AwkStatement[] | undefined }
  | { kind: 'while', condition: AwkExpression, statements: AwkStatement[] }
  | { kind: 'doWhile', condition: AwkExpression, statements: AwkStatement[] }
  | { kind: 'for', initializer: AwkForClausePart | undefined, condition: AwkExpression | undefined, increment: AwkForClausePart | undefined, statements: AwkStatement[] }
  | { kind: 'forIn', variableName: string, arrayName: string, statements: AwkStatement[] }
  | { kind: 'delete', target: AwkDeleteTarget }
  | { kind: 'break' }
  | { kind: 'continue' }
  | { kind: 'next' }
  | { kind: 'nextfile' }
  | { kind: 'exit', expression: AwkExpression | undefined }
  | { kind: 'return', expression: AwkExpression | undefined };

export type AwkForClausePart =
  | { kind: 'assign', target: AwkAssignmentTarget, operator: AwkAssignmentOperator, expression: AwkExpression }
  | { kind: 'expression', expression: AwkExpression };

export type AwkAssignmentTarget =
  | { kind: 'variable', name: string }
  | { kind: 'indexed', name: string, index: AwkExpression }
  | { kind: 'field', index: AwkExpression };

export type AwkAssignmentOperator = '=' | '+=' | '-=' | '*=' | '/=' | '%=' | '^=';

export type AwkDeleteTarget =
  | { kind: 'array', name: string }
  | { kind: 'indexed', name: string, index: AwkExpression };

export type AwkExpression =
  | { kind: 'number', value: number }
  | { kind: 'string', value: string }
  | { kind: 'regex', value: RegExp }
  | { kind: 'identifier', name: string }
  | { kind: 'indexed', name: string, index: AwkExpression }
  | { kind: 'field', index: AwkExpression }
  | { kind: 'subscript', items: AwkExpression[] }
  | { kind: 'binary', operator: AwkBinaryOperator, left: AwkExpression, right: AwkExpression }
  | { kind: 'unary', operator: AwkUnaryOperator, expression: AwkExpression }
  | { kind: 'conditional', condition: AwkExpression, whenTrue: AwkExpression, whenFalse: AwkExpression }
  | { kind: 'assignment', target: AwkAssignmentTarget, operator: AwkAssignmentOperator, expression: AwkExpression }
  | { kind: 'call', callee: string, args: AwkExpression[] }
  | { kind: 'getline', target: AwkAssignmentTarget | undefined, source: AwkGetlineSource }
  | { kind: 'update', target: AwkAssignmentTarget, operator: AwkUpdateOperator, position: AwkUpdatePosition };

export type AwkBinaryOperator =
  | 'concat'
  | '||'
  | '&&'
  | 'in'
  | '+'
  | '-'
  | '*'
  | '/'
  | '%'
  | '^'
  | '=='
  | '!='
  | '<'
  | '<='
  | '>'
  | '>='
  | '~'
  | '!~';

export type AwkUnaryOperator = '!' | '+' | '-';

export type AwkUpdateOperator = '++' | '--';

export type AwkUpdatePosition = 'prefix' | 'postfix';

export type AwkToken =
  | { kind: 'identifier', value: string }
  | { kind: 'number', value: string }
  | { kind: 'string', value: string }
  | { kind: 'regex', value: string }
  | { kind: 'field', value: number }
  | { kind: 'operator', value: string }
  | { kind: 'punctuation', value: '{' | '}' | '(' | ')' | '[' | ']' | ',' | ';', joinedToPrevious?: boolean }
  | { kind: 'newline' }
  | { kind: 'eof' };

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
