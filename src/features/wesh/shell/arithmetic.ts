import { isAsciiDecimalDigit, isAsciiShellIdentifierPart, isAsciiShellIdentifierStart, isShellWhitespaceCharacter } from './ascii';
import type { WeshVariableValues } from './variables';
import { WeshArithmeticError } from './arithmetic-error';

const INTEGER_BITS = 64;
const SHIFT_MASK = 63n;
const MAX_ARITHMETIC_DEPTH = 1024;
const COMMA_PRECEDENCE = 1;
const ASSIGNMENT_PRECEDENCE = 2;
const CONDITIONAL_PRECEDENCE = 3;

const BINARY_PRECEDENCE: ReadonlyMap<string, number> = new Map([
  [',', COMMA_PRECEDENCE],
  ['||', 4], ['&&', 5], ['|', 6], ['^', 7], ['&', 8],
  ['==', 9], ['!=', 9],
  ['<', 10], ['<=', 10], ['>', 10], ['>=', 10],
  ['<<', 11], ['>>', 11], ['+', 12], ['-', 12],
  ['*', 13], ['/', 13], ['%', 13], ['**', 14],
]);

const COMPOUND_ASSIGNMENTS: ReadonlyMap<string, string> = new Map([
  ['+=', '+'], ['-=', '-'], ['*=', '*'], ['/=', '/'], ['%=', '%'],
  ['<<=', '<<'], ['>>=', '>>'], ['&=', '&'], ['^=', '^'], ['|=', '|'],
]);

const MULTICHARACTER_OPERATORS = [
  '<<=', '>>=', '<<', '>>', '**', '&&', '||', '==', '!=', '<=', '>=',
  ...[...COMPOUND_ASSIGNMENTS.keys()].filter(operator => operator.length === 2),
];
const UPDATE_AMOUNTS = { '++': 1n, '--': -1n } as const;

type Token =
  | { kind: 'integer', value: bigint }
  | VariableReference
  | { kind: 'operator', value: string };

type VariableReference = { kind: 'variable', name: string, readsValue: boolean };
type Operand = bigint | VariableReference;
type Evaluation = 'evaluate' | 'skip-effects';

function readInteger({ text }: { text: string }): bigint {
  let radix = 10;
  let digitsStart = 0;
  if (text.startsWith('0')) {
    if (text[1] === 'x' || text[1] === 'X') {
      radix = 16;
      digitsStart = 2;
    } else {
      radix = 8;
    }
  } else {
    const separator = text.indexOf('#');
    if (separator !== -1) {
      const base = text.slice(0, separator);
      radix = Number(base);
      if (!/^[0-9]+$/u.test(base) || radix < 2 || radix > 64) {
        throw new WeshArithmeticError(`Invalid arithmetic base: ${base}`);
      }
      digitsStart = separator + 1;
      if (digitsStart === text.length) {
        throw new WeshArithmeticError(`Missing digits for arithmetic base ${radix}`);
      }
    }
  }

  let value = 0n;
  const base = BigInt(radix);
  for (let index = digitsStart; index < text.length; index++) {
    const code = text.charCodeAt(index);
    let digit: number;
    if (code >= 48 && code <= 57) {
      digit = code - 48;
    } else if (code >= 97 && code <= 122) {
      digit = code - 97 + 10;
    } else if (code >= 65 && code <= 90) {
      digit = code - 65 + (radix <= 36 ? 10 : 36);
    } else if (code === 64 || code === 95) {
      digit = code === 64 ? 62 : 63;
    } else {
      throw new WeshArithmeticError(`Invalid arithmetic integer: ${text}`);
    }
    if (digit >= radix) {
      throw new WeshArithmeticError(`Invalid digit '${text[index]}' for arithmetic base ${radix}`);
    }
    value = BigInt.asIntN(INTEGER_BITS, value * base + BigInt(digit));
  }
  return value;
}

function power({ base, exponent }: { base: bigint, exponent: bigint }): bigint {
  if (exponent < 0n) {
    throw new WeshArithmeticError('Arithmetic exponent less than 0');
  }
  let value = 1n;
  while (exponent !== 0n) {
    if ((exponent & 1n) !== 0n) {
      value = BigInt.asIntN(INTEGER_BITS, value * base);
    }
    exponent >>= 1n;
    if (exponent !== 0n) {
      base = BigInt.asIntN(INTEGER_BITS, base * base);
    }
  }
  return value;
}

