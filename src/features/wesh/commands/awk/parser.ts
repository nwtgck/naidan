import type {
  AwkAssignmentOperator,
  AwkAssignmentTarget,
  AwkBinaryOperator,
  AwkExpression,
  AwkFunctionDefinition,
  AwkPattern,
  AwkProgram,
  AwkRule,
  AwkStatement,
  AwkToken,
  AwkUnaryOperator,
} from './types';
import { compileAwkRegularExpression } from '@/features/wesh/commands/awk/regexp';

const AWK_EXPRESSION_NESTING_LIMIT = 128;
const AWK_STATEMENT_NESTING_LIMIT = 128;
const AWK_RIGHT_ASSOCIATIVE_NESTING_LIMIT = 128;

function findImproperFunctionControl({
  statements,
}: {
  statements: AwkStatement[],
}): 'next' | 'nextfile' | undefined {
  const pending = [...statements].reverse();
  while (pending.length > 0) {
    const statement = pending.pop();
    if (statement === undefined) {
      throw new Error('Unreachable missing awk statement');
    }

    switch (statement.kind) {
    case 'next':
    case 'nextfile':
      return statement.kind;
    case 'if':
      if (statement.elseStatements !== undefined) {
        for (let index = statement.elseStatements.length - 1; index >= 0; index -= 1) {
          const nested = statement.elseStatements[index];
          if (nested !== undefined) pending.push(nested);
        }
      }
      for (let index = statement.thenStatements.length - 1; index >= 0; index -= 1) {
        const nested = statement.thenStatements[index];
        if (nested !== undefined) pending.push(nested);
      }
      break;
    case 'while':
    case 'doWhile':
    case 'for':
    case 'forIn':
      for (let index = statement.statements.length - 1; index >= 0; index -= 1) {
        const nested = statement.statements[index];
        if (nested !== undefined) pending.push(nested);
      }
      break;
    case 'print':
    case 'printf':
    case 'assign':
    case 'expression':
    case 'delete':
    case 'break':
    case 'continue':
    case 'exit':
    case 'return':
      break;
    default: {
      const _ex: never = statement;
      throw new Error(`Unhandled awk statement: ${JSON.stringify(_ex)}`);
    }
    }
  }

  return undefined;
}

function previousTokenCanEndExpression({
  tokens,
}: {
  tokens: AwkToken[],
}): boolean {
  const previous = tokens.findLast((token) => token.kind !== 'newline');
  if (previous === undefined) return false;

  switch (previous.kind) {
  case 'identifier':
    return !['print', 'printf', 'if', 'while', 'for', 'exit', 'return', 'function', 'BEGIN', 'END'].includes(previous.value);
  case 'number':
  case 'string':
  case 'regex':
  case 'field':
    return true;
  case 'punctuation':
    return previous.value === ')' || previous.value === ']';
  case 'operator':
  case 'eof':
    return false;
  default: {
    const _ex: never = previous;
    throw new Error(`Unhandled awk token: ${JSON.stringify(_ex)}`);
  }
  }
}

function isIdentifierStart({
  char,
}: {
  char: string,
}): boolean {
  return /[A-Za-z_]/.test(char);
}

function isIdentifierPart({
  char,
}: {
  char: string,
}): boolean {
  return /[A-Za-z0-9_]/.test(char);
}

function decodeAwkStringSingleCharacterEscape({
  escaped,
}: {
  escaped: string,
}): string | undefined {
  switch (escaped) {
  case 'a': return '\x07';
  case 'b': return '\b';
  case 'f': return '\f';
  case 'n': return '\n';
  case 'r': return '\r';
  case 't': return '\t';
  case 'v': return '\x0b';
  case '"': return '"';
  case '\\': return '\\';
  default: return undefined;
  }
}

function decodeAwkRegexLiteralSingleCharacterEscape({
  escaped,
}: {
  escaped: string,
}): string | undefined {
  switch (escaped) {
  case 'a': return '\x07';
  case 'b': return '\b';
  case 'f': return '\f';
  case 'n': return '\n';
  case 'r': return '\r';
  case 't': return '\t';
  case 'v': return '\x0b';
  default: return undefined;
  }
}

function consumeAwkStringEscape({
  script,
  startIndex,
}: {
  script: string,
  startIndex: number,
}): { value: string, endIndex: number } {
  const escaped = script[startIndex + 1];
  if (escaped === undefined) return { value: '\\', endIndex: startIndex + 1 };

  const decoded = decodeAwkStringSingleCharacterEscape({ escaped });
  if (decoded !== undefined) return { value: decoded, endIndex: startIndex + 2 };

  if (/^[0-7]$/u.test(escaped)) {
    let digits = escaped;
    let index = startIndex + 2;
    while (digits.length < 3 && /^[0-7]$/u.test(script[index] ?? '')) {
      digits += script[index]!;
      index += 1;
    }
    return {
      value: String.fromCharCode(Number.parseInt(digits, 8) & 0xff),
      endIndex: index,
    };
  }

  if (escaped === 'x') {
    let digits = '';
    let index = startIndex + 2;
    while (digits.length < 2 && /^[0-9A-Fa-f]$/u.test(script[index] ?? '')) {
      digits += script[index]!;
      index += 1;
    }
    if (digits.length > 0) {
      return { value: String.fromCharCode(Number.parseInt(digits, 16)), endIndex: index };
    }
  }

  return { value: `\\${escaped}`, endIndex: startIndex + 2 };
}


