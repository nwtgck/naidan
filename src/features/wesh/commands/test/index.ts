import { stripLeadingCLocaleAndTrailingBlankWhitespace } from '@/features/wesh/commands/_shared/numeric-whitespace';
import { writeCommandUsageError } from '@/features/wesh/commands/_shared/usage-output';
import {
  evaluateBinaryFileTest,
  evaluateUnaryFileTest,
  type BinaryFileTestOperator,
  type UnaryFileTestOperator,
} from '@/features/wesh/shell/file-test';
import type {
  WeshCommandContext,
  WeshCommandImplementation,
  WeshCommandResult,
} from '@/features/wesh/types';

type TestCommandName = 'test' | '[';
type TestTruthValue = 'true' | 'false';

type TestEvaluationResult =
  | { kind: 'success', value: TestTruthValue }
  | { kind: 'syntax_error', message: string };

type TestTokenResult =
  | { kind: 'tokens', tokens: string[] }
  | { kind: 'syntax_error', message: string };

type UnaryTestOperator = UnaryFileTestOperator | '-n' | '-z';

type BinaryStringOperator = '=' | '!=' | '<' | '>';
type BinaryIntegerOperator = '-eq' | '-ge' | '-gt' | '-le' | '-lt' | '-ne';
type BinaryTestOperator = BinaryStringOperator | BinaryIntegerOperator | BinaryFileTestOperator;

type ParsedIntegerOperand =
  | { kind: 'success', value: bigint, nextIndex: number }
  | { kind: 'not_integer' }
  | { kind: 'syntax_error', message: string };

type TestParserTask =
  | { kind: 'parse_or' }
  | { kind: 'continue_or' }
  | { kind: 'combine_or', left: TestTruthValue }
  | { kind: 'parse_and' }
  | { kind: 'continue_and' }
  | { kind: 'combine_and', left: TestTruthValue }
  | { kind: 'parse_unary' }
  | { kind: 'negate' }
  | { kind: 'parse_primary' }
  | { kind: 'close_group' };

const UNARY_TEST_OPERATORS = new Set<UnaryTestOperator>([
  '-b',
  '-c',
  '-d',
  '-e',
  '-f',
  '-h',
  '-L',
  '-n',
  '-p',
  '-r',
  '-s',
  '-S',
  '-t',
  '-w',
  '-x',
  '-z',
]);

const BINARY_INTEGER_OPERATORS = new Set<BinaryIntegerOperator>([
  '-eq',
  '-ge',
  '-gt',
  '-le',
  '-lt',
  '-ne',
]);

const BINARY_FILE_OPERATORS = new Set<BinaryFileTestOperator>([
  '-ef',
  '-nt',
  '-ot',
]);


const BINARY_STRING_OPERATORS = new Set<BinaryStringOperator>([
  '=',
  '!=',
  '<',
  '>',
]);

function truthy({
  value,
}: {
  value: boolean,
}): TestTruthValue {
  return value ? 'true' : 'false';
}

function negateTestEvaluation({
  evaluation,
}: {
  evaluation: TestEvaluationResult,
}): TestEvaluationResult {
  switch (evaluation.kind) {
  case 'syntax_error':
    return evaluation;
  case 'success':
    return {
      kind: 'success',
      value: truthy({ value: evaluation.value === 'false' }),
    };
  default: {
    const _ex: never = evaluation;
    throw new Error(`Unhandled evaluation result: ${JSON.stringify(_ex)}`);
  }
  }
}

function isBinaryOperator({
  token,
}: {
  token: string | undefined,
}): boolean {
  return token !== undefined &&
    (BINARY_STRING_OPERATORS.has(token as BinaryStringOperator) ||
      BINARY_INTEGER_OPERATORS.has(token as BinaryIntegerOperator) ||
      BINARY_FILE_OPERATORS.has(token as BinaryFileTestOperator));
}

async function evaluateUnaryOperator({
  context,
  operator,
  operand,
}: {
  context: WeshCommandContext,
  operator: UnaryTestOperator,
  operand: string,
}): Promise<TestTruthValue> {
  switch (operator) {
  case '-n':
    return truthy({ value: operand.length > 0 });
  case '-z':
    return truthy({ value: operand.length === 0 });
  default:
    return truthy({
      value: await evaluateUnaryFileTest({ operator, operand, cwd: context.cwd, files: context.files }),
    });
  }
}

