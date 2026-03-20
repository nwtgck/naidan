import type {
  AwkBinaryOperator,
  AwkExpression,
  AwkPattern,
  AwkProgram,
  AwkRule,
  AwkStatement,
  AwkToken,
} from './types';

function isIdentifierStart({
  char,
}: {
  char: string;
}): boolean {
  return /[A-Za-z_]/.test(char);
}

function isIdentifierPart({
  char,
}: {
  char: string;
}): boolean {
  return /[A-Za-z0-9_]/.test(char);
}

function decodeStringEscape({
  char,
}: {
  char: string;
}): string {
  switch (char) {
  case 'n':
    return '\n';
  case 'r':
    return '\r';
  case 't':
    return '\t';
  case '"':
    return '"';
  case '\\':
    return '\\';
  default:
    return char;
  }
}

export function tokenizeAwkProgram({
  script,
}: {
  script: string;
}): { ok: true; tokens: AwkToken[] } | { ok: false; message: string } {
  const tokens: AwkToken[] = [];
  let index = 0;

  while (index < script.length) {
    const char = script[index];
    if (char === undefined) break;

    if (char === ' ' || char === '\t' || char === '\r') {
      index += 1;
      continue;
    }

    if (char === '\n') {
      tokens.push({ kind: 'newline' });
      index += 1;
      continue;
    }

    if (char === '#') {
      while (index < script.length && script[index] !== '\n') {
        index += 1;
      }
      continue;
    }

    if (char === '"') {
      index += 1;
      let value = '';
      let escaped = false;
      let terminated = false;

      while (index < script.length) {
        const current = script[index];
        if (current === undefined) break;

        if (!escaped && current === '"') {
          tokens.push({ kind: 'string', value });
          index += 1;
          terminated = true;
          break;
        }

        if (!escaped && current === '\\') {
          escaped = true;
          index += 1;
          continue;
        }

        value += escaped ? decodeStringEscape({ char: current }) : current;
        escaped = false;
        index += 1;
      }

      if (!terminated) {
        return { ok: false, message: 'unterminated string literal' };
      }
      continue;
    }

    if (char === '/') {
      index += 1;
      let value = '';
      let escaped = false;
      let terminated = false;

      while (index < script.length) {
        const current = script[index];
        if (current === undefined) break;

        if (!escaped && current === '/') {
          tokens.push({ kind: 'regex', value });
          index += 1;
          terminated = true;
          break;
        }

        value += current;
        escaped = !escaped && current === '\\';
        index += 1;
      }

      if (!terminated) {
        return { ok: false, message: 'unterminated regular expression' };
      }
      continue;
    }

    if (char === '$') {
      index += 1;
      let digits = '';
      while (index < script.length) {
        const current = script[index];
        if (current === undefined || !/\d/.test(current)) break;
        digits += current;
        index += 1;
      }

      if (digits.length === 0) {
        return { ok: false, message: "expected field number after '$'" };
      }

      tokens.push({ kind: 'field', value: parseInt(digits, 10) });
      continue;
    }

    const twoCharacterOperator = script.slice(index, index + 2);
    if (['==', '!=', '<=', '>=', '!~', '&&', '||', '++', '--'].includes(twoCharacterOperator)) {
      tokens.push({ kind: 'operator', value: twoCharacterOperator });
      index += 2;
      continue;
    }

    if (['=', '<', '>', '~', '+', '-', '*', '!'].includes(char)) {
      tokens.push({ kind: 'operator', value: char });
      index += 1;
      continue;
    }

    if (['{', '}', '(', ')', '[', ']', ',', ';'].includes(char)) {
      tokens.push({ kind: 'punctuation', value: char as '{' | '}' | '(' | ')' | '[' | ']' | ',' | ';' });
      index += 1;
      continue;
    }

    if (/\d/.test(char)) {
      let value = char;
      index += 1;
      while (index < script.length) {
        const current = script[index];
        if (current === undefined || !/[\d.]/.test(current)) break;
        value += current;
        index += 1;
      }
      tokens.push({ kind: 'number', value });
      continue;
    }

    if (isIdentifierStart({ char })) {
      let value = char;
      index += 1;
      while (index < script.length) {
        const current = script[index];
        if (current === undefined || !isIdentifierPart({ char: current })) break;
        value += current;
        index += 1;
      }
      tokens.push({ kind: 'identifier', value });
      continue;
    }

    return { ok: false, message: `unexpected character '${char}'` };
  }

  tokens.push({ kind: 'eof' });
  return { ok: true, tokens };
}