function consumeAwkRegexLiteralEscape({
  script,
  startIndex,
}: {
  script: string,
  startIndex: number,
}): { value: string, endIndex: number } {
  const escaped = script[startIndex + 1];
  if (escaped === undefined) return { value: '\\', endIndex: startIndex + 1 };

  const decoded = decodeAwkRegexLiteralSingleCharacterEscape({ escaped });
  if (decoded !== undefined) return { value: decoded, endIndex: startIndex + 2 };

  if (/^[0-7]$/u.test(escaped)) {
    let digits = escaped;
    let index = startIndex + 2;
    while (digits.length < 3 && /^[0-7]$/u.test(script[index] ?? '')) {
      digits += script[index]!;
      index += 1;
    }
    return {
      value: String.fromCharCode(Number.parseInt(digits, 8) & 0xff),
      endIndex: index,
    };
  }

  if (escaped === 'x') {
    let digits = '';
    let index = startIndex + 2;
    while (digits.length < 2 && /^[0-9A-Fa-f]$/u.test(script[index] ?? '')) {
      digits += script[index]!;
      index += 1;
    }
    if (digits.length > 0) {
      return { value: String.fromCharCode(Number.parseInt(digits, 16)), endIndex: index };
    }
  }

  if (escaped === '/') return { value: '/', endIndex: startIndex + 2 };
  if ('.[]\\*^$()+?{|}'.includes(escaped)) {
    return { value: `\\${escaped}`, endIndex: startIndex + 2 };
  }
  return { value: escaped, endIndex: startIndex + 2 };
}