function parseIntegerOperand({
  tokens,
  startIndex,
}: {
  tokens: string[],
  startIndex: number,
}): ParsedIntegerOperand {
  const token = tokens[startIndex];
  if (token === undefined) {
    return { kind: 'syntax_error', message: 'missing argument after integer operator' };
  }

  if (token === '-l') {
    const stringOperand = tokens[startIndex + 1];
    if (stringOperand === undefined) {
      return { kind: 'syntax_error', message: 'missing argument after -l' };
    }
    return {
      kind: 'success',
      value: BigInt(stringOperand.length),
      nextIndex: startIndex + 2,
    };
  }

  const numericText = stripLeadingCLocaleAndTrailingBlankWhitespace({ value: token });
  if (!/^[+-]?\d+$/.test(numericText)) {
    return { kind: 'not_integer' };
  }

  return {
    kind: 'success',
    value: BigInt(numericText),
    nextIndex: startIndex + 1,
  };
}

async function evaluateBinaryOperator({
  context,
  leftOperand,
  operator,
  rightOperand,
}: {
  context: WeshCommandContext,
  leftOperand: string,
  operator: BinaryTestOperator,
  rightOperand: string,
}): Promise<TestTruthValue> {
  switch (operator) {
  case '=':
    return truthy({ value: leftOperand === rightOperand });
  case '!=':
    return truthy({ value: leftOperand !== rightOperand });
  case '<':
    return truthy({ value: leftOperand < rightOperand });
  case '>':
    return truthy({ value: leftOperand > rightOperand });
  case '-eq':
  case '-ge':
  case '-gt':
  case '-le':
  case '-lt':
  case '-ne': {
    const leftValue = BigInt(leftOperand);
    const rightValue = BigInt(rightOperand);
    switch (operator) {
    case '-eq':
      return truthy({ value: leftValue === rightValue });
    case '-ge':
      return truthy({ value: leftValue >= rightValue });
    case '-gt':
      return truthy({ value: leftValue > rightValue });
    case '-le':
      return truthy({ value: leftValue <= rightValue });
    case '-lt':
      return truthy({ value: leftValue < rightValue });
    case '-ne':
      return truthy({ value: leftValue !== rightValue });
    default: {
      const _ex: never = operator;
      throw new Error(`Unhandled integer operator: ${_ex}`);
    }
    }
  }
  case '-ef':
  case '-nt':
  case '-ot':
    return truthy({
      value: await evaluateBinaryFileTest({ operator, leftOperand, rightOperand, cwd: context.cwd, files: context.files }),
    });
  default: {
    const _ex: never = operator;
    throw new Error(`Unhandled binary operator: ${_ex}`);
  }
  }
}

class TestExpressionParser {
  private readonly context: WeshCommandContext;
  private readonly tokens: string[];
  private index: number = 0;

  constructor({
    context,
    tokens,
  }: {
    context: WeshCommandContext,
    tokens: string[],
  }) {
    this.context = context;
    this.tokens = tokens;
  }

  async parse(): Promise<TestEvaluationResult> {
    if (this.tokens.length === 0) {
      return {
        kind: 'success',
        value: 'false',
      };
    }

    if (this.tokens.length === 1) {
      return {
        kind: 'success',
        value: truthy({ value: this.tokens[0]?.length !== 0 }),
      };
    }

    if (this.tokens.length === 2 && this.tokens[0] === '!') {
      return {
        kind: 'success',
        value: truthy({ value: this.tokens[1]?.length === 0 }),
      };
    }

    if (this.tokens.length === 3) {
      if (isBinaryOperator({ token: this.tokens[1] })) {
        const leftOperand = this.tokens[0]!;
        const operator = this.tokens[1] as BinaryTestOperator;
        const rightOperand = this.tokens[2]!;

        if (BINARY_INTEGER_OPERATORS.has(operator as BinaryIntegerOperator)) {
          const leftInteger = parseIntegerOperand({ tokens: [leftOperand], startIndex: 0 });
          const rightInteger = parseIntegerOperand({ tokens: [rightOperand], startIndex: 0 });
          if (leftInteger.kind !== 'success' || rightInteger.kind !== 'success') {
            return {
              kind: 'syntax_error',
              message: `expected integer expression around '${operator}'`,
            };
          }
          return {
            kind: 'success',
            value: await evaluateBinaryOperator({
              context: this.context,
              leftOperand: leftInteger.value.toString(),
              operator,
              rightOperand: rightInteger.value.toString(),
            }),
          };
        }

        return {
          kind: 'success',
          value: await evaluateBinaryOperator({
            context: this.context,
            leftOperand,
            operator,
            rightOperand,
          }),
        };
      }

      if (this.tokens[0] === '!') {
        return negateTestEvaluation({
          evaluation: await evaluateTestExpression({
            context: this.context,
            tokens: this.tokens.slice(1),
          }),
        });
      }

      if (this.tokens[0] === '(' && this.tokens[2] === ')') {
        return await evaluateTestExpression({
          context: this.context,
          tokens: this.tokens.slice(1, -1),
        });
      }
    }

    if (this.tokens.length === 4) {
      if (this.tokens[0] === '!') {
        return negateTestEvaluation({
          evaluation: await evaluateTestExpression({
            context: this.context,
            tokens: this.tokens.slice(1),
          }),
        });
      }

      if (this.tokens[0] === '(' && this.tokens[3] === ')') {
        return await evaluateTestExpression({
          context: this.context,
          tokens: this.tokens.slice(1, -1),
        });
      }
    }

    const value = await this.parseExpressionIteratively();
    switch (value.kind) {
    case 'success':
      break;
    case 'syntax_error':
      return value;
    default: {
      const _ex: never = value;
      throw new Error(`Unhandled evaluation result: ${JSON.stringify(_ex)}`);
    }
    }

    if (this.currentToken() !== undefined) {
      return {
        kind: 'syntax_error',
        message: `unexpected argument '${this.currentToken()}'`,
      };
    }

    return value;
  }