class AwkParser {
  private readonly tokens: AwkToken[];

  private index = 0;

  constructor({ tokens }: { tokens: AwkToken[] }) {
    this.tokens = tokens;
  }

  parse(): { ok: true; program: AwkProgram } | { ok: false; message: string } {
    const rules: AwkRule[] = [];

    while (!this.isEof()) {
      this.skipSeparators();
      if (this.isEof()) break;

      const rule = this.parseRule();
      if (!rule.ok) return rule;
      rules.push(rule.rule);
      this.skipSeparators();
    }

    return { ok: true, program: { rules } };
  }

  private parseRule(): { ok: true; rule: AwkRule } | { ok: false; message: string } {
    const token = this.peek();

    let pattern: AwkPattern;
    if (token.kind === 'identifier' && token.value === 'BEGIN') {
      this.index += 1;
      pattern = { kind: 'begin' };
    } else if (token.kind === 'identifier' && token.value === 'END') {
      this.index += 1;
      pattern = { kind: 'end' };
    } else if (token.kind === 'punctuation' && token.value === '{') {
      pattern = { kind: 'always' };
    } else {
      const expression = this.parseExpression();
      if (!expression.ok) return expression;
      pattern = { kind: 'expression', expression: expression.expression };
    }

    this.skipSeparators();
    const blockToken = this.peek();
    if (blockToken.kind === 'punctuation' && blockToken.value === '{') {
      const statements = this.parseBlock();
      if (!statements.ok) return statements;
      return {
        ok: true,
        rule: { pattern, statements: statements.statements },
      };
    }

    return {
      ok: true,
      rule: {
        pattern,
        statements: [{ kind: 'print', expressions: [] }],
      },
    };
  }

  private parseBlock(): { ok: true; statements: AwkStatement[] } | { ok: false; message: string } {
    const open = this.consumePunctuation({ value: '{' });
    if (!open.ok) return open;

    const statements: AwkStatement[] = [];
    while (true) {
      const token = this.peek();
      if (token.kind === 'punctuation' && token.value === '}') {
        break;
      }
      this.skipSeparators();
      const afterSeparator = this.peek();
      if (afterSeparator.kind === 'punctuation' && afterSeparator.value === '}') break;
      switch (afterSeparator.kind) {
      case 'eof':
        return { ok: false, message: "missing closing '}'" };
      default:
        break;
      }

      const statement = this.parseStatement();
      if (!statement.ok) return statement;
      statements.push(statement.statement);
      this.skipSeparators();
    }

    const close = this.consumePunctuation({ value: '}' });
    if (!close.ok) return close;
    return { ok: true, statements };
  }

