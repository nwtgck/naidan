import type { StandardArgvParserSpec } from '@/services/wesh/argv';
import {
  isStandaloneCommandHelpRequest,
  maybeWriteStandaloneCommandHelp,
  writeCommandUsageError,
} from '@/services/wesh/commands/_shared/usage';
import type {
  WeshCommandContext,
  WeshCommandDefinition,
  WeshCommandResult,
  WeshStat,
} from '@/services/wesh/types';

type TestCommandName = 'test' | '[';
type TestTruthValue = 'true' | 'false';

type TestEvaluationResult =
  | { kind: 'success'; value: TestTruthValue }
  | { kind: 'syntax-error'; message: string };

type TestTokenResult =
  | { kind: 'tokens'; tokens: string[] }
  | { kind: 'syntax-error'; message: string };

type UnaryTestOperator =
  | '-b'
  | '-c'
  | '-d'
  | '-e'
  | '-f'
  | '-h'
  | '-L'
  | '-n'
  | '-p'
  | '-r'
  | '-s'
  | '-t'
  | '-w'
  | '-x'
  | '-z';

type BinaryStringOperator = '=' | '!=';
type BinaryIntegerOperator = '-eq' | '-ge' | '-gt' | '-le' | '-lt' | '-ne';
type BinaryFileOperator = '-ef' | '-nt' | '-ot';
type BinaryTestOperator = BinaryStringOperator | BinaryIntegerOperator | BinaryFileOperator;

type ParsedIntegerOperand =
  | { kind: 'success'; value: number; nextIndex: number }
  | { kind: 'not-integer' }
  | { kind: 'syntax-error'; message: string };

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

const BINARY_FILE_OPERATORS = new Set<BinaryFileOperator>([
  '-ef',
  '-nt',
  '-ot',
]);

const BINARY_STRING_OPERATORS = new Set<BinaryStringOperator>([
  '=',
  '!=',
]);

const testArgvSpec: StandardArgvParserSpec = {
  options: [
    {
      kind: 'flag',
      short: undefined,
      long: 'help',
      effects: [{ key: 'help', value: true }],
      help: { summary: 'display this help and exit', category: 'common' },
    },
  ],
  allowShortFlagBundles: true,
  stopAtDoubleDash: true,
  treatSingleDashAsPositional: true,
  specialTokenParsers: [],
};

function resolvePath({
  cwd,
  path,
}: {
  cwd: string;
  path: string;
}): string {
  return path.startsWith('/') ? path : `${cwd}/${path}`;
}

function truthy({
  value,
}: {
  value: boolean;
}): TestTruthValue {
  return value ? 'true' : 'false';
}

async function readStat({
  context,
  path,
  followSymlinkMode,
}: {
  context: WeshCommandContext;
  path: string;
  followSymlinkMode: 'follow' | 'no-follow';
}): Promise<WeshStat | undefined> {
  try {
    switch (followSymlinkMode) {
    case 'follow':
      return await context.files.stat({ path });
    case 'no-follow':
      return await context.files.lstat({ path });
    default: {
      const _ex: never = followSymlinkMode;
      throw new Error(`Unhandled symlink mode: ${_ex}`);
    }
    }
  } catch {
    return undefined;
  }
}

function hasAccessMode({
  stat,
  accessMode,
}: {
  stat: WeshStat;
  accessMode: 'read' | 'write' | 'execute';
}): boolean {
  switch (accessMode) {
  case 'read':
    return (stat.mode & 0o444) !== 0;
  case 'write':
    return (stat.mode & 0o222) !== 0;
  case 'execute':
    return (stat.mode & 0o111) !== 0;
  default: {
    const _ex: never = accessMode;
    throw new Error(`Unhandled access mode: ${_ex}`);
  }
  }
}

function isBinaryOperator({
  token,
}: {
  token: string | undefined;
}): boolean {
  return token !== undefined &&
    (BINARY_STRING_OPERATORS.has(token as BinaryStringOperator) ||
      BINARY_INTEGER_OPERATORS.has(token as BinaryIntegerOperator) ||
      BINARY_FILE_OPERATORS.has(token as BinaryFileOperator));
}