export function tokenizeAwkProgram({
  script,
}: {
  script: string,
}): { ok: true, tokens: AwkToken[] } | { ok: false, message: string } {
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
      let terminated = false;

      while (index < script.length) {
        const current = script[index];
        if (current === undefined) break;

        if (current === '"') {
          tokens.push({ kind: 'string', value });
          index += 1;
          terminated = true;
          break;
        }
        if (current === '\\') {
          const escape = consumeAwkStringEscape({ script, startIndex: index });
          value += escape.value;
          index = escape.endIndex;
          continue;
        }

        value += current;
        index += 1;
      }

      if (!terminated) {
        return { ok: false, message: 'unterminated string literal' };
      }
      continue;
    }

    if (char === '/' && !previousTokenCanEndExpression({ tokens })) {
      index += 1;
      let value = '';
      let terminated = false;

      while (index < script.length) {
        const current = script[index];
        if (current === undefined) break;

        if (current === '/') {
          tokens.push({ kind: 'regex', value });
          index += 1;
          terminated = true;
          break;
        }
        if (current === '\\') {
          const escape = consumeAwkRegexLiteralEscape({ script, startIndex: index });
          value += escape.value;
          index = escape.endIndex;
          continue;
        }

        value += current;
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
        tokens.push({ kind: 'operator', value: '$' });
      } else {
        tokens.push({ kind: 'field', value: parseInt(digits, 10) });
      }
      continue;
    }

    const twoCharacterOperator = script.slice(index, index + 2);
    if (['==', '!=', '<=', '>=', '!~', '&&', '||', '++', '--', '+=', '-=', '*=', '/=', '%=', '^=', '>>'].includes(twoCharacterOperator)) {
      tokens.push({ kind: 'operator', value: twoCharacterOperator });
      index += 2;
      continue;
    }

    if (['=', '<', '>', '~', '+', '-', '*', '/', '%', '^', '!', '?', ':', '|'].includes(char)) {
      tokens.push({ kind: 'operator', value: char });
      index += 1;
      continue;
    }

    if (['{', '}', '(', ')', '[', ']', ',', ';'].includes(char)) {
      tokens.push({
        kind: 'punctuation',
        value: char as '{' | '}' | '(' | ')' | '[' | ']' | ',' | ';',
        joinedToPrevious: char === '('
          && index > 0
          && isIdentifierPart({ char: script[index - 1]! }),
      });
      index += 1;
      continue;
    }

    if (/\d/.test(char) || (char === '.' && /\d/.test(script[index + 1] ?? ''))) {
      const number = script.slice(index).match(/^(?:(?:\d+(?:\.\d*)?)|(?:\.\d+))(?:[eE][+-]?\d+)?/u)?.[0];
      if (number === undefined) {
        return { ok: false, message: `invalid number near '${script.slice(index)}'` };
      }
      tokens.push({ kind: 'number', value: number });
      index += number.length;
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

const AWK_BUILTIN_FUNCTION_NAMES = new Set([
  'length',
  'int',
  'sqrt',
  'exp',
  'log',
  'sin',
  'cos',
  'atan2',
  'rand',
  'srand',
  'sprintf',
  'index',
  'substr',
  'tolower',
  'toupper',
  'match',
  'sub',
  'gsub',
  'close',
  'system',
  'split',
] as const);

class AwkParser {
  private readonly tokens: AwkToken[];

  private readonly callableNames = new Set<string>(AWK_BUILTIN_FUNCTION_NAMES);

  private readonly declaredFunctionNames: ReadonlySet<string>;

  private readonly matchingClosingTokenIndexes: ReadonlyMap<number, number>;

  private index = 0;

  private parsingOutputExpression = false;

  private expressionNestingDepth = 0;

  private statementNestingDepth = 0;

  private rightAssociativeNestingDepth = 0;

  constructor({ tokens }: { tokens: AwkToken[] }) {
    this.tokens = tokens;
    const declaredFunctionNames = new Set<string>();
    const matchingClosingTokenIndexes = new Map<number, number>();
    const openTokenIndexes: Array<{ readonly index: number, readonly value: '(' | '[' }> = [];
    for (let index = 0; index < tokens.length; index += 1) {
      const keyword = tokens[index];
      const name = tokens[index + 1];
      const open = tokens[index + 2];
      if (
        keyword?.kind === 'identifier'
        && keyword.value === 'function'
        && name?.kind === 'identifier'
        && open?.kind === 'punctuation'
        && open.value === '('
      ) {
        declaredFunctionNames.add(name.value);
      }

      if (keyword === undefined) continue;
      switch (keyword.kind) {
      case 'punctuation': {
        const punctuation = keyword.value;
        switch (punctuation) {
        case '(':
        case '[':
          openTokenIndexes.push({ index, value: punctuation });
          break;
        case ')': {
          const opening = openTokenIndexes.pop();
          if (opening === undefined || opening.value !== '(') {
            openTokenIndexes.length = 0;
            break;
          }
          matchingClosingTokenIndexes.set(opening.index, index);
          break;
        }
        case ']': {
          const opening = openTokenIndexes.pop();
          if (opening === undefined || opening.value !== '[') {
            openTokenIndexes.length = 0;
            break;
          }
          matchingClosingTokenIndexes.set(opening.index, index);
          break;
        }
        case '{':
        case '}':
          openTokenIndexes.length = 0;
          break;
        case ',':
        case ';':
          break;
        default: {
          const _ex: never = punctuation;
          throw new Error(`Unhandled awk punctuation: ${JSON.stringify(_ex)}`);
        }
        }
        break;
      }
      case 'identifier':
      case 'number':
      case 'string':
      case 'regex':
      case 'field':
      case 'operator':
      case 'newline':
      case 'eof':
        break;
      default: {
        const _ex: never = keyword;
        throw new Error(`Unhandled awk token: ${JSON.stringify(_ex)}`);
      }
      }
    }
    this.declaredFunctionNames = declaredFunctionNames;
    this.matchingClosingTokenIndexes = matchingClosingTokenIndexes;
  }

  parse(): { ok: true, program: AwkProgram } | { ok: false, message: string } {
    const rules: AwkRule[] = [];
    const functions: AwkFunctionDefinition[] = [];

    while (!this.isEof()) {
      this.skipSeparators();
      if (this.isEof()) break;

      const token = this.peek();
      if (token.kind === 'identifier' && token.value === 'function') {
        const functionDefinition = this.parseFunctionDefinition();
        if (!functionDefinition.ok) return functionDefinition;
        functions.push(functionDefinition.functionDefinition);
      } else {
        const rule = this.parseRule();
        if (!rule.ok) return rule;
        rules.push(rule.rule);
      }
      this.skipSeparators();
    }

    return { ok: true, program: { rules, functions } };
  }

  private parseFunctionDefinition():
    | { ok: true, functionDefinition: AwkFunctionDefinition }
    | { ok: false, message: string } {
    this.index += 1;
    const nameToken = this.peek();
    // eslint-disable-next-line local-rules-switch/force-switch-for-union -- This parser branch requires an identifier and rejects every other token kind uniformly.
    if (nameToken.kind !== 'identifier') {
      return { ok: false, message: 'expected function name' };
    }
    const name = nameToken.value;
    this.callableNames.add(name);
    this.index += 1;

    const open = this.consumePunctuation({ value: '(' });
    if (!open.ok) return open;

    const parameters: string[] = [];
    const parameterNames = new Set<string>();
    const firstParameter = this.peek();
    if (!(firstParameter.kind === 'punctuation' && firstParameter.value === ')')) {
      while (true) {
        const parameter = this.peek();
        // eslint-disable-next-line local-rules-switch/force-switch-for-union -- Function parameters accept only identifiers; all other token kinds share one diagnostic.
        if (parameter.kind !== 'identifier') {
          return { ok: false, message: 'expected function parameter name' };
        }
        if (parameterNames.has(parameter.value)) {
          return { ok: false, message: `duplicate function parameter '${parameter.value}'` };
        }
        parameterNames.add(parameter.value);
        parameters.push(parameter.value);
        this.index += 1;

        const separator = this.peek();
        if (!(separator.kind === 'punctuation' && separator.value === ',')) break;
        this.index += 1;
      }
    }

    const close = this.consumePunctuation({ value: ')' });
    if (!close.ok) return close;
    this.skipSeparators();
    const statements = this.parseBlock();
    if (!statements.ok) return statements;

    const improperControl = findImproperFunctionControl({ statements: statements.statements });
    if (improperControl !== undefined) {
      return { ok: false, message: `improper use of ${improperControl}` };
    }

    return {
      ok: true,
      functionDefinition: {
        name,
        parameters,
        statements: statements.statements,
      },
    };
  }

  private parseRule(): { ok: true, rule: AwkRule } | { ok: false, message: string } {
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
      const separator = this.peek();
      if (separator.kind === 'punctuation' && separator.value === ',') {
        this.index += 1;
        const end = this.parseExpression();
        if (!end.ok) return end;
        pattern = {
          kind: 'range',
          start: expression.expression,
          end: end.expression,
        };
      } else {
        pattern = { kind: 'expression', expression: expression.expression };
      }
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
        statements: [{ kind: 'print', expressions: [], redirection: undefined }],
      },
    };
  }

  private parseBlock(): { ok: true, statements: AwkStatement[] } | { ok: false, message: string } {
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

  private parseStatement(): { ok: true, statement: AwkStatement } | { ok: false, message: string } {
    const token = this.peek();
    if (token.kind === 'identifier' && token.value === 'print') {
      this.index += 1;
      const expressions: AwkExpression[] = [];
      this.parsingOutputExpression = true;
      try {
        while (!this.isStatementBoundary()) {
          const nextToken = this.peek();
          if (nextToken.kind === 'operator' && (nextToken.value === '>' || nextToken.value === '>>' || nextToken.value === '|')) break;
          const expression = this.parseExpression();
          if (!expression.ok) return expression;
          expressions.push(expression.expression);
          const separator = this.peek();
          if (!(separator.kind === 'punctuation' && separator.value === ',')) break;
          this.index += 1;
        }
      } finally {
        this.parsingOutputExpression = false;
      }

      const redirection = this.parseOutputRedirection();
      if (!redirection.ok) return redirection;
      return {
        ok: true,
        statement: {
          kind: 'print',
          expressions,
          redirection: redirection.redirection,
        },
      };
    }

    if (token.kind === 'identifier' && token.value === 'printf') {
      this.index += 1;
      this.parsingOutputExpression = true;
      let format: { ok: true, expression: AwkExpression } | { ok: false, message: string };
      const argumentsList: AwkExpression[] = [];
      try {
        format = this.parseExpression();
        if (!format.ok) return format;

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
      } finally {
        this.parsingOutputExpression = false;
      }

      const redirection = this.parseOutputRedirection();
      if (!redirection.ok) return redirection;
      return {
        ok: true,
        statement: {
          kind: 'printf',
          format: format.expression,
          arguments: argumentsList,
          redirection: redirection.redirection,
        },
      };
    }

    if (token.kind === 'identifier' && token.value === 'next') {
      this.index += 1;
      return { ok: true, statement: { kind: 'next' } };
    }

    if (token.kind === 'identifier' && token.value === 'nextfile') {
      this.index += 1;
      return { ok: true, statement: { kind: 'nextfile' } };
    }

    if (token.kind === 'identifier' && token.value === 'break') {
      this.index += 1;
      return { ok: true, statement: { kind: 'break' } };
    }

    if (token.kind === 'identifier' && token.value === 'continue') {
      this.index += 1;
      return { ok: true, statement: { kind: 'continue' } };
    }

    if (token.kind === 'identifier' && token.value === 'exit') {
      this.index += 1;
      if (this.isStatementBoundary()) {
        return { ok: true, statement: { kind: 'exit', expression: undefined } };
      }

      const expression = this.parseExpression();
      if (!expression.ok) return expression;
      return { ok: true, statement: { kind: 'exit', expression: expression.expression } };
    }


    if (token.kind === 'identifier' && token.value === 'return') {
      this.index += 1;
      if (this.isStatementBoundary()) {
        return { ok: true, statement: { kind: 'return', expression: undefined } };
      }

      const expression = this.parseExpression();
      if (!expression.ok) return expression;
      return { ok: true, statement: { kind: 'return', expression: expression.expression } };
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

    if (token.kind === 'identifier' && token.value === 'do') {
      this.index += 1;
      this.skipSeparators();
      const statements = this.parseStatementBody();
      if (!statements.ok) return statements;
      this.skipSeparators();

      const whileToken = this.peek();
      if (!(whileToken.kind === 'identifier' && whileToken.value === 'while')) {
        return { ok: false, message: "expected 'while' after do statement" };
      }
      this.index += 1;
      const open = this.consumePunctuation({ value: '(' });
      if (!open.ok) return open;
      const condition = this.parseExpression();
      if (!condition.ok) return condition;
      const close = this.consumePunctuation({ value: ')' });
      if (!close.ok) return close;
      return {
        ok: true,
        statement: {
          kind: 'doWhile',
          condition: condition.expression,
          statements: statements.statements,
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

    const expression = this.parseExpression();
    if (!expression.ok) return expression;
    const assignment = this.asAssignmentExpression({ expression: expression.expression });
    if (assignment !== undefined) {
      return {
        ok: true,
        statement: {
          kind: 'assign',
          target: assignment.target,
          operator: assignment.operator,
          expression: assignment.expression,
        },
      };
    }
    return {
      ok: true,
      statement: { kind: 'expression', expression: expression.expression },
    };
  }

  private parseOutputRedirection():
    | { ok: true, redirection: { operator: '>' | '>>' | '|', target: AwkExpression } | undefined }
    | { ok: false, message: string } {
    const token = this.peek();
    if (!(token.kind === 'operator' && (token.value === '>' || token.value === '>>' || token.value === '|'))) {
      return { ok: true, redirection: undefined };
    }

    this.index += 1;
    const target = this.parseExpression();
    if (!target.ok) return target;
    return {
      ok: true,
      redirection: {
        operator: token.value,
        target: target.expression,
      },
    };
  }

  private parseSubscriptExpression({
    closing,
  }: {
    closing: ']' | ')',
  }): { ok: true, expression: AwkExpression } | { ok: false, message: string } {
    const first = this.parseExpression();
    if (!first.ok) return first;
    const items: AwkExpression[] = [first.expression];

    while (true) {
      const separator = this.peek();
      if (!(separator.kind === 'punctuation' && separator.value === ',')) break;
      this.index += 1;
      const item = this.parseExpression();
      if (!item.ok) return item;
      items.push(item.expression);
    }

    const close = this.consumePunctuation({ value: closing });
    if (!close.ok) return close;
    return {
      ok: true,
      expression: items.length === 1
        ? items[0] ?? { kind: 'string', value: '' }
        : { kind: 'subscript', items },
    };
  }

  private parseNestedSubscriptExpression({
    closing,
  }: {
    closing: ']' | ')',
  }): { ok: true, expression: AwkExpression } | { ok: false, message: string } {
    if (this.expressionNestingDepth >= AWK_EXPRESSION_NESTING_LIMIT) {
      return {
        ok: false,
        message: `expression nesting exceeds limit ${AWK_EXPRESSION_NESTING_LIMIT}`,
      };
    }

    this.expressionNestingDepth += 1;
    try {
      return this.parseSubscriptExpression({ closing });
    } finally {
      this.expressionNestingDepth -= 1;
    }
  }

  private parseNestedUnaryExpression():
    | { ok: true, expression: AwkExpression }
    | { ok: false, message: string } {
    if (this.expressionNestingDepth >= AWK_EXPRESSION_NESTING_LIMIT) {
      return {
        ok: false,
        message: `expression nesting exceeds limit ${AWK_EXPRESSION_NESTING_LIMIT}`,
      };
    }

    this.expressionNestingDepth += 1;
    try {
      return this.parseUnary();
    } finally {
      this.expressionNestingDepth -= 1;
    }
  }

  private parseFunctionArguments():
    | { ok: true, arguments: AwkExpression[] }
    | { ok: false, message: string } {
    if (this.expressionNestingDepth >= AWK_EXPRESSION_NESTING_LIMIT) {
      return {
        ok: false,
        message: `expression nesting exceeds limit ${AWK_EXPRESSION_NESTING_LIMIT}`,
      };
    }

    this.expressionNestingDepth += 1;
    try {
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
      return { ok: true, arguments: args };
    } finally {
      this.expressionNestingDepth -= 1;
    }
  }

  private parseAssignmentTarget():
    | { ok: true, target: AwkAssignmentTarget, startIndex: number }
    | { ok: false } {
    const startIndex = this.index;
    const token = this.peek();

    switch (token.kind) {
    case 'field':
      this.index += 1;
      return {
        ok: true,
        target: { kind: 'field', index: { kind: 'number', value: token.value } },
        startIndex,
      };
    case 'operator': {
      if (token.value !== '$') return { ok: false };
      this.index += 1;
      const indexExpression = this.parseNestedUnaryExpression();
      if (!indexExpression.ok) {
        this.index = startIndex;
        return { ok: false };
      }
      return {
        ok: true,
        target: { kind: 'field', index: indexExpression.expression },
        startIndex,
      };
    }
    case 'identifier':
      break;
    case 'number':
    case 'string':
    case 'regex':
    case 'punctuation':
    case 'newline':
    case 'eof':
      return { ok: false };
    default: {
      const _ex: never = token;
      throw new Error(`Unhandled awk token: ${JSON.stringify(_ex)}`);
    }
    }

    this.index += 1;
    const openBracket = this.peek();
    if (!(openBracket.kind === 'punctuation' && openBracket.value === '[')) {
      return { ok: true, target: { kind: 'variable', name: token.value }, startIndex };
    }

    this.index += 1;
    const indexExpression = this.parseNestedSubscriptExpression({ closing: ']' });
    if (!indexExpression.ok) {
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

  private asAssignmentExpression({
    expression,
  }: {
    expression: AwkExpression,
  }): Extract<AwkExpression, { kind: 'assignment' }> | undefined {
    switch (expression.kind) {
    case 'assignment':
      return expression;
    case 'number':
    case 'string':
    case 'regex':
    case 'identifier':
    case 'indexed':
    case 'field':
    case 'subscript':
    case 'binary':
    case 'unary':
    case 'conditional':
    case 'call':
    case 'getline':
    case 'update':
      return undefined;
    default: {
      const _ex: never = expression;
      throw new Error(
        `Unhandled awk expression: ${(((_ex satisfies never) as { readonly kind: string }).kind)}`,
      );
    }
    }
  }

  private hasAssignmentOperatorAfterAssignmentTarget(): boolean {
    const token = this.peek();
    switch (token.kind) {
    case 'field': {
      const assignment = this.peekOffset({ offset: 1 });
      return assignment.kind === 'operator' && this.isAssignmentOperator(assignment.value);
    }
    case 'operator':
      // A dynamic field target has a full unary expression after '$'. Parsing
      // it speculatively is safe because structural nesting is bounded separately.
      return token.value === '$';
    case 'identifier': {
      const next = this.peekOffset({ offset: 1 });
      if (!(next.kind === 'punctuation' && next.value === '[')) {
        return next.kind === 'operator' && this.isAssignmentOperator(next.value);
      }

      const closingIndex = this.matchingClosingTokenIndexes.get(this.index + 1);
      if (closingIndex === undefined) return false;
      const assignment = this.tokens[closingIndex + 1] ?? { kind: 'eof' };
      return assignment.kind === 'operator'
        && this.isAssignmentOperator(assignment.value);
    }
    case 'number':
    case 'string':
    case 'regex':
    case 'punctuation':
    case 'newline':
    case 'eof':
      return false;
    default: {
      const _ex: never = token;
      throw new Error(`Unhandled awk token: ${JSON.stringify(_ex)}`);
    }
    }
  }

  private parseDeleteTarget():
    | { ok: true, target: { kind: 'array', name: string } | { kind: 'indexed', name: string, index: AwkExpression } }
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
    const indexExpression = this.parseNestedSubscriptExpression({ closing: ']' });
    if (!indexExpression.ok) {
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

  private parseStatementBody(): { ok: true, statements: AwkStatement[] } | { ok: false, message: string } {
    if (this.statementNestingDepth >= AWK_STATEMENT_NESTING_LIMIT) {
      return {
        ok: false,
        message: `statement nesting exceeds limit ${AWK_STATEMENT_NESTING_LIMIT}`,
      };
    }

    this.statementNestingDepth += 1;
    try {
      const token = this.peek();
      if (token.kind === 'punctuation' && token.value === '{') {
        return this.parseBlock();
      }

      const statement = this.parseStatement();
      if (!statement.ok) return statement;
      return { ok: true, statements: [statement.statement] };
    } finally {
      this.statementNestingDepth -= 1;
    }
  }

  private parseOptionalExpressionUntil({
    terminator,
  }: {
    terminator: ';' | ')',
  }): { ok: true, expression: AwkExpression | undefined } | { ok: false, message: string } {
    const token = this.peek();
    if (token.kind === 'punctuation' && token.value === terminator) {
      return { ok: true, expression: undefined };
    }

    const expression = this.parseExpression();
    if (!expression.ok) return expression;
    return { ok: true, expression: expression.expression };
  }

  private parseForClausePart():
    | { ok: true, part: { kind: 'assign', target: AwkAssignmentTarget, operator: AwkAssignmentOperator, expression: AwkExpression } | { kind: 'expression', expression: AwkExpression } | undefined }
    | { ok: false, message: string } {
    const token = this.peek();
    if (
      token.kind === 'punctuation'
      && (token.value === ';' || token.value === ')')
    ) {
      return { ok: true, part: undefined };
    }

    const expression = this.parseExpression();
    if (!expression.ok) return expression;
    const assignment = this.asAssignmentExpression({ expression: expression.expression });
    if (assignment !== undefined) {
      return {
        ok: true,
        part: {
          kind: 'assign',
          target: assignment.target,
          operator: assignment.operator,
          expression: assignment.expression,
        },
      };
    }
    return { ok: true, part: { kind: 'expression', expression: expression.expression } };
  }

  private parseForInClause():
    | { ok: true, variableName: string, arrayName: string }
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

  private parseRightAssociativeExpression({
    parse,
  }: {
    parse: () => { ok: true, expression: AwkExpression } | { ok: false, message: string },
  }): { ok: true, expression: AwkExpression } | { ok: false, message: string } {
    if (this.rightAssociativeNestingDepth >= AWK_RIGHT_ASSOCIATIVE_NESTING_LIMIT) {
      return {
        ok: false,
        message: `right-associative expression nesting exceeds limit ${AWK_RIGHT_ASSOCIATIVE_NESTING_LIMIT}`,
      };
    }

    this.rightAssociativeNestingDepth += 1;
    try {
      return parse();
    } finally {
      this.rightAssociativeNestingDepth -= 1;
    }
  }

  private parseExpression(): { ok: true, expression: AwkExpression } | { ok: false, message: string } {
    if (!this.hasAssignmentOperatorAfterAssignmentTarget()) {
      return this.parseConditional();
    }

    const startIndex = this.index;
    const target = this.parseAssignmentTarget();
    if (target.ok) {
      const assignment = this.peek();
      if (assignment.kind === 'operator' && this.isAssignmentOperator(assignment.value)) {
        this.index += 1;
        const right = this.parseRightAssociativeExpression({
          parse: () => this.parseExpression(),
        });
        if (!right.ok) return right;
        return {
          ok: true,
          expression: {
            kind: 'assignment',
            target: target.target,
            operator: assignment.value,
            expression: right.expression,
          },
        };
      }
    }
    this.index = startIndex;
    return this.parseConditional();
  }

  private parseConditional(): { ok: true, expression: AwkExpression } | { ok: false, message: string } {
    const condition = this.parseLogicalOr();
    if (!condition.ok) return condition;

    const question = this.peek();
    if (!(question.kind === 'operator' && question.value === '?')) {
      return condition;
    }

    this.index += 1;
    const whenTrue = this.parseRightAssociativeExpression({
      parse: () => this.parseExpression(),
    });
    if (!whenTrue.ok) return whenTrue;

    const colon = this.peek();
    if (!(colon.kind === 'operator' && colon.value === ':')) {
      return { ok: false, message: "expected ':' in conditional expression" };
    }
    this.index += 1;

    const whenFalse = this.parseRightAssociativeExpression({
      parse: () => this.parseExpression(),
    });
    if (!whenFalse.ok) return whenFalse;
    return {
      ok: true,
      expression: {
        kind: 'conditional',
        condition: condition.expression,
        whenTrue: whenTrue.expression,
        whenFalse: whenFalse.expression,
      },
    };
  }

  private parseLogicalOr(): { ok: true, expression: AwkExpression } | { ok: false, message: string } {
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

  private parseLogicalAnd(): { ok: true, expression: AwkExpression } | { ok: false, message: string } {
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

  private parseComparison(): { ok: true, expression: AwkExpression } | { ok: false, message: string } {
    let expression = this.parseConcatenation();
    if (!expression.ok) return expression;

    while (true) {
      const token = this.peek();
      if (token.kind === 'operator' && token.value === '|') {
        const nextToken = this.peekOffset({ offset: 1 });
        if (nextToken.kind === 'identifier' && nextToken.value === 'getline') {
          this.index += 1;
          const getline = this.parseGetlineExpression();
          if (!getline.ok) return getline;
          return {
            ok: true,
            expression: {
              ...getline.expression,
              source: {
                kind: 'command',
                expression: expression.expression,
              },
            },
          };
        }
      }

      let operator: AwkBinaryOperator | undefined;
      if (token.kind === 'identifier' && token.value === 'in') {
        operator = 'in';
      } else if (
        token.kind === 'operator'
        && ['==', '!=', '<', '<=', '>', '>=', '~', '!~'].includes(token.value)
        && !(this.parsingOutputExpression && token.value === '>')
      ) {
        operator = token.value as AwkBinaryOperator;
      }
      if (operator === undefined) break;

      this.index += 1;
      const right = this.parseConcatenation();
      if (!right.ok) return right;
      expression = {
        ok: true,
        expression: {
          kind: 'binary',
          operator,
          left: expression.expression,
          right: right.expression,
        },
      };
    }

    return expression;
  }

  private parseConcatenation(): { ok: true, expression: AwkExpression } | { ok: false, message: string } {
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

  private parseAdditive(): { ok: true, expression: AwkExpression } | { ok: false, message: string } {
    let expression = this.parseMultiplicative();
    if (!expression.ok) return expression;

    while (true) {
      const token = this.peek();
      if (!(token.kind === 'operator' && (token.value === '+' || token.value === '-'))) {
        break;
      }

      this.index += 1;
      const right = this.parseMultiplicative();
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

  private parseUnary(): { ok: true, expression: AwkExpression } | { ok: false, message: string } {
    const operators: AwkUnaryOperator[] = [];

    unaryOperators: while (true) {
      const token = this.peek();
      switch (token.kind) {
      case 'operator':
        switch (token.value) {
        case '!':
        case '+':
        case '-':
          operators.push(token.value);
          this.index += 1;
          continue unaryOperators;
        case '++':
        case '--':
          break unaryOperators;
        default:
          break unaryOperators;
        }
      case 'identifier':
      case 'number':
      case 'string':
      case 'regex':
      case 'field':
      case 'punctuation':
      case 'newline':
      case 'eof':
        break unaryOperators;
      default: {
        const _ex: never = token;
        throw new Error(
          `Unhandled awk token kind: ${(((_ex satisfies never) as { readonly kind: string }).kind)}`,
        );
      }
      }
    }

    const baseToken = this.peek();
    let expression: { ok: true, expression: AwkExpression } | { ok: false, message: string };
    switch (baseToken.kind) {
    case 'operator':
      switch (baseToken.value) {
      case '++':
      case '--': {
        this.index += 1;
        const target = this.parseAssignmentTarget();
        if (!target.ok) {
          return { ok: false, message: `expected assignable target after '${baseToken.value}'` };
        }
        expression = {
          ok: true,
          expression: {
            kind: 'update',
            target: target.target,
            operator: baseToken.value,
            position: 'prefix',
          },
        };
        break;
      }
      default:
        expression = this.parsePower();
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
      expression = this.parsePower();
      break;
    default: {
      const _ex: never = baseToken;
      throw new Error(
        `Unhandled awk token kind: ${(((_ex satisfies never) as { readonly kind: string }).kind)}`,
      );
    }
    }
    if (!expression.ok) return expression;

    for (let index = operators.length - 1; index >= 0; index -= 1) {
      const operator = operators[index];
      if (operator === undefined) {
        throw new Error('Unreachable missing awk unary operator');
      }
      expression = {
        ok: true,
        expression: {
          kind: 'unary',
          operator,
          expression: expression.expression,
        },
      };
    }

    return expression;
  }

  private parseMultiplicative(): { ok: true, expression: AwkExpression } | { ok: false, message: string } {
    let expression = this.parseUnary();
    if (!expression.ok) return expression;

    while (true) {
      const token = this.peek();
      if (!(token.kind === 'operator' && ['*', '/', '%'].includes(token.value))) {
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

  private parsePower(): { ok: true, expression: AwkExpression } | { ok: false, message: string } {
    const left = this.parsePrimary();
    if (!left.ok) return left;

    const token = this.peek();
    if (!(token.kind === 'operator' && token.value === '^')) {
      return left;
    }

    this.index += 1;
    const right = this.parseRightAssociativeExpression({
      parse: () => this.parseUnary(),
    });
    if (!right.ok) return right;
    return {
      ok: true,
      expression: {
        kind: 'binary',
        operator: '^',
        left: left.expression,
        right: right.expression,
      },
    };
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
      case '$':
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

  private parseGetlineTarget(): { ok: true, target: AwkAssignmentTarget | undefined } | { ok: false, message: string } {
    const token = this.peek();
    switch (token.kind) {
    case 'identifier': {
      const nextToken = this.peekOffset({ offset: 1 });
      if (nextToken.kind === 'punctuation' && nextToken.value === '[') {
        const name = token.value;
        this.index += 2;
        const indexExpression = this.parseNestedSubscriptExpression({ closing: ']' });
        if (!indexExpression.ok) return indexExpression;
        return {
          ok: true,
          target: {
            kind: 'indexed',
            name,
            index: indexExpression.expression,
          },
        };
      }
      this.index += 1;
      return {
        ok: true,
        target: { kind: 'variable', name: token.value },
      };
    }
    case 'field':
      this.index += 1;
      return {
        ok: true,
        target: {
          kind: 'field',
          index: { kind: 'number', value: token.value },
        },
      };
    case 'operator': {
      if (token.value !== '$') return { ok: true, target: undefined };
      this.index += 1;
      const indexExpression = this.parseNestedUnaryExpression();
      if (!indexExpression.ok) return indexExpression;
      return {
        ok: true,
        target: { kind: 'field', index: indexExpression.expression },
      };
    }
    case 'number':
    case 'string':
    case 'regex':
    case 'punctuation':
    case 'newline':
    case 'eof':
      return { ok: true, target: undefined };
    default: {
      const _ex: never = token;
      throw new Error(`Unhandled awk getline target token: ${JSON.stringify(_ex)}`);
    }
    }
  }

  private parseGetlineExpression():
    | { ok: true, expression: Extract<AwkExpression, { kind: 'getline' }> }
    | { ok: false, message: string } {
    this.index += 1;
    const target = this.parseGetlineTarget();
    if (!target.ok) return target;

    const sourceToken = this.peek();
    if (!(sourceToken.kind === 'operator' && sourceToken.value === '<')) {
      return {
        ok: true,
        expression: {
          kind: 'getline',
          target: target.target,
          source: { kind: 'current-input' },
        },
      };
    }

    this.index += 1;
    const sourceExpression = this.parseExpression();
    if (!sourceExpression.ok) return sourceExpression;
    return {
      ok: true,
      expression: {
        kind: 'getline',
        target: target.target,
        source: {
          kind: 'file',
          expression: sourceExpression.expression,
        },
      },
    };
  }

  private parsePrimary(): { ok: true, expression: AwkExpression } | { ok: false, message: string } {
    const token = this.peek();
    const primary: { ok: true, expression: AwkExpression } | { ok: false, message: string } = (() => {
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
            expression: {
              kind: 'regex',
              value: compileAwkRegularExpression({
                source: token.value,
                flags: '',
              }),
            },
          };
        } catch (error: unknown) {
          return {
            ok: false,
            message: error instanceof Error ? error.message : String(error),
          };
        }
      case 'identifier': {
        if (token.value === 'getline') {
          return this.parseGetlineExpression();
        }
        const nextToken = this.peekOffset({ offset: 1 });
        if (nextToken.kind === 'punctuation' && nextToken.value === '[') {
          const name = token.value;
          this.index += 2;
          const indexExpression = this.parseNestedSubscriptExpression({ closing: ']' });
          if (!indexExpression.ok) return indexExpression;
          return {
            ok: true,
            expression: {
              kind: 'indexed',
              name,
              index: indexExpression.expression,
            },
          };
        }

        if (
          nextToken.kind === 'punctuation'
          && nextToken.value === '('
          && (nextToken.joinedToPrevious === true || this.callableNames.has(token.value))
        ) {
          const callee = token.value;
          this.index += 2;
          const args = this.parseFunctionArguments();
          if (!args.ok) return args;
          return {
            ok: true,
            expression: { kind: 'call', callee, args: args.arguments },
          };
        }
        if (token.value === 'length') {
          this.index += 1;
          return {
            ok: true,
            expression: { kind: 'call', callee: 'length', args: [] },
          };
        }
        if (this.declaredFunctionNames.has(token.value)) {
          return { ok: false, message: `illegal reference to variable ${token.value}` };
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
          expression: { kind: 'field', index: { kind: 'number', value: token.value } },
        };
      case 'operator':
        if (token.value === '$') {
          this.index += 1;
          const indexExpression = this.parseNestedUnaryExpression();
          if (!indexExpression.ok) return indexExpression;
          return {
            ok: true,
            expression: { kind: 'field', index: indexExpression.expression },
          };
        }
        return { ok: false, message: 'expected expression' };
      case 'punctuation': {
        switch (token.value) {
        case '(': {
          this.index += 1;
          const previousParsingOutputExpression = this.parsingOutputExpression;
          this.parsingOutputExpression = false;
          try {
            return this.parseNestedSubscriptExpression({ closing: ')' });
          } finally {
            this.parsingOutputExpression = previousParsingOutputExpression;
          }
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
      case 'field':
        this.index += 1;
        return {
          ok: true,
          expression: {
            kind: 'update',
            target: { kind: 'field', index: primary.expression.index },
            operator: nextToken.value,
            position: 'postfix',
          },
        };
      case 'number':
      case 'string':
      case 'regex':
        return { ok: false, message: `expected assignable target before '${nextToken.value}'` };
      case 'subscript':
      case 'binary':
      case 'unary':
      case 'conditional':
      case 'assignment':
      case 'call':
      case 'getline':
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

  private isAssignmentOperator(value: string): value is AwkAssignmentOperator {
    return ['=', '+=', '-=', '*=', '/=', '%=', '^='].includes(value);
  }

  private consumePunctuation({ value }: { value: '{' | '}' | '(' | ')' | '[' | ']' | ',' | ';' }): { ok: true } | { ok: false, message: string } {
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
  script: string,
}): { ok: true, program: AwkProgram } | { ok: false, message: string } {
  const tokenized = tokenizeAwkProgram({ script });
  if (!tokenized.ok) {
    return tokenized;
  }

  return new AwkParser({ tokens: tokenized.tokens }).parse();
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