  private currentToken(): string | undefined {
    return this.tokens[this.index];
  }

  private consumeToken(): string | undefined {
    const token = this.tokens[this.index];
    if (token !== undefined) {
      this.index += 1;
    }
    return token;
  }

  private popEvaluation({
    values,
  }: {
    values: TestEvaluationResult[],
  }): TestEvaluationResult {
    const value = values.pop();
    if (value === undefined) {
      throw new Error('test parser evaluation stack underflow');
    }
    return value;
  }

  private async parseExpressionIteratively(): Promise<TestEvaluationResult> {
    const tasks: TestParserTask[] = [{ kind: 'parse_or' }];
    const values: TestEvaluationResult[] = [];

    while (tasks.length > 0) {
      const task = tasks.pop();
      if (task === undefined) {
        throw new Error('test parser task stack underflow');
      }

      switch (task.kind) {
      case 'parse_or':
        tasks.push({ kind: 'continue_or' });
        tasks.push({ kind: 'parse_and' });
        break;
      case 'continue_or': {
        const left = this.popEvaluation({ values });
        switch (left.kind) {
        case 'syntax_error':
          values.push(left);
          break;
        case 'success':
          if (this.currentToken() !== '-o') {
            values.push(left);
            break;
          }
          this.consumeToken();
          tasks.push({ kind: 'continue_or' });
          tasks.push({ kind: 'combine_or', left: left.value });
          tasks.push({ kind: 'parse_and' });
          break;
        default: {
          const _ex: never = left;
          throw new Error(`Unhandled evaluation result: ${JSON.stringify(_ex)}`);
        }
        }
        break;
      }
      case 'combine_or': {
        const right = this.popEvaluation({ values });
        switch (right.kind) {
        case 'syntax_error':
          values.push(right);
          break;
        case 'success':
          values.push({
            kind: 'success',
            value: truthy({ value: task.left === 'true' || right.value === 'true' }),
          });
          break;
        default: {
          const _ex: never = right;
          throw new Error(`Unhandled evaluation result: ${JSON.stringify(_ex)}`);
        }
        }
        break;
      }
      case 'parse_and':
        tasks.push({ kind: 'continue_and' });
        tasks.push({ kind: 'parse_unary' });
        break;
      case 'continue_and': {
        const left = this.popEvaluation({ values });
        switch (left.kind) {
        case 'syntax_error':
          values.push(left);
          break;
        case 'success':
          if (this.currentToken() !== '-a') {
            values.push(left);
            break;
          }
          this.consumeToken();
          tasks.push({ kind: 'continue_and' });
          tasks.push({ kind: 'combine_and', left: left.value });
          tasks.push({ kind: 'parse_unary' });
          break;
        default: {
          const _ex: never = left;
          throw new Error(`Unhandled evaluation result: ${JSON.stringify(_ex)}`);
        }
        }
        break;
      }
      case 'combine_and': {
        const right = this.popEvaluation({ values });
        switch (right.kind) {
        case 'syntax_error':
          values.push(right);
          break;
        case 'success':
          values.push({
            kind: 'success',
            value: truthy({ value: task.left === 'true' && right.value === 'true' }),
          });
          break;
        default: {
          const _ex: never = right;
          throw new Error(`Unhandled evaluation result: ${JSON.stringify(_ex)}`);
        }
        }
        break;
      }
      case 'parse_unary':
        if (this.currentToken() === '!') {
          this.consumeToken();
          tasks.push({ kind: 'negate' });
          tasks.push({ kind: 'parse_unary' });
        } else {
          tasks.push({ kind: 'parse_primary' });
        }
        break;
      case 'negate':
        values.push(negateTestEvaluation({
          evaluation: this.popEvaluation({ values }),
        }));
        break;
      case 'parse_primary': {
        if (this.currentToken() === '(') {
          const smallGrouped = await this.tryParseSmallGroupedExpression();
          if (smallGrouped !== undefined) {
            values.push(smallGrouped);
            break;
          }
          this.consumeToken();
          tasks.push({ kind: 'close_group' });
          tasks.push({ kind: 'parse_or' });
        } else {
          values.push(await this.parseNonGroupedPrimaryExpression());
        }
        break;
      }
      case 'close_group': {
        const nested = this.popEvaluation({ values });
        switch (nested.kind) {
        case 'syntax_error':
          values.push(nested);
          break;
        case 'success':
          if (this.currentToken() !== ')') {
            values.push({
              kind: 'syntax_error',
              message: "missing ')'",
            });
          } else {
            this.consumeToken();
            values.push(nested);
          }
          break;
        default: {
          const _ex: never = nested;
          throw new Error(`Unhandled evaluation result: ${JSON.stringify(_ex)}`);
        }
        }
        break;
      }
      default: {
        const _ex: never = task;
        throw new Error(`Unhandled test parser task: ${JSON.stringify(_ex)}`);
      }
      }
    }

    if (values.length !== 1) {
      throw new Error(`test parser produced ${values.length} evaluation results`);
    }
    return this.popEvaluation({ values });
  }