  private parseStatement(): { ok: true; statement: AwkStatement } | { ok: false; message: string } {
    const token = this.peek();
    if (token.kind === 'identifier' && token.value === 'print') {
      this.index += 1;
      const expressions: AwkExpression[] = [];
      while (!this.isStatementBoundary()) {
        const expression = this.parseExpression();
        if (!expression.ok) return expression;
        expressions.push(expression.expression);
        const separator = this.peek();
        if (!(separator.kind === 'punctuation' && separator.value === ',')) break;
        this.index += 1;
      }

      return { ok: true, statement: { kind: 'print', expressions } };
    }

    if (token.kind === 'identifier' && token.value === 'printf') {
      this.index += 1;
      const format = this.parseExpression();
      if (!format.ok) return format;

      const argumentsList: AwkExpression[] = [];
      while (true) {
        const separator = this.peek();
        if (!(separator.kind === 'punctuation' && separator.value === ',')) {
          break;
        }
        this.index += 1;
        const argument = this.parseExpression();
        if (!argument.ok) return argument;
        argumentsList.push(argument.expression);
      }

      return {
        ok: true,
        statement: {
          kind: 'printf',
          format: format.expression,
          arguments: argumentsList,
        },
      };
    }

    if (token.kind === 'identifier' && token.value === 'next') {
      this.index += 1;
      return { ok: true, statement: { kind: 'next' } };
    }

    if (token.kind === 'identifier' && token.value === 'if') {
      this.index += 1;
      const open = this.consumePunctuation({ value: '(' });
      if (!open.ok) return open;
      const condition = this.parseExpression();
      if (!condition.ok) return condition;
      const close = this.consumePunctuation({ value: ')' });
      if (!close.ok) return close;

      this.skipSeparators();
      const thenStatements = this.parseStatementBody();
      if (!thenStatements.ok) return thenStatements;

      this.skipSeparators();
      const nextToken = this.peek();
      if (nextToken.kind === 'identifier' && nextToken.value === 'else') {
        this.index += 1;
        this.skipSeparators();
        const elseStatements = this.parseStatementBody();
        if (!elseStatements.ok) return elseStatements;
        return {
          ok: true,
          statement: {
            kind: 'if',
            condition: condition.expression,
            thenStatements: thenStatements.statements,
            elseStatements: elseStatements.statements,
          },
        };
      }

      return {
        ok: true,
        statement: {
          kind: 'if',
          condition: condition.expression,
          thenStatements: thenStatements.statements,
          elseStatements: undefined,
        },
      };
    }

    if (token.kind === 'identifier' && token.value === 'while') {
      this.index += 1;
      const open = this.consumePunctuation({ value: '(' });
      if (!open.ok) return open;
      const condition = this.parseExpression();
      if (!condition.ok) return condition;
      const close = this.consumePunctuation({ value: ')' });
      if (!close.ok) return close;

      this.skipSeparators();
      const statements = this.parseStatementBody();
      if (!statements.ok) return statements;
      return {
        ok: true,
        statement: {
          kind: 'while',
          condition: condition.expression,
          statements: statements.statements,
        },
      };
    }

    if (token.kind === 'identifier' && token.value === 'for') {
      this.index += 1;
      const open = this.consumePunctuation({ value: '(' });
      if (!open.ok) return open;

      const forIn = this.parseForInClause();
      if (forIn.ok) {
        const close = this.consumePunctuation({ value: ')' });
        if (!close.ok) return close;

        this.skipSeparators();
        const statements = this.parseStatementBody();
        if (!statements.ok) return statements;
        return {
          ok: true,
          statement: {
            kind: 'forIn',
            variableName: forIn.variableName,
            arrayName: forIn.arrayName,
            statements: statements.statements,
          },
        };
      }

      const initializer = this.parseForClausePart();
      if (!initializer.ok) return initializer;
      const firstSeparator = this.consumePunctuation({ value: ';' });
      if (!firstSeparator.ok) return firstSeparator;

      const condition = this.parseOptionalExpressionUntil({ terminator: ';' });
      if (!condition.ok) return condition;
      const secondSeparator = this.consumePunctuation({ value: ';' });
      if (!secondSeparator.ok) return secondSeparator;

      const increment = this.parseForClausePart();
      if (!increment.ok) return increment;
      const close = this.consumePunctuation({ value: ')' });
      if (!close.ok) return close;

      this.skipSeparators();
      const statements = this.parseStatementBody();
      if (!statements.ok) return statements;
      return {
        ok: true,
        statement: {
          kind: 'for',
          initializer: initializer.part,
          condition: condition.expression,
          increment: increment.part,
          statements: statements.statements,
        },
      };
    }

    if (token.kind === 'identifier' && token.value === 'delete') {
      this.index += 1;
      const deleteTarget = this.parseDeleteTarget();
      if (!deleteTarget.ok) {
        return { ok: false, message: "delete requires an array or array element target" };
      }
      return {
        ok: true,
        statement: {
          kind: 'delete',
          target: deleteTarget.target,
        },
      };
    }

    switch (token.kind) {
    case 'identifier': {
      const target = this.parseAssignmentTarget();
      if (target.ok) {
        const equalsToken = this.peek();
        if (equalsToken.kind === 'operator' && equalsToken.value === '=') {
          this.index += 1;
          const expression = this.parseExpression();
          if (!expression.ok) return expression;
          return {
            ok: true,
            statement: {
              kind: 'assign',
              target: target.target,
              expression: expression.expression,
            },
          };
        }
        this.index = target.startIndex;
      }
      break;
    }
    default:
      break;
    }

    const expression = this.parseExpression();
    if (!expression.ok) return expression;
    return {
      ok: true,
      statement: { kind: 'expression', expression: expression.expression },
    };
  }