async function evaluateUnaryOperator({
  context,
  operator,
  operand,
}: {
  context: WeshCommandContext;
  operator: UnaryTestOperator;
  operand: string;
}): Promise<TestTruthValue> {
  switch (operator) {
  case '-n':
    return truthy({ value: operand.length > 0 });
  case '-z':
    return truthy({ value: operand.length === 0 });
  case '-h':
  case '-L': {
    const stat = await readStat({
      context,
      path: resolvePath({ cwd: context.cwd, path: operand }),
      followSymlinkMode: 'no-follow',
    });
    return truthy({ value: stat?.type === 'symlink' });
  }
  case '-e': {
    const stat = await readStat({
      context,
      path: resolvePath({ cwd: context.cwd, path: operand }),
      followSymlinkMode: 'follow',
    });
    return truthy({ value: stat !== undefined });
  }
  case '-d':
  case '-f':
  case '-p':
  case '-c':
  case '-b':
  case '-s':
  case '-r':
  case '-w':
  case '-x': {
    const stat = await readStat({
      context,
      path: resolvePath({ cwd: context.cwd, path: operand }),
      followSymlinkMode: 'follow',
    });
    if (stat === undefined) {
      return 'false';
    }

    switch (operator) {
    case '-d':
      return truthy({ value: stat.type === 'directory' });
    case '-f':
      return truthy({ value: stat.type === 'file' });
    case '-p':
      return truthy({ value: stat.type === 'fifo' });
    case '-c':
      return truthy({ value: stat.type === 'chardev' });
    case '-b':
      return 'false';
    case '-s':
      return truthy({ value: stat.size > 0 });
    case '-r':
      return truthy({ value: hasAccessMode({ stat, accessMode: 'read' }) });
    case '-w':
      return truthy({ value: hasAccessMode({ stat, accessMode: 'write' }) });
    case '-x':
      return truthy({ value: hasAccessMode({ stat, accessMode: 'execute' }) });
    default: {
      const _ex: never = operator;
      throw new Error(`Unhandled unary operator: ${_ex}`);
    }
    }
  }
  case '-t': {
    if (!/^\d+$/.test(operand)) {
      return 'false';
    }
    return truthy({ value: false });
  }
  default: {
    const _ex: never = operator;
    throw new Error(`Unhandled unary operator: ${_ex}`);
  }
  }
}

function parseIntegerOperand({
  tokens,
  startIndex,
}: {
  tokens: string[];
  startIndex: number;
}): ParsedIntegerOperand {
  const token = tokens[startIndex];
  if (token === undefined) {
    return { kind: 'syntax-error', message: 'missing argument after integer operator' };
  }

  if (token === '-l') {
    const stringOperand = tokens[startIndex + 1];
    if (stringOperand === undefined) {
      return { kind: 'syntax-error', message: 'missing argument after -l' };
    }
    return {
      kind: 'success',
      value: stringOperand.length,
      nextIndex: startIndex + 2,
    };
  }

  if (!/^-?\d+$/.test(token)) {
    return { kind: 'not-integer' };
  }

  return {
    kind: 'success',
    value: parseInt(token, 10),
    nextIndex: startIndex + 1,
  };
}