  private async tryParseSmallGroupedExpression(): Promise<TestEvaluationResult | undefined> {
    // GNU test reapplies its historical argument-count rules inside a parenthesized
    // expression. Preserve the iterative parser for arbitrary/deep groups, but route
    // small groups without nested parentheses through the same 1-4 argument entry
    // rules used at top level. This keeps deeply nested input stack-safe while matching
    // cases such as `( ! a -o b )`, where the four-argument leading-! rule matters.
    for (let contentLength = 1; contentLength <= 4; contentLength += 1) {
      const closingIndex = this.index + contentLength + 1;
      if (this.tokens[closingIndex] !== ')') {
        continue;
      }

      const content = this.tokens.slice(this.index + 1, closingIndex);
      if (content.some(token => token === '(' || token === ')')) {
        continue;
      }

      const grouped = await evaluateTestExpression({
        context: this.context,
        tokens: content,
      });
      this.index = closingIndex + 1;
      return grouped;
    }

    return undefined;
  }

  private async parseNonGroupedPrimaryExpression(): Promise<TestEvaluationResult> {
    const token = this.currentToken();
    if (token === undefined) {
      return {
        kind: 'syntax_error',
        message: 'missing argument',
      };
    }

    if (UNARY_TEST_OPERATORS.has(token as UnaryTestOperator)) {
      this.consumeToken();
      const operand = this.consumeToken();
      if (operand === undefined) {
        return {
          kind: 'syntax_error',
          message: `missing argument after '${token}'`,
        };
      }

      return {
        kind: 'success',
        value: await evaluateUnaryOperator({
          context: this.context,
          operator: token as UnaryTestOperator,
          operand,
        }),
      };
    }

    const integerLeft = parseIntegerOperand({
      tokens: this.tokens,
      startIndex: this.index,
    });
    switch (integerLeft.kind) {
    case 'syntax_error':
      return integerLeft;
    case 'not_integer':
      break;
    case 'success': {
      const integerOperator = this.tokens[integerLeft.nextIndex];
      if (integerOperator !== undefined && BINARY_INTEGER_OPERATORS.has(integerOperator as BinaryIntegerOperator)) {
        if (this.tokens[integerLeft.nextIndex + 1] === undefined) {
          return {
            kind: 'syntax_error',
            message: `expected integer after '${integerOperator}'`,
          };
        }
        const integerRight = parseIntegerOperand({
          tokens: this.tokens,
          startIndex: integerLeft.nextIndex + 1,
        });
        switch (integerRight.kind) {
        case 'success':
          break;
        case 'syntax_error':
          return integerRight;
        case 'not_integer':
          return { kind: 'syntax_error', message: `expected integer after '${integerOperator}'` };
        default: {
          const _ex: never = integerRight;
          throw new Error(`Unhandled integer operand result: ${JSON.stringify(_ex)}`);
        }
        }

        this.index = integerRight.nextIndex;
        const typedIntegerOperator = integerOperator as BinaryIntegerOperator;
        return {
          kind: 'success',
          value: await evaluateBinaryOperator({
            context: this.context,
            leftOperand: integerLeft.value.toString(),
            operator: typedIntegerOperator,
            rightOperand: integerRight.value.toString(),
          }),
        };
      }
      break;
    }
    default: {
      const _ex: never = integerLeft;
      throw new Error(`Unhandled integer operand result: ${JSON.stringify(_ex)}`);
    }
    }

    const leftOperand = this.consumeToken();
    if (leftOperand === undefined) {
      return {
        kind: 'syntax_error',
        message: 'missing argument',
      };
    }

    const operator = this.currentToken();
    if (!isBinaryOperator({ token: operator })) {
      return {
        kind: 'success',
        value: truthy({ value: leftOperand.length > 0 }),
      };
    }
    const binaryOperator = operator as BinaryTestOperator;

    this.consumeToken();
    const rightOperand = this.consumeToken();
    if (rightOperand === undefined) {
      return {
        kind: 'syntax_error',
        message: `missing argument after '${binaryOperator}'`,
      };
    }

    if (BINARY_INTEGER_OPERATORS.has(binaryOperator as BinaryIntegerOperator)) {
      return {
        kind: 'syntax_error',
        message: `expected integer expression before '${binaryOperator}'`,
      };
    }

    return {
      kind: 'success',
      value: await evaluateBinaryOperator({
        context: this.context,
        leftOperand,
        operator: binaryOperator,
        rightOperand,
      }),
    };
  }

}