function zeroDivisorResult({ evaluation, skippedResult }: { evaluation: Evaluation, skippedResult: bigint }): bigint {
  switch (evaluation) {
  case 'evaluate':
    throw new WeshArithmeticError('Division by zero in arithmetic expression');
  case 'skip-effects':
    return skippedResult;
  default: {
    const _ex: never = evaluation;
    throw new Error(`Unknown arithmetic evaluation mode: ${_ex}`);
  }
  }
}

function calculate({ operator, left, right, evaluation }: {
  operator: string,
  left: bigint,
  right: bigint,
  evaluation: Evaluation,
}): bigint {
  switch (operator) {
  case ',': return right;
  case '||': return left !== 0n || right !== 0n ? 1n : 0n;
  case '&&': return left !== 0n && right !== 0n ? 1n : 0n;
  case '|': return left | right;
  case '^': return left ^ right;
  case '&': return left & right;
  case '==': return left === right ? 1n : 0n;
  case '!=': return left !== right ? 1n : 0n;
  case '<': return left < right ? 1n : 0n;
  case '<=': return left <= right ? 1n : 0n;
  case '>': return left > right ? 1n : 0n;
  case '>=': return left >= right ? 1n : 0n;
  case '<<': return BigInt.asIntN(INTEGER_BITS, left << (right & SHIFT_MASK));
  case '>>': return left >> (right & SHIFT_MASK);
  case '+': return BigInt.asIntN(INTEGER_BITS, left + right);
  case '-': return BigInt.asIntN(INTEGER_BITS, left - right);
  case '*': return BigInt.asIntN(INTEGER_BITS, left * right);
  case '**': return power({ base: left, exponent: right });
  case '/': return right === 0n ? zeroDivisorResult({ evaluation, skippedResult: left }) : BigInt.asIntN(INTEGER_BITS, left / right);
  case '%': return right === 0n ? zeroDivisorResult({ evaluation, skippedResult: 0n }) : left % right;
  default:
    throw new Error(`Unknown binary arithmetic operator: ${operator}`);
  }
}

class ArithmeticParser {
  private readonly expression: string;
  private readonly env: WeshVariableValues;
  private readonly expressionDepth: number;
  private offset = 0;
  private token: Token | undefined;
  private previousKind: Token['kind'] | undefined;

  constructor({ expression, env, expressionDepth }: {
    expression: string,
    env: WeshVariableValues,
    expressionDepth: number,
  }) {
    this.expression = expression;
    this.env = env;
    this.expressionDepth = expressionDepth;
  }

  evaluate(): bigint {
    if (this.peek() === undefined) {
      return 0n;
    }
    const depth = this.expressionDepth;
    const operand = this.parse({ minimum: COMMA_PRECEDENCE, evaluation: 'evaluate', depth });
    const value = this.read({ operand, evaluation: 'evaluate', depth });
    if (this.peek() !== undefined) {
      throw new WeshArithmeticError('Unexpected trailing arithmetic tokens');
    }
    return value;
  }

  private peek(): Token | undefined {
    return this.token ??= this.readToken();
  }

  private peekOperator(): string | undefined {
    const token = this.peek();
    switch (token?.kind) {
    case 'operator':
      return token.value;
    case 'integer':
    case 'variable':
    case undefined:
      return undefined;
    default: {
      const _ex: never = token;
      throw new Error(`Unknown arithmetic token: ${String(_ex)}`);
    }
    }
  }

  private take(): Token {
    const token = this.peek();
    if (token === undefined) {
      throw new WeshArithmeticError('Unexpected end of arithmetic expression');
    }
    this.previousKind = token.kind;
    this.token = undefined;
    return token;
  }