async function evaluateBinaryOperator({
  context,
  leftOperand,
  operator,
  rightOperand,
}: {
  context: WeshCommandContext;
  leftOperand: string;
  operator: BinaryTestOperator;
  rightOperand: string;
}): Promise<TestTruthValue> {
  switch (operator) {
  case '=':
    return truthy({ value: leftOperand === rightOperand });
  case '!=':
    return truthy({ value: leftOperand !== rightOperand });
  case '-eq':
  case '-ge':
  case '-gt':
  case '-le':
  case '-lt':
  case '-ne': {
    const leftValue = parseInt(leftOperand, 10);
    const rightValue = parseInt(rightOperand, 10);
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
    break;
  default: {
    const _ex: never = operator;
    throw new Error(`Unhandled binary operator: ${_ex}`);
  }
  }

  const leftStat = await readStat({
    context,
    path: resolvePath({ cwd: context.cwd, path: leftOperand }),
    followSymlinkMode: 'follow',
  });
  const rightStat = await readStat({
    context,
    path: resolvePath({ cwd: context.cwd, path: rightOperand }),
    followSymlinkMode: 'follow',
  });

  if (leftStat === undefined || rightStat === undefined) {
    return 'false';
  }

  switch (operator) {
  case '-ef':
    return truthy({ value: leftStat.ino === rightStat.ino && leftStat.type === rightStat.type });
  case '-nt':
    return truthy({ value: leftStat.mtime > rightStat.mtime });
  case '-ot':
    return truthy({ value: leftStat.mtime < rightStat.mtime });
  default: {
    const _ex: never = operator;
    throw new Error(`Unhandled file operator: ${_ex}`);
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
    context: WeshCommandContext;
    tokens: string[];
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

    const value = await this.parseOrExpression();
    switch (value.kind) {
    case 'success':
      break;
    case 'syntax-error':
      return value;
    default: {
      const _ex: never = value;
      throw new Error(`Unhandled evaluation result: ${JSON.stringify(_ex)}`);
    }
    }

    if (this.currentToken() !== undefined) {
      return {
        kind: 'syntax-error',
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

  private async parseOrExpression(): Promise<TestEvaluationResult> {
    let left = await this.parseAndExpression();
    switch (left.kind) {
    case 'success':
      break;
    case 'syntax-error':
      return left;
    default: {
      const _ex: never = left;
      throw new Error(`Unhandled evaluation result: ${JSON.stringify(_ex)}`);
    }
    }

    while (this.currentToken() === '-o') {
      this.consumeToken();
      const right = await this.parseAndExpression();
      switch (right.kind) {
      case 'success':
        break;
      case 'syntax-error':
        return right;
      default: {
        const _ex: never = right;
        throw new Error(`Unhandled evaluation result: ${JSON.stringify(_ex)}`);
      }
      }
      left = {
        kind: 'success',
        value: truthy({ value: left.value === 'true' || right.value === 'true' }),
      };
    }

    return left;
  }

  private async parseAndExpression(): Promise<TestEvaluationResult> {
    let left = await this.parseUnaryExpression();
    switch (left.kind) {
    case 'success':
      break;
    case 'syntax-error':
      return left;
    default: {
      const _ex: never = left;
      throw new Error(`Unhandled evaluation result: ${JSON.stringify(_ex)}`);
    }
    }

    while (this.currentToken() === '-a') {
      this.consumeToken();
      const right = await this.parseUnaryExpression();
      switch (right.kind) {
      case 'success':
        break;
      case 'syntax-error':
        return right;
      default: {
        const _ex: never = right;
        throw new Error(`Unhandled evaluation result: ${JSON.stringify(_ex)}`);
      }
      }
      left = {
        kind: 'success',
        value: truthy({ value: left.value === 'true' && right.value === 'true' }),
      };
    }

    return left;
  }

  private async parseUnaryExpression(): Promise<TestEvaluationResult> {
    if (this.currentToken() === '!') {
      this.consumeToken();
      const nested = await this.parseUnaryExpression();
      switch (nested.kind) {
      case 'success':
        break;
      case 'syntax-error':
        return nested;
      default: {
        const _ex: never = nested;
        throw new Error(`Unhandled evaluation result: ${JSON.stringify(_ex)}`);
      }
      }

      return {
        kind: 'success',
        value: truthy({ value: nested.value === 'false' }),
      };
    }

    return this.parsePrimaryExpression();
  }

  private async parsePrimaryExpression(): Promise<TestEvaluationResult> {
    const token = this.currentToken();
    if (token === undefined) {
      return {
        kind: 'syntax-error',
        message: 'missing argument',
      };
    }

    if (token === '(') {
      this.consumeToken();
      const nested = await this.parseOrExpression();
      switch (nested.kind) {
      case 'success':
        break;
      case 'syntax-error':
        return nested;
      default: {
        const _ex: never = nested;
        throw new Error(`Unhandled evaluation result: ${JSON.stringify(_ex)}`);
      }
      }
      if (this.currentToken() !== ')') {
        return {
          kind: 'syntax-error',
          message: "missing ')'",
        };
      }
      this.consumeToken();
      return nested;
    }

    if (UNARY_TEST_OPERATORS.has(token as UnaryTestOperator)) {
      this.consumeToken();
      const operand = this.consumeToken();
      if (operand === undefined) {
        return {
          kind: 'syntax-error',
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
    case 'syntax-error':
      return integerLeft;
    case 'not-integer':
      break;
    case 'success': {
      const integerOperator = this.tokens[integerLeft.nextIndex];
      if (integerOperator !== undefined && BINARY_INTEGER_OPERATORS.has(integerOperator as BinaryIntegerOperator)) {
        if (this.tokens[integerLeft.nextIndex + 1] === undefined) {
          return {
            kind: 'syntax-error',
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
        case 'syntax-error':
          return integerRight;
        case 'not-integer':
          return { kind: 'syntax-error', message: `expected integer after '${integerOperator}'` };
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
        kind: 'syntax-error',
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
        kind: 'syntax-error',
        message: `missing argument after '${binaryOperator}'`,
      };
    }

    if (BINARY_INTEGER_OPERATORS.has(binaryOperator as BinaryIntegerOperator)) {
      return {
        kind: 'syntax-error',
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

function getExpressionTokens({
  args,
  commandName,
}: {
  args: string[];
  commandName: TestCommandName;
}): TestTokenResult {
  switch (commandName) {
  case '[':
    if (args.length === 0 || args[args.length - 1] !== ']') {
      return {
        kind: 'syntax-error',
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

function createTestCommandDefinition({
  commandName,
}: {
  commandName: TestCommandName;
}): WeshCommandDefinition {
  return {
    meta: {
      name: commandName,
      description: 'Evaluate shell conditional expressions',
      usage: (() => {
        switch (commandName) {
        case '[':
          return '[ EXPRESSION ]';
        case 'test':
          return 'test EXPRESSION';
        default: {
          const _ex: never = commandName;
          throw new Error(`Unhandled test command name: ${_ex}`);
        }
        }
      })(),
    },
    fn: async ({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> => {
      const helpStatus = await maybeWriteStandaloneCommandHelp({
        context,
        command: commandName,
        argvSpec: testArgvSpec,
        mode: (() => {
          switch (commandName) {
          case 'test':
            return isStandaloneCommandHelpRequest({
              args: context.args,
              acceptedForms: [['--help']],
            }) ? 'help-requested' : 'not-requested';
          case '[':
            return isStandaloneCommandHelpRequest({
              args: context.args,
              acceptedForms: [['--help', ']']],
            }) ? 'help-requested' : 'not-requested';
          default: {
            const _ex: never = commandName;
            throw new Error(`Unhandled test command name: ${_ex}`);
          }
          }
        })(),
      });
      switch (helpStatus) {
      case 'handled':
        return { exitCode: 0 };
      case 'not-handled':
        break;
      default: {
        const _ex: never = helpStatus;
        throw new Error(`Unhandled help status: ${_ex}`);
      }
      }

      const tokenResult = getExpressionTokens({
        args: context.args,
        commandName,
      });

      switch (tokenResult.kind) {
      case 'tokens':
        break;
      case 'syntax-error':
        await writeCommandUsageError({
          context,
          command: commandName,
          message: `${commandName}: ${tokenResult.message}`,
          argvSpec: testArgvSpec,
        });
        return { exitCode: 2 };
      default: {
        const _ex: never = tokenResult;
        throw new Error(`Unhandled token result: ${JSON.stringify(_ex)}`);
      }
      }

      const parser = new TestExpressionParser({
        context,
        tokens: tokenResult.tokens,
      });
      const evaluation = await parser.parse();
      switch (evaluation.kind) {
      case 'success':
        break;
      case 'syntax-error':
        await writeCommandUsageError({
          context,
          command: commandName,
          message: `${commandName}: ${evaluation.message}`,
          argvSpec: testArgvSpec,
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

export const testCommandDefinition = createTestCommandDefinition({
  commandName: 'test',
});

export const leftBracketCommandDefinition = createTestCommandDefinition({
  commandName: '[',
});