  private parseAssignmentTarget():
    | { ok: true; target: { kind: 'variable'; name: string } | { kind: 'indexed'; name: string; index: AwkExpression }; startIndex: number }
    | { ok: false } {
    const startIndex = this.index;
    const token = this.peek();
    if (!(token.kind === 'identifier')) {
      return { ok: false };
    }

    this.index += 1;
    const openBracket = this.peek();
    if (!(openBracket.kind === 'punctuation' && openBracket.value === '[')) {
      return { ok: true, target: { kind: 'variable', name: token.value }, startIndex };
    }

    this.index += 1;
    const indexExpression = this.parseExpression();
    if (!indexExpression.ok) {
      this.index = startIndex;
      return { ok: false };
    }

    const closeBracket = this.consumePunctuation({ value: ']' });
    if (!closeBracket.ok) {
      this.index = startIndex;
      return { ok: false };
    }

    return {
      ok: true,
      target: {
        kind: 'indexed',
        name: token.value,
        index: indexExpression.expression,
      },
      startIndex,
    };
  }

  private parseDeleteTarget():
    | { ok: true; target: { kind: 'array'; name: string } | { kind: 'indexed'; name: string; index: AwkExpression } }
    | { ok: false } {
    const startIndex = this.index;
    const token = this.peek();
    if (!(token.kind === 'identifier')) {
      return { ok: false };
    }

    this.index += 1;
    const nextToken = this.peek();
    if (!(nextToken.kind === 'punctuation' && nextToken.value === '[')) {
      return {
        ok: true,
        target: {
          kind: 'array',
          name: token.value,
        },
      };
    }

    this.index += 1;
    const indexExpression = this.parseExpression();
    if (!indexExpression.ok) {
      this.index = startIndex;
      return { ok: false };
    }

    const closeBracket = this.consumePunctuation({ value: ']' });
    if (!closeBracket.ok) {
      this.index = startIndex;
      return { ok: false };
    }

    return {
      ok: true,
      target: {
        kind: 'indexed',
        name: token.value,
        index: indexExpression.expression,
      },
    };
  }

  private parseStatementBody(): { ok: true; statements: AwkStatement[] } | { ok: false; message: string } {
    const token = this.peek();
    if (token.kind === 'punctuation' && token.value === '{') {
      return this.parseBlock();
    }

    const statement = this.parseStatement();
    if (!statement.ok) return statement;
    return { ok: true, statements: [statement.statement] };
  }

  private parseOptionalExpressionUntil({
    terminator,
  }: {
    terminator: ';' | ')';
  }): { ok: true; expression: AwkExpression | undefined } | { ok: false; message: string } {
    const token = this.peek();
    if (token.kind === 'punctuation' && token.value === terminator) {
      return { ok: true, expression: undefined };
    }

    const expression = this.parseExpression();
    if (!expression.ok) return expression;
    return { ok: true, expression: expression.expression };
  }

  private parseForClausePart():
    | { ok: true; part: { kind: 'assign'; target: { kind: 'variable'; name: string } | { kind: 'indexed'; name: string; index: AwkExpression }; expression: AwkExpression } | { kind: 'expression'; expression: AwkExpression } | undefined }
    | { ok: false; message: string } {
    const token = this.peek();
    if (
      token.kind === 'punctuation'
      && (token.value === ';' || token.value === ')')
    ) {
      return { ok: true, part: undefined };
    }

    const target = this.parseAssignmentTarget();
    if (target.ok) {
      const equalsToken = this.peek();
      if (equalsToken.kind === 'operator' && equalsToken.value === '=') {
        this.index += 1;
        const expression = this.parseExpression();
        if (!expression.ok) return expression;
        return {
          ok: true,
          part: {
            kind: 'assign',
            target: target.target,
            expression: expression.expression,
          },
        };
      }
      this.index = target.startIndex;
    }

    const expression = this.parseExpression();
    if (!expression.ok) return expression;
    return { ok: true, part: { kind: 'expression', expression: expression.expression } };
  }