async function evaluateTestExpression({
  context,
  tokens,
}: {
  context: WeshCommandContext,
  tokens: string[],
}): Promise<TestEvaluationResult> {
  const parser = new TestExpressionParser({ context, tokens });
  return await parser.parse();
}

function getExpressionTokens({
  args,
  commandName,
}: {
  args: string[],
  commandName: TestCommandName,
}): TestTokenResult {
  switch (commandName) {
  case '[':
    if (args.length === 0 || args[args.length - 1] !== ']') {
      return {
        kind: 'syntax_error',
        message: "missing ']'",
      };
    }
    return {
      kind: 'tokens',
      tokens: args.slice(0, -1),
    };
  case 'test':
    return {
      kind: 'tokens',
      tokens: args,
    };
  default: {
    const _ex: never = commandName;
    throw new Error(`Unhandled test command name: ${_ex}`);
  }
  }
}

export function createTestCommandImplementation({
  commandName,
}: {
  commandName: TestCommandName,
}): WeshCommandImplementation {
  return {
    fn: async ({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> => {

      const tokenResult = getExpressionTokens({
        args: context.args,
        commandName,
      });

      switch (tokenResult.kind) {
      case 'tokens':
        break;
      case 'syntax_error':
        await writeCommandUsageError({
          context,
          command: commandName,
          message: `${commandName}: ${tokenResult.message}`,
          usageSummary: undefined,
        });
        return { exitCode: 2 };
      default: {
        const _ex: never = tokenResult;
        throw new Error(`Unhandled token result: ${JSON.stringify(_ex)}`);
      }
      }

      const evaluation = await evaluateTestExpression({
        context,
        tokens: tokenResult.tokens,
      });
      switch (evaluation.kind) {
      case 'success':
        break;
      case 'syntax_error':
        await writeCommandUsageError({
          context,
          command: commandName,
          message: `${commandName}: ${evaluation.message}`,
          usageSummary: undefined,
        });
        return { exitCode: 2 };
      default: {
        const _ex: never = evaluation;
        throw new Error(`Unhandled evaluation result: ${JSON.stringify(_ex)}`);
      }
      }

      return {
        exitCode: (() => {
          switch (evaluation.value) {
          case 'true':
            return 0;
          case 'false':
            return 1;
          default: {
            const _ex: never = evaluation.value;
            throw new Error(`Unhandled truth value: ${_ex}`);
          }
          }
        })(),
      };
    },
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
  evaluateTestExpression,
};