  private readToken(): Token | undefined {
    const text = this.expression;
    while (isShellWhitespaceCharacter({ value: text[this.offset] })) {
      this.offset++;
    }
    const start = this.offset;
    const character = text[start];
    if (character === undefined) {
      return undefined;
    }
    this.offset++;
    if (isAsciiDecimalDigit({ value: character })) {
      while (isAsciiShellIdentifierPart({ value: text[this.offset] }) || text[this.offset] === '#' || text[this.offset] === '@') {
        this.offset++;
      }
      const value = readInteger({ text: text.slice(start, this.offset) });
      switch (this.previousKind) {
      case 'integer':
        throw new WeshArithmeticError('Unexpected consecutive arithmetic integers');
      case 'variable':
      case 'operator':
      case undefined:
        break;
      default: {
        const _ex: never = this.previousKind;
        throw new Error(`Unknown arithmetic token kind: ${_ex}`);
      }
      }
      return { kind: 'integer', value };
    }
    if (isAsciiShellIdentifierStart({ value: character })) {
      while (isAsciiShellIdentifierPart({ value: text[this.offset] })) {
        this.offset++;
      }
      return { kind: 'variable', name: text.slice(start, this.offset), readsValue: true };
    }

    if ((character === '+' || character === '-') && text[this.offset] === character) {
      let afterPair = this.offset + 1;
      while (isShellWhitespaceCharacter({ value: text[afterPair] })) {
        afterPair++;
      }
      if (this.previousKind === 'variable' || isAsciiShellIdentifierStart({ value: text[afterPair] })) {
        this.offset++;
        return { kind: 'operator', value: character + character };
      }
    }
    if ('()+-*/%!<=>,~&|^?:'.includes(character)) {
      const operator = MULTICHARACTER_OPERATORS.find(candidate => text.startsWith(candidate, start)) ?? character;
      this.offset = start + operator.length;
      return { kind: 'operator', value: operator };
    }
    throw new WeshArithmeticError(`Unsupported arithmetic token: ${character}`);
  }

  private read({ operand, evaluation, depth }: { operand: Operand, evaluation: Evaluation, depth: number }): bigint {
    if (typeof operand === 'bigint') {
      return operand;
    }
    if (!operand.readsValue) {
      return 0n;
    }
    switch (evaluation) {
    case 'skip-effects':
      return 0n;
    case 'evaluate':
      break;
    default: {
      const _ex: never = evaluation;
      throw new Error(`Unknown arithmetic evaluation mode: ${_ex}`);
    }
    }
    const expression = this.env.get({ name: operand.name });
    if (expression === undefined || expression.length === 0) {
      return 0n;
    }
    if (depth + 1 >= MAX_ARITHMETIC_DEPTH) {
      throw new WeshArithmeticError(`Arithmetic variable recursion limit exceeded: ${operand.name}`);
    }
    return new ArithmeticParser({ expression, env: this.env, expressionDepth: depth + 1 }).evaluate();
  }

  private write({ name, value, evaluation }: { name: string, value: bigint, evaluation: Evaluation }): bigint {
    switch (evaluation) {
    case 'evaluate':
      this.env.set({ name, value: value.toString() });
      break;
    case 'skip-effects':
      break;
    default: {
      const _ex: never = evaluation;
      throw new Error(`Unknown arithmetic evaluation mode: ${_ex}`);
    }
    }
    return value;
  }

  private update({ reference, operator, evaluation, postfix, depth }: {
    reference: VariableReference,
    operator: keyof typeof UPDATE_AMOUNTS,
    evaluation: Evaluation,
    postfix: boolean,
    depth: number,
  }): bigint {
    const previous = this.read({ operand: reference, evaluation, depth });
    const next = BigInt.asIntN(INTEGER_BITS, previous + UPDATE_AMOUNTS[operator]);
    this.write({ name: reference.name, value: next, evaluation });
    return postfix ? previous : next;
  }

  private expect({ operator }: { operator: string }): void {
    if (this.peekOperator() !== operator) {
      throw new WeshArithmeticError(`Expected '${operator}' in arithmetic expression`);
    }
    this.take();
  }