  private parseForInClause():
    | { ok: true; variableName: string; arrayName: string }
    | { ok: false } {
    const startIndex = this.index;
    const variableToken = this.peek();
    if (!(variableToken.kind === 'identifier')) {
      return { ok: false };
    }

    const inToken = this.peekOffset({ offset: 1 });
    if (!(inToken.kind === 'identifier' && inToken.value === 'in')) {
      return { ok: false };
    }

    const arrayToken = this.peekOffset({ offset: 2 });
    if (!(arrayToken.kind === 'identifier')) {
      this.index = startIndex;
      return { ok: false };
    }

    this.index += 3;
    return {
      ok: true,
      variableName: variableToken.value,
      arrayName: arrayToken.value,
    };
  }

  private parseExpression(): { ok: true; expression: AwkExpression } | { ok: false; message: string } {
    return this.parseLogicalOr();
  }

  private parseLogicalOr(): { ok: true; expression: AwkExpression } | { ok: false; message: string } {
    let expression = this.parseLogicalAnd();
    if (!expression.ok) return expression;

    while (true) {
      const token = this.peek();
      if (!(token.kind === 'operator' && token.value === '||')) {
        break;
      }

      this.index += 1;
      const right = this.parseLogicalAnd();
      if (!right.ok) return right;
      expression = {
        ok: true,
        expression: {
          kind: 'binary',
          operator: '||',
          left: expression.expression,
          right: right.expression,
        },
      };
    }

    return expression;
  }

  private parseLogicalAnd(): { ok: true; expression: AwkExpression } | { ok: false; message: string } {
    let expression = this.parseComparison();
    if (!expression.ok) return expression;

    while (true) {
      const token = this.peek();
      if (!(token.kind === 'operator' && token.value === '&&')) {
        break;
      }

      this.index += 1;
      const right = this.parseComparison();
      if (!right.ok) return right;
      expression = {
        ok: true,
        expression: {
          kind: 'binary',
          operator: '&&',
          left: expression.expression,
          right: right.expression,
        },
      };
    }

    return expression;
  }

  private parseComparison(): { ok: true; expression: AwkExpression } | { ok: false; message: string } {
    const left = this.parseConcatenation();
    if (!left.ok) return left;

    const token = this.peek();
    if (token.kind === 'identifier' && token.value === 'in') {
      this.index += 1;
      const right = this.parseConcatenation();
      if (!right.ok) return right;
      return {
        ok: true,
        expression: {
          kind: 'binary',
          operator: 'in',
          left: left.expression,
          right: right.expression,
        },
      };
    }

    if (token.kind === 'operator' && ['==', '!=', '<', '<=', '>', '>=', '~', '!~'].includes(token.value)) {
      this.index += 1;
      const right = this.parseConcatenation();
      if (!right.ok) return right;
      return {
        ok: true,
        expression: {
          kind: 'binary',
          operator: token.value as AwkBinaryOperator,
          left: left.expression,
          right: right.expression,
        },
      };
    }

    return left;
  }

  private parseConcatenation(): { ok: true; expression: AwkExpression } | { ok: false; message: string } {
    let expression = this.parseAdditive();
    if (!expression.ok) return expression;

    while (this.isExpressionStart({ token: this.peek() })) {
      const right = this.parseAdditive();
      if (!right.ok) return right;
      expression = {
        ok: true,
        expression: {
          kind: 'binary',
          operator: 'concat',
          left: expression.expression,
          right: right.expression,
        },
      };
    }

    return expression;
  }

  private parseAdditive(): { ok: true; expression: AwkExpression } | { ok: false; message: string } {
    let expression = this.parseUnary();
    if (!expression.ok) return expression;

    while (true) {
      const token = this.peek();
      if (!(token.kind === 'operator' && (token.value === '+' || token.value === '-'))) {
        break;
      }

      this.index += 1;
      const right = this.parseUnary();
      if (!right.ok) return right;
      expression = {
        ok: true,
        expression: {
          kind: 'binary',
          operator: token.value as AwkBinaryOperator,
          left: expression.expression,
          right: right.expression,
        },
      };
    }

    return expression;
  }

  private parseUnary(): { ok: true; expression: AwkExpression } | { ok: false; message: string } {
    const token = this.peek();
    switch (token.kind) {
    case 'operator':
      switch (token.value) {
      case '!': {
        this.index += 1;
        const expression = this.parseUnary();
        if (!expression.ok) return expression;
        return {
          ok: true,
          expression: {
            kind: 'unary',
            operator: '!',
            expression: expression.expression,
          },
        };
      }
      case '++':
      case '--': {
        this.index += 1;
        const target = this.parseAssignmentTarget();
        if (!target.ok) {
          return { ok: false, message: `expected assignable target after '${token.value}'` };
        }
        return {
          ok: true,
          expression: {
            kind: 'update',
            target: target.target,
            operator: token.value,
            position: 'prefix',
          },
        };
      }
      default:
        break;
      }
      break;
    case 'identifier':
    case 'number':
    case 'string':
    case 'regex':
    case 'field':
    case 'punctuation':
    case 'newline':
    case 'eof':
      break;
    default: {
      const _ex: never = token;
      throw new Error(`Unhandled awk token: ${JSON.stringify(_ex)}`);
    }
    }

    return this.parseMultiplicative();
  }

  private parseMultiplicative(): { ok: true; expression: AwkExpression } | { ok: false; message: string } {
    let expression = this.parsePrimary();
    if (!expression.ok) return expression;

    while (true) {
      const token = this.peek();
      if (!(token.kind === 'operator' && token.value === '*')) {
        break;
      }

      this.index += 1;
      const right = this.parsePrimary();
      if (!right.ok) return right;
      expression = {
        ok: true,
        expression: {
          kind: 'binary',
          operator: '*',
          left: expression.expression,
          right: right.expression,
        },
      };
    }

    return expression;
  }

  private isExpressionStart({ token }: { token: AwkToken }): boolean {
    switch (token.kind) {
    case 'number':
    case 'string':
    case 'regex':
    case 'field':
      return true;
    case 'identifier':
      return token.value !== 'in';
    case 'punctuation':
      switch (token.value) {
      case '(':
        return true;
      case '{':
      case '}':
      case '[':
      case ']':
      case ')':
      case ',':
      case ';':
        return false;
      }
      break;
    case 'operator':
      switch (token.value) {
      case '!':
        return true;
      default:
        return false;
      }
    case 'newline':
    case 'eof':
      return false;
    default: {
      const _ex: never = token;
      throw new Error(`Unhandled awk token: ${JSON.stringify(_ex)}`);
    }
    }
  }