  private parsePrefix({ evaluation, depth }: { evaluation: Evaluation, depth: number }): Operand {
    if (depth >= MAX_ARITHMETIC_DEPTH) {
      throw new WeshArithmeticError('Arithmetic expression nesting limit exceeded');
    }
    const token = this.take();
    switch (token.kind) {
    case 'integer':
      return token.value;
    case 'variable': {
      const operator = this.peekOperator();
      if (operator === '++' || operator === '--') {
        this.take();
        return this.update({ reference: token, operator, evaluation, postfix: true, depth });
      }
      // A bare name immediately before a simple assignment never reads its old value.
      token.readsValue = operator !== '=';
      return token;
    }
    case 'operator': {
      switch (token.value) {
      case '(': {
        const operand = this.parse({ minimum: COMMA_PRECEDENCE, evaluation, depth: depth + 1 });
        const value = this.read({ operand, evaluation, depth: depth + 1 });
        this.expect({ operator: ')' });
        return value;
      }
      case '++':
      case '--': {
        const target = this.take();
        switch (target.kind) {
        case 'variable':
          this.peek();
          return this.update({ reference: target, operator: token.value, evaluation, postfix: false, depth });
        case 'integer':
        case 'operator':
          throw new WeshArithmeticError('Arithmetic update requires a variable');
        default: {
          const _ex: never = target;
          throw new Error(`Unknown arithmetic token: ${String(_ex)}`);
        }
        }
      }
      case '+':
      case '-':
      case '!':
      case '~': {
        const operand = this.parsePrefix({ evaluation, depth: depth + 1 });
        this.peek();
        const value = this.read({ operand, evaluation, depth: depth + 1 });
        switch (token.value) {
        case '+': return value;
        case '-': return BigInt.asIntN(INTEGER_BITS, -value);
        case '!': return value === 0n ? 1n : 0n;
        case '~': return ~value;
        default: {
          const _ex: never = token.value;
          throw new Error(`Unknown unary arithmetic operator: ${_ex}`);
        }
        }
      }
      default:
        throw new WeshArithmeticError(`Unexpected arithmetic operator: ${token.value}`);
      }
    }
    default: {
      const _ex: never = token;
      throw new Error(`Unknown arithmetic token: ${String(_ex)}`);
    }
    }
  }

  private parse({ minimum, evaluation, depth }: { minimum: number, evaluation: Evaluation, depth: number }): Operand {
    let left = this.parsePrefix({ evaluation, depth });
    while (true) {
      const operator = this.peekOperator();
      if (operator === undefined) {
        return left;
      }
      if (operator === '?' && minimum <= CONDITIONAL_PRECEDENCE) {
        this.take();
        const condition = this.read({ operand: left, evaluation, depth }) !== 0n;
        const whenTrue: Evaluation = condition ? evaluation : 'skip-effects';
        const whenFalse: Evaluation = condition ? 'skip-effects' : evaluation;
        const trueOperand = this.parse({ minimum: COMMA_PRECEDENCE, evaluation: whenTrue, depth: depth + 1 });
        const trueValue = this.read({ operand: trueOperand, evaluation: whenTrue, depth: depth + 1 });
        this.expect({ operator: ':' });
        const falseOperand = this.parse({ minimum: CONDITIONAL_PRECEDENCE, evaluation: whenFalse, depth: depth + 1 });
        const falseValue = this.read({ operand: falseOperand, evaluation: whenFalse, depth: depth + 1 });
        left = condition ? trueValue : falseValue;
        continue;
      }

      const compound = COMPOUND_ASSIGNMENTS.get(operator);
      if ((operator === '=' || compound !== undefined) && minimum <= ASSIGNMENT_PRECEDENCE) {
        if (typeof left === 'bigint') {
          throw new WeshArithmeticError('Arithmetic assignment requires a variable');
        }
        this.take();
        const previous = compound === undefined ? 0n : this.read({ operand: left, evaluation, depth });
        const operand = this.parse({ minimum: ASSIGNMENT_PRECEDENCE, evaluation, depth: depth + 1 });
        const right = this.read({ operand, evaluation, depth: depth + 1 });
        const value = compound === undefined ? right : calculate({ operator: compound, left: previous, right, evaluation });
        left = this.write({ name: left.name, value, evaluation });
        continue;
      }

      const precedence = BINARY_PRECEDENCE.get(operator);
      if (precedence === undefined || precedence < minimum) {
        return left;
      }
      this.take();
      const leftValue = this.read({ operand: left, evaluation, depth });
      const skipRight = (operator === '&&' && leftValue === 0n) || (operator === '||' && leftValue !== 0n);
      const rightEvaluation: Evaluation = skipRight ? 'skip-effects' : evaluation;
      const operand = this.parse({ minimum: operator === '**' ? precedence : precedence + 1, evaluation: rightEvaluation, depth: depth + 1 });
      const right = this.read({ operand, evaluation: rightEvaluation, depth: depth + 1 });
      left = calculate({ operator, left: leftValue, right, evaluation });
    }
  }
}

export function evaluateShellArithmetic({ expression, env }: {
  expression: string,
  env: WeshVariableValues,
}): bigint {
  return new ArithmeticParser({ expression, env, expressionDepth: 0 }).evaluate();
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