  private parsePrimary(): { ok: true; expression: AwkExpression } | { ok: false; message: string } {
    const token = this.peek();
    const primary: { ok: true; expression: AwkExpression } | { ok: false; message: string } = (() => {
      switch (token.kind) {
      case 'number':
        this.index += 1;
        return {
          ok: true,
          expression: { kind: 'number', value: Number(token.value) },
        };
      case 'string':
        this.index += 1;
        return {
          ok: true,
          expression: { kind: 'string', value: token.value },
        };
      case 'regex':
        this.index += 1;
        try {
          return {
            ok: true,
            expression: { kind: 'regex', value: new RegExp(token.value) },
          };
        } catch (error: unknown) {
          return {
            ok: false,
            message: error instanceof Error ? error.message : String(error),
          };
        }
      case 'identifier': {
        const nextToken = this.peekOffset({ offset: 1 });
        if (nextToken.kind === 'punctuation' && nextToken.value === '[') {
          const name = token.value;
          this.index += 2;
          const indexExpression = this.parseExpression();
          if (!indexExpression.ok) return indexExpression;
          const close = this.consumePunctuation({ value: ']' });
          if (!close.ok) return close;
          return {
            ok: true,
            expression: {
              kind: 'indexed',
              name,
              index: indexExpression.expression,
            },
          };
        }

        if (nextToken.kind === 'punctuation' && nextToken.value === '(') {
          const callee = token.value;
          this.index += 2;
          const args: AwkExpression[] = [];

          const firstArgumentToken = this.peek();
          if (!(firstArgumentToken.kind === 'punctuation' && firstArgumentToken.value === ')')) {
            while (true) {
              const argument = this.parseExpression();
              if (!argument.ok) return argument;
              args.push(argument.expression);

              const separator = this.peek();
              if (!(separator.kind === 'punctuation' && separator.value === ',')) {
                break;
              }
              this.index += 1;
            }
          }

          const close = this.consumePunctuation({ value: ')' });
          if (!close.ok) return close;
          return {
            ok: true,
            expression: { kind: 'call', callee, args },
          };
        }
        this.index += 1;
        return {
          ok: true,
          expression: { kind: 'identifier', name: token.value },
        };
      }
      case 'field':
        this.index += 1;
        return {
          ok: true,
          expression: { kind: 'field', index: token.value },
        };
      case 'punctuation': {
        switch (token.value) {
        case '(': {
          this.index += 1;
          const nested = this.parseExpression();
          if (!nested.ok) return nested;
          const close = this.consumePunctuation({ value: ')' });
          if (!close.ok) return close;
          return nested;
        }
        default:
          return { ok: false, message: `unexpected token '${token.value}'` };
        }
      }
      default:
        return { ok: false, message: 'expected expression' };
      }
    })();

    if (!primary.ok) {
      return primary;
    }

    const nextToken = this.peek();
    if (nextToken.kind === 'operator' && (nextToken.value === '++' || nextToken.value === '--')) {
      switch (primary.expression.kind) {
      case 'identifier':
        this.index += 1;
        return {
          ok: true,
          expression: {
            kind: 'update',
            target: { kind: 'variable', name: primary.expression.name },
            operator: nextToken.value,
            position: 'postfix',
          },
        };
      case 'indexed':
        this.index += 1;
        return {
          ok: true,
          expression: {
            kind: 'update',
            target: {
              kind: 'indexed',
              name: primary.expression.name,
              index: primary.expression.index,
            },
            operator: nextToken.value,
            position: 'postfix',
          },
        };
      case 'number':
      case 'string':
      case 'regex':
      case 'field':
      case 'binary':
      case 'unary':
      case 'call':
      case 'update':
        return { ok: false, message: `expected assignable target before '${nextToken.value}'` };
      default: {
        const _ex: never = primary.expression;
        throw new Error(`Unhandled awk primary expression: ${JSON.stringify(_ex)}`);
      }
      }
    }

    return primary;
  }

  private consumePunctuation({ value }: { value: '{' | '}' | '(' | ')' | '[' | ']' | ',' | ';' }): { ok: true } | { ok: false; message: string } {
    const token = this.peek();
    if (token.kind === 'punctuation' && token.value === value) {
      this.index += 1;
      return { ok: true };
    }

    return { ok: false, message: `expected '${value}'` };
  }

  private isStatementBoundary(): boolean {
    const token = this.peek();
    switch (token.kind) {
    case 'newline':
    case 'eof':
      return true;
    case 'punctuation':
      switch (token.value) {
      case ';':
      case '}':
        return true;
      case '{':
      case '(':
      case ')':
      case '[':
      case ']':
      case ',':
        return false;
      }
      break;
    default:
      return false;
    }
  }

  private skipSeparators(): void {
    while (true) {
      const token = this.peek();
      switch (token.kind) {
      case 'newline':
        this.index += 1;
        continue;
      case 'punctuation':
        switch (token.value) {
        case ';':
          this.index += 1;
          continue;
        case '{':
        case '}':
        case '(':
        case ')':
        case '[':
        case ']':
        case ',':
          break;
        }
        break;
      case 'identifier':
      case 'number':
      case 'string':
      case 'regex':
      case 'field':
      case 'operator':
      case 'eof':
        break;
      default: {
        const _ex: never = token;
        throw new Error(`Unhandled awk token: ${JSON.stringify(_ex)}`);
      }
      }
      break;
    }
  }

  private isEof(): boolean {
    return this.peek().kind === 'eof';
  }

  private peek(): AwkToken {
    return this.tokens[this.index] ?? { kind: 'eof' };
  }

  private peekOffset({ offset }: { offset: number }): AwkToken {
    return this.tokens[this.index + offset] ?? { kind: 'eof' };
  }
}

export function parseAwkProgram({
  script,
}: {
  script: string;
}): { ok: true; program: AwkProgram } | { ok: false; message: string } {
  const tokenized = tokenizeAwkProgram({ script });
  if (!tokenized.ok) {
    return tokenized;
  }

  return new AwkParser({ tokens: tokenized.tokens }).parse();
}
