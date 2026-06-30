import { parseFindLikeArgv } from '@/features/wesh/argv';
import type { StandardArgvParserSpec } from '@/features/wesh/argv';
import {
  isStandaloneCommandHelpRequest,
  maybeWriteStandaloneCommandHelp,
  writeCommandUsageError,
} from '@/features/wesh/commands/_shared/usage';
import type {
  WeshCommandContext,
  WeshCommandDefinition,
  WeshCommandResult,
  WeshEntryRef,
  WeshFileType,
} from '@/features/wesh/types';
import { createBufferedTextWriter } from '@/features/wesh/utils/io';

type FindExpression =
  | { kind: 'and', left: FindExpression, right: FindExpression }
  | { kind: 'or', left: FindExpression, right: FindExpression }
  | { kind: 'not', expr: FindExpression }
  | { kind: 'name', pattern: string, caseInsensitive: boolean, compiledPattern: RegExp }
  | { kind: 'path', pattern: string, compiledPattern: RegExp }
  | { kind: 'regex', pattern: RegExp }
  | { kind: 'type', expected: WeshFileType }
  | { kind: 'empty' }
  | { kind: 'size', comparison: 'eq' | 'lt' | 'gt', sizeInBytes: number }
  | { kind: 'perm', matchMode: 'exact' | 'all' | 'any', mode: number }
  | { kind: 'newer', referencePath: string, referenceMtime: number }
  | { kind: 'print' }
  | { kind: 'print0' }
  | { kind: 'prune' }
  | { kind: 'delete' }
  | { kind: 'quit' }
  | { kind: 'true' }
  | { kind: 'false' }
  | { kind: 'exec', id: number, mode: 'single' | 'batch', command: string, args: string[] };

interface FindEntry {
  entryRef: WeshEntryRef,
  fullPath: string,
  displayPath: string,
  type: WeshFileType,
  name: string,
  size: number,
  mtime: number,
}

interface FindEvaluationResult {
  matched: boolean,
  actionInvoked: boolean,
  shouldPrune: boolean,
  shouldQuit: boolean,
  exitCode: number,
}

const EVAL_MATCHED: FindEvaluationResult = { matched: true, actionInvoked: false, shouldPrune: false, shouldQuit: false, exitCode: 0 };
const EVAL_NOT_MATCHED: FindEvaluationResult = { matched: false, actionInvoked: false, shouldPrune: false, shouldQuit: false, exitCode: 0 };

interface PendingExecBatchEntry {
  path: string,
  entryRef: WeshEntryRef,
}

interface PendingExecBatch {
  id: number,
  command: string,
  argsTemplate: string[],
  entries: PendingExecBatchEntry[],
  argumentBytes: number,
}

interface ExecInvocation {
  args: string[],
  argumentEntryRefs: Array<WeshEntryRef | undefined>,
}

type FindOutputWriter = ReturnType<typeof createBufferedTextWriter>;

const MAX_EXEC_BATCH_PATH_COUNT = 512;
const MAX_EXEC_BATCH_ARGUMENT_BYTES = 128 * 1024;
const utf8Encoder = new TextEncoder();

interface FindTraversalOptions {
  maxDepth: number | undefined,
  minDepth: number,
  depthFirst: boolean,
  symlinkMode: 'physical' | 'command-line' | 'logical',
}

function canEvaluateWithoutFullStat({
  expr,
}: {
  expr: FindExpression,
}): boolean {
  switch (expr.kind) {
  case 'and':
  case 'or':
    return canEvaluateWithoutFullStat({ expr: expr.left }) && canEvaluateWithoutFullStat({ expr: expr.right });
  case 'not':
    return canEvaluateWithoutFullStat({ expr: expr.expr });
  case 'name':
  case 'path':
  case 'regex':
  case 'type':
  case 'print':
  case 'print0':
  case 'prune':
  case 'delete':
  case 'quit':
  case 'true':
  case 'false':
  case 'exec':
    return true;
  case 'empty':
  case 'size':
  case 'perm':
  case 'newer':
    return false;
  default: {
    const _ex: never = expr;
    throw new Error(`Unhandled find expression: ${_ex}`);
  }
  }
}

const findHelpArgvSpec: StandardArgvParserSpec = {
  options: [
    { kind: 'flag', short: 'H', long: undefined, effects: [{ key: 'symlinkMode', value: 'command-line' }], help: { summary: 'follow command-line symbolic links', category: 'advanced' } },
    { kind: 'flag', short: 'L', long: undefined, effects: [{ key: 'symlinkMode', value: 'logical' }], help: { summary: 'follow symbolic links', category: 'advanced' } },
    { kind: 'flag', short: 'P', long: undefined, effects: [{ key: 'symlinkMode', value: 'physical' }], help: { summary: 'never follow symbolic links', category: 'advanced' } },
    { kind: 'flag', short: undefined, long: 'help', effects: [{ key: 'help', value: true }], help: { summary: 'display this help and exit', category: 'common' } },
  ],
  allowShortFlagBundles: true,
  stopAtDoubleDash: true,
  treatSingleDashAsPositional: true,
  specialTokenParsers: [],
};

function resolvePath({ cwd, path }: { cwd: string, path: string }): string {
  if (path.startsWith('/')) {
    return path;
  }
  return cwd === '/' ? `/${path}` : `${cwd}/${path}`;
}

function basename({ path }: { path: string }): string {
  if (path === '/') return '/';
  const normalized = path.endsWith('/') && path.length > 1 ? path.slice(0, -1) : path;
  const parts = normalized.split('/');
  return parts[parts.length - 1] ?? normalized;
}

function globToRegExp({
  pattern,
  caseInsensitive,
}: {
  pattern: string,
  caseInsensitive: boolean,
}): RegExp {
  let source = '^';

  for (let index = 0; index < pattern.length; index++) {
    const char = pattern[index];
    if (char === undefined) continue;

    if (char === '*') {
      source += '.*';
      continue;
    }

    if (char === '?') {
      source += '.';
      continue;
    }

    if (char === '[') {
      const endIndex = pattern.indexOf(']', index + 1);
      if (endIndex > index) {
        source += pattern.slice(index, endIndex + 1);
        index = endIndex;
        continue;
      }
    }

    source += char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  source += '$';
  return new RegExp(source, caseInsensitive ? 'i' : undefined);
}

function parseNonNegativeInteger({
  value,
  optionName,
}: {
  value: string,
  optionName: string,
}): { ok: true, value: number } | { ok: false, message: string } {
  if (!/^\d+$/.test(value)) {
    return { ok: false, message: `invalid argument to ${optionName}: ${value}` };
  }

  return { ok: true, value: parseInt(value, 10) };
}

function parseFindRegex({
  value,
}: {
  value: string,
}): { ok: true, value: RegExp } | { ok: false, message: string } {
  try {
    return { ok: true, value: new RegExp(value) };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, message: `invalid regular expression '${value}': ${message}` };
  }
}

function parseFindSize({
  value,
}: {
  value: string,
}): { ok: true, comparison: 'eq' | 'lt' | 'gt', sizeInBytes: number } | { ok: false, message: string } {
  const match = value.match(/^([+-]?)(\d+)([ckMGT]?)$/);
  if (match === null) {
    return { ok: false, message: `invalid argument to -size: ${value}` };
  }

  const prefix = match[1] ?? '';
  const count = parseInt(match[2] ?? '0', 10);
  const unit = match[3] ?? '';
  const multiplier = (() => {
    switch (unit) {
    case '':
    case 'c':
      return 1;
    case 'k':
      return 1024;
    case 'M':
      return 1024 * 1024;
    case 'G':
      return 1024 * 1024 * 1024;
    case 'T':
      return 1024 * 1024 * 1024 * 1024;
    default:
      return 1;
    }
  })();

  return {
    ok: true,
    comparison: prefix === '+' ? 'gt' : prefix === '-' ? 'lt' : 'eq',
    sizeInBytes: count * multiplier,
  };
}

function parseFindPerm({
  value,
}: {
  value: string,
}): { ok: true, matchMode: 'exact' | 'all' | 'any', mode: number } | { ok: false, message: string } {
  const match = value.match(/^([-/]?)([0-7]+)$/);
  if (match === null) {
    return { ok: false, message: `invalid argument to -perm: ${value}` };
  }

  const prefix = match[1] ?? '';
  const digits = match[2] ?? '';
  const mode = Number.parseInt(digits, 8);

  return {
    ok: true,
    matchMode: prefix === '-' ? 'all' : prefix === '/' ? 'any' : 'exact',
    mode,
  };
}

function splitFindLeadingOptions({
  args,
}: {
  args: string[],
}): {
  leadingOptions: string[],
  remainingArgs: string[],
} {
  const leadingOptions: string[] = [];
  let index = 0;

  while (index < args.length) {
    const token = args[index];
    if (token !== '-H' && token !== '-L' && token !== '-P') {
      break;
    }
    leadingOptions.push(token);
    index += 1;
  }

  return {
    leadingOptions,
    remainingArgs: args.slice(index),
  };
}

function tokenizeFindExpression({
  tokens,
}: {
  tokens: string[],
}): {
  ok: true,
  traversal: FindTraversalOptions,
  expr: FindExpression,
  hasAction: boolean,
} | {
  ok: false,
  message: string,
} {
  let index = 0;
  let nextExecId = 1;
  const expressionTokens: string[] = [];
  const traversal: FindTraversalOptions = {
    maxDepth: undefined,
    minDepth: 0,
    depthFirst: false,
    symlinkMode: 'physical',
  };

  while (index < tokens.length) {
    const token = tokens[index];
    if (token === undefined) break;

    if (token === '-maxdepth' || token === '-mindepth') {
      const valueToken = tokens[index + 1];
      if (valueToken === undefined) {
        return { ok: false, message: `missing argument to '${token}'` };
      }

      const parsed = parseNonNegativeInteger({ value: valueToken, optionName: token });
      if (!parsed.ok) return parsed;

      switch (token) {
      case '-maxdepth':
        traversal.maxDepth = parsed.value;
        break;
      case '-mindepth':
        traversal.minDepth = parsed.value;
        break;
      default: {
        const _ex: never = token;
        throw new Error(`Unhandled traversal token: ${_ex}`);
      }
      }

      index += 2;
      continue;
    }

    if (token === '-depth') {
      traversal.depthFirst = true;
      index += 1;
      continue;
    }

    if (token === '-P' || token === '-H' || token === '-L') {
      switch (token) {
      case '-P':
        traversal.symlinkMode = 'physical';
        break;
      case '-H':
        traversal.symlinkMode = 'command-line';
        break;
      case '-L':
        traversal.symlinkMode = 'logical';
        break;
      default: {
        const _ex: never = token;
        throw new Error(`Unhandled symlink token: ${_ex}`);
      }
      }
      index += 1;
      continue;
    }

    expressionTokens.push(token);
    index += 1;
  }

  index = 0;

  function peek(): string | undefined {
    return expressionTokens[index];
  }

  function next(): string | undefined {
    const token = expressionTokens[index];
    if (token !== undefined) index += 1;
    return token;
  }

  function canStartPrimary({ token }: { token: string | undefined }): boolean {
    return token !== undefined && [
      '(',
      '!',
      '-not',
      '-name',
      '-iname',
      '-path',
      '-regex',
      '-type',
      '-empty',
      '-size',
      '-perm',
      '-newer',
      '-print',
      '-print0',
      '-prune',
      '-delete',
      '-quit',
      '-true',
      '-false',
      '-exec',
    ].includes(token);
  }

  function containsAction({ expr }: { expr: FindExpression }): boolean {
    switch (expr.kind) {
    case 'and':
    case 'or':
      return containsAction({ expr: expr.left }) || containsAction({ expr: expr.right });
    case 'not':
      return containsAction({ expr: expr.expr });
    case 'print':
    case 'print0':
    case 'prune':
    case 'delete':
    case 'quit':
    case 'exec':
      return true;
    case 'name':
    case 'path':
    case 'regex':
    case 'type':
    case 'empty':
    case 'size':
    case 'perm':
    case 'newer':
    case 'true':
    case 'false':
      return false;
    default: {
      const _ex: never = expr;
      throw new Error(`Unhandled find expression: ${_ex}`);
    }
    }
  }

  function parseOr(): FindExpression | string {
    let left = parseAnd();
    if (typeof left === 'string') return left;

    while (peek() === '-o' || peek() === '-or') {
      next();
      const right = parseAnd();
      if (typeof right === 'string') return right;
      left = { kind: 'or', left, right };
    }

    return left;
  }

  function parseAnd(): FindExpression | string {
    let left = parseUnary();
    if (typeof left === 'string') return left;

    while (true) {
      const token = peek();
      if (token === '-a' || token === '-and') {
        next();
      } else if (!canStartPrimary({ token })) {
        break;
      }

      const right = parseUnary();
      if (typeof right === 'string') return right;
      left = { kind: 'and', left, right };
    }

    return left;
  }

  function parseUnary(): FindExpression | string {
    const token = peek();
    if (token === '!' || token === '-not') {
      next();
      const expr = parseUnary();
      if (typeof expr === 'string') return expr;
      return { kind: 'not', expr };
    }
    return parsePrimary();
  }

  function parsePrimary(): FindExpression | string {
    const token = next();
    if (token === undefined) return 'missing expression';

    switch (token) {
    case '(':
    {
      const expr = parseOr();
      if (typeof expr === 'string') return expr;
      if (next() !== ')') return "expected ')'";
      return expr;
    }
    case '-name': {
      const pattern = next();
      if (pattern === undefined) return "missing argument to '-name'";
      return { kind: 'name', pattern, caseInsensitive: false, compiledPattern: globToRegExp({ pattern, caseInsensitive: false }) };
    }
    case '-iname': {
      const pattern = next();
      if (pattern === undefined) return "missing argument to '-iname'";
      return { kind: 'name', pattern, caseInsensitive: true, compiledPattern: globToRegExp({ pattern, caseInsensitive: true }) };
    }
    case '-path': {
      const pattern = next();
      if (pattern === undefined) return "missing argument to '-path'";
      return { kind: 'path', pattern, compiledPattern: globToRegExp({ pattern, caseInsensitive: false }) };
    }
    case '-regex': {
      const pattern = next();
      if (pattern === undefined) return "missing argument to '-regex'";
      const parsed = parseFindRegex({ value: pattern });
      if (!parsed.ok) return parsed.message;
      return { kind: 'regex', pattern: parsed.value };
    }
    case '-type': {
      const typeToken = next();
      if (typeToken === undefined) return "missing argument to '-type'";
      switch (typeToken) {
      case 'f':
        return { kind: 'type', expected: 'file' };
      case 'd':
        return { kind: 'type', expected: 'directory' };
      case 'p':
        return { kind: 'type', expected: 'fifo' };
      case 'c':
        return { kind: 'type', expected: 'chardev' };
      case 'l':
        return { kind: 'type', expected: 'symlink' };
      default:
        return `unknown argument to -type: ${typeToken}`;
      }
    }
    case '-empty':
      return { kind: 'empty' };
    case '-size': {
      const sizeToken = next();
      if (sizeToken === undefined) return "missing argument to '-size'";
      const parsed = parseFindSize({ value: sizeToken });
      if (!parsed.ok) return parsed.message;
      return { kind: 'size', comparison: parsed.comparison, sizeInBytes: parsed.sizeInBytes };
    }
    case '-perm': {
      const permToken = next();
      if (permToken === undefined) return "missing argument to '-perm'";
      const parsed = parseFindPerm({ value: permToken });
      if (!parsed.ok) return parsed.message;
      return { kind: 'perm', matchMode: parsed.matchMode, mode: parsed.mode };
    }
    case '-newer': {
      const referencePath = next();
      if (referencePath === undefined) return "missing argument to '-newer'";
      return {
        kind: 'newer',
        referencePath,
        referenceMtime: Number.NaN,
      };
    }
    case '-print':
      return { kind: 'print' };
    case '-print0':
      return { kind: 'print0' };
    case '-prune':
      return { kind: 'prune' };
    case '-delete':
      return { kind: 'delete' };
    case '-quit':
      return { kind: 'quit' };
    case '-true':
      return { kind: 'true' };
    case '-false':
      return { kind: 'false' };
    case '-exec': {
      const argv: string[] = [];
      let mode: 'single' | 'batch' | undefined;

      while (true) {
        const arg = next();
        if (arg === undefined) return "missing terminating ';' for -exec";
        if (arg === ';' || arg === '+') {
          switch (arg) {
          case ';':
            mode = 'single';
            break;
          case '+':
            mode = 'batch';
            break;
          default: {
            const _ex: never = arg;
            throw new Error(`Unhandled -exec terminator: ${_ex}`);
          }
          }
          break;
        }
        argv.push(arg);
      }

      if (argv.length === 0) return 'missing command for -exec';
      const command = argv[0];
      if (command === undefined) return 'missing command for -exec';
      if (mode === undefined) return "missing terminating ';' for -exec";
      if (!argv.some((arg) => arg.includes('{}'))) {
        return "missing '{}' in -exec arguments";
      }

      return {
        kind: 'exec',
        id: nextExecId++,
        mode,
        command,
        args: argv.slice(1),
      };
    }
    default:
      return `unknown expression token: ${token}`;
    }
  }

  if (expressionTokens.length === 0) {
    return { ok: true, traversal, expr: { kind: 'true' }, hasAction: false };
  }

  const expr = parseOr();
  if (typeof expr === 'string') {
    return { ok: false, message: expr };
  }

  if (index < expressionTokens.length) {
    const token = expressionTokens[index];
    return { ok: false, message: `unexpected token: ${token}` };
  }

  return {
    ok: true,
    traversal,
    expr,
    hasAction: containsAction({ expr }),
  };
}

async function resolveFindExpressionReferences({
  expr,
  context,
}: {
  expr: FindExpression,
  context: WeshCommandContext,
}): Promise<FindExpression> {
  switch (expr.kind) {
  case 'and':
    return {
      kind: 'and',
      left: await resolveFindExpressionReferences({ expr: expr.left, context }),
      right: await resolveFindExpressionReferences({ expr: expr.right, context }),
    };
  case 'or':
    return {
      kind: 'or',
      left: await resolveFindExpressionReferences({ expr: expr.left, context }),
      right: await resolveFindExpressionReferences({ expr: expr.right, context }),
    };
  case 'not':
    return {
      kind: 'not',
      expr: await resolveFindExpressionReferences({ expr: expr.expr, context }),
    };
  case 'newer': {
    const stat = await context.files.stat({
      path: resolvePath({
        cwd: context.cwd,
        path: expr.referencePath,
      }),
    });
    return {
      kind: 'newer',
      referencePath: expr.referencePath,
      referenceMtime: stat.mtime,
    };
  }
  case 'name':
  case 'path':
  case 'regex':
  case 'type':
  case 'empty':
  case 'size':
  case 'perm':
  case 'print':
  case 'print0':
  case 'prune':
  case 'delete':
  case 'quit':
  case 'true':
  case 'false':
  case 'exec':
    return expr;
  default: {
    const _ex: never = expr;
    throw new Error(`Unhandled find expression: ${_ex}`);
  }
  }
}

async function evaluateExpression({
  expr,
  entry,
  context,
  pendingExecBatches,
  stdout,
}: {
  expr: FindExpression,
  entry: FindEntry,
  context: WeshCommandContext,
  pendingExecBatches: Map<number, PendingExecBatch>,
  stdout: FindOutputWriter,
}): Promise<FindEvaluationResult> {
  switch (expr.kind) {
  case 'and': {
    const left = await evaluateExpression({ expr: expr.left, entry, context, pendingExecBatches, stdout });
    if (!left.matched) return left;
    const right = await evaluateExpression({ expr: expr.right, entry, context, pendingExecBatches, stdout });
    return {
      matched: left.matched && right.matched,
      actionInvoked: left.actionInvoked || right.actionInvoked,
      shouldPrune: left.shouldPrune || right.shouldPrune,
      shouldQuit: left.shouldQuit || right.shouldQuit,
      exitCode: left.exitCode !== 0 ? left.exitCode : right.exitCode,
    };
  }
  case 'or': {
    const left = await evaluateExpression({ expr: expr.left, entry, context, pendingExecBatches, stdout });
    if (left.matched) return left;
    const right = await evaluateExpression({ expr: expr.right, entry, context, pendingExecBatches, stdout });
    return {
      matched: right.matched,
      actionInvoked: left.actionInvoked || right.actionInvoked,
      shouldPrune: left.shouldPrune || right.shouldPrune,
      shouldQuit: left.shouldQuit || right.shouldQuit,
      exitCode: left.exitCode !== 0 ? left.exitCode : right.exitCode,
    };
  }
  case 'not': {
    const inner = await evaluateExpression({ expr: expr.expr, entry, context, pendingExecBatches, stdout });
    return {
      matched: !inner.matched,
      actionInvoked: inner.actionInvoked,
      shouldPrune: inner.shouldPrune,
      shouldQuit: inner.shouldQuit,
      exitCode: inner.exitCode,
    };
  }
  case 'name':
    return expr.compiledPattern.test(entry.name) ? EVAL_MATCHED : EVAL_NOT_MATCHED;
  case 'path':
    return expr.compiledPattern.test(entry.displayPath) ? EVAL_MATCHED : EVAL_NOT_MATCHED;
  case 'regex':
    return expr.pattern.test(entry.displayPath) ? EVAL_MATCHED : EVAL_NOT_MATCHED;
  case 'type':
    return entry.type === expr.expected ? EVAL_MATCHED : EVAL_NOT_MATCHED;
  case 'empty':
    switch (entry.type) {
    case 'directory': {
      for await (const _ of context.files.readDirEntry({ entry: asDirectoryEntryRef({ entry: entry.entryRef }) })) {
        return EVAL_NOT_MATCHED;
      }
      return EVAL_MATCHED;
    }
    case 'file':
    case 'fifo':
    case 'chardev':
    case 'symlink':
      return entry.size === 0 ? EVAL_MATCHED : EVAL_NOT_MATCHED;
    default: {
      const _ex: never = entry.type;
      throw new Error(`Unhandled file type: ${_ex}`);
    }
    }
  case 'size': {
    let matched: boolean;
    switch (expr.comparison) {
    case 'eq': matched = entry.size === expr.sizeInBytes; break;
    case 'lt': matched = entry.size < expr.sizeInBytes; break;
    case 'gt': matched = entry.size > expr.sizeInBytes; break;
    default: {
      const _ex: never = expr.comparison;
      throw new Error(`Unhandled size comparison: ${_ex}`);
    }
    }
    return matched ? EVAL_MATCHED : EVAL_NOT_MATCHED;
  }
  case 'perm': {
    let permissionBits: number;
    switch (entry.type) {
    case 'directory': permissionBits = 0o755; break;
    case 'symlink': permissionBits = 0o777; break;
    case 'chardev': permissionBits = 0o666; break;
    case 'fifo':
    case 'file': permissionBits = 0o644; break;
    default: {
      const _ex: never = entry.type;
      throw new Error(`Unhandled file type: ${_ex}`);
    }
    }
    let matched: boolean;
    switch (expr.matchMode) {
    case 'exact': matched = permissionBits === expr.mode; break;
    case 'all': matched = (permissionBits & expr.mode) === expr.mode; break;
    case 'any': matched = (permissionBits & expr.mode) !== 0; break;
    default: {
      const _ex: never = expr.matchMode;
      throw new Error(`Unhandled permission match mode: ${_ex}`);
    }
    }
    return matched ? EVAL_MATCHED : EVAL_NOT_MATCHED;
  }
  case 'newer':
    return entry.mtime > expr.referenceMtime ? EVAL_MATCHED : EVAL_NOT_MATCHED;
  case 'print':
    await stdout.write({ text: `${entry.displayPath}\n` });
    return { matched: true, actionInvoked: true, shouldPrune: false, shouldQuit: false, exitCode: 0 };
  case 'print0':
    await stdout.write({ text: `${entry.displayPath}\0` });
    return { matched: true, actionInvoked: true, shouldPrune: false, shouldQuit: false, exitCode: 0 };
  case 'prune':
    return { matched: true, actionInvoked: true, shouldPrune: true, shouldQuit: false, exitCode: 0 };
  case 'delete':
    switch (entry.type) {
    case 'directory':
      await context.files.rmdir({ path: entry.fullPath });
      break;
    case 'file':
    case 'fifo':
    case 'chardev':
    case 'symlink':
      await context.files.unlink({ path: entry.fullPath });
      break;
    default: {
      const _ex: never = entry.type;
      throw new Error(`Unhandled file type: ${_ex}`);
    }
    }
    return { matched: true, actionInvoked: true, shouldPrune: false, shouldQuit: false, exitCode: 0 };
  case 'quit':
    return { matched: true, actionInvoked: true, shouldPrune: false, shouldQuit: true, exitCode: 0 };
  case 'true':
    return EVAL_MATCHED;
  case 'false':
    return EVAL_NOT_MATCHED;
  case 'exec': {
    const execMode: 'single' | 'batch' = expr.mode;
    switch (execMode) {
    case 'batch': {
      let pending = pendingExecBatches.get(expr.id);
      if (pending === undefined) {
        pending = {
          id: expr.id,
          command: expr.command,
          argsTemplate: expr.args,
          entries: [],
          argumentBytes: getStaticBatchExecArgumentBytes({
            command: expr.command,
            argsTemplate: expr.args,
          }),
        };
        pendingExecBatches.set(expr.id, pending);
      }

      const pathArgumentBytes = getPathBatchExecArgumentBytes({
        argsTemplate: pending.argsTemplate,
        path: entry.displayPath,
      });
      let batchExitCode = 0;
      if (
        pending.entries.length > 0
        && (
          pending.entries.length + 1 > MAX_EXEC_BATCH_PATH_COUNT
          || pending.argumentBytes + pathArgumentBytes > MAX_EXEC_BATCH_ARGUMENT_BYTES
        )
      ) {
        batchExitCode = await flushPendingExecBatch({
          pending,
          context,
        });
      }

      pending.entries.push({
        path: entry.displayPath,
        entryRef: entry.entryRef,
      });
      pending.argumentBytes += pathArgumentBytes;
      if (
        pending.entries.length >= MAX_EXEC_BATCH_PATH_COUNT
        || pending.argumentBytes >= MAX_EXEC_BATCH_ARGUMENT_BYTES
      ) {
        const nextExitCode = await flushPendingExecBatch({
          pending,
          context,
        });
        if (nextExitCode !== 0) {
          batchExitCode = nextExitCode;
        }
      }

      return {
        matched: true,
        actionInvoked: true,
        shouldPrune: false,
        shouldQuit: false,
        exitCode: batchExitCode,
      };
    }
    case 'single': {
      const invocation = buildSingleExecInvocation({
        argsTemplate: expr.args,
        entry: {
          path: entry.displayPath,
          entryRef: entry.entryRef,
        },
      });
      const result = await context.executeCommand({
        command: expr.command,
        args: invocation.args,
        argumentEntryRefs: invocation.argumentEntryRefs,
      });
      return {
        matched: result.exitCode === 0,
        actionInvoked: true,
        shouldPrune: false,
        shouldQuit: false,
        exitCode: result.exitCode,
      };
    }
    default: {
      const _ex: never = execMode;
      throw new Error(`Unhandled exec mode: ${_ex}`);
    }
    }
  }
  default: {
    const _ex: never = expr;
    throw new Error(`Unhandled find expression: ${_ex}`);
  }
  }
}

function getStaticBatchExecArgumentBytes({
  command,
  argsTemplate,
}: {
  command: string,
  argsTemplate: readonly string[],
}): number {
  let bytes = utf8Encoder.encode(command).byteLength + 1;
  for (const arg of argsTemplate) {
    if (!arg.includes('{}')) {
      bytes += utf8Encoder.encode(arg).byteLength + 1;
    }
  }
  return bytes;
}

function getPathBatchExecArgumentBytes({
  argsTemplate,
  path,
}: {
  argsTemplate: readonly string[],
  path: string,
}): number {
  let bytes = 0;
  for (const arg of argsTemplate) {
    if (arg.includes('{}')) {
      bytes += utf8Encoder.encode(arg.replace(/\{\}/g, path)).byteLength + 1;
    }
  }
  return bytes;
}

function buildExecArgument({
  template,
  entry,
}: {
  template: string,
  entry: PendingExecBatchEntry,
}): {
  value: string,
  entryRef: WeshEntryRef | undefined,
} {
  return {
    value: template.replace(/\{\}/g, entry.path),
    entryRef: template === '{}' ? entry.entryRef : undefined,
  };
}

function buildSingleExecInvocation({
  argsTemplate,
  entry,
}: {
  argsTemplate: string[],
  entry: PendingExecBatchEntry,
}): ExecInvocation {
  const args: string[] = [];
  const argumentEntryRefs: Array<WeshEntryRef | undefined> = [];

  for (const template of argsTemplate) {
    const argument = buildExecArgument({ template, entry });
    args.push(argument.value);
    argumentEntryRefs.push(argument.entryRef);
  }

  return { args, argumentEntryRefs };
}

function buildBatchExecInvocation({
  argsTemplate,
  entries,
}: {
  argsTemplate: string[],
  entries: PendingExecBatchEntry[],
}): ExecInvocation {
  const args: string[] = [];
  const argumentEntryRefs: Array<WeshEntryRef | undefined> = [];

  for (const template of argsTemplate) {
    if (!template.includes('{}')) {
      args.push(template);
      argumentEntryRefs.push(undefined);
      continue;
    }

    for (const entry of entries) {
      const argument = buildExecArgument({ template, entry });
      args.push(argument.value);
      argumentEntryRefs.push(argument.entryRef);
    }
  }

  return { args, argumentEntryRefs };
}

function asDirectoryEntryRef({
  entry,
}: {
  entry: WeshEntryRef,
}): WeshEntryRef<'directory'> {
  switch (entry.type) {
  case 'directory':
    return entry as WeshEntryRef<'directory'>;
  case 'file':
  case 'fifo':
  case 'chardev':
  case 'symlink':
    throw new Error(`Not a directory: ${entry.fullPath}`);
  default: {
    const _ex: never = entry;
    throw new Error(`Unhandled entry type: ${String(_ex)}`);
  }
  }
}

async function flushPendingExecBatch({
  pending,
  context,
}: {
  pending: PendingExecBatch,
  context: WeshCommandContext,
}): Promise<number> {
  if (pending.entries.length === 0) return 0;

  const entries = pending.entries;
  pending.entries = [];
  pending.argumentBytes = getStaticBatchExecArgumentBytes({
    command: pending.command,
    argsTemplate: pending.argsTemplate,
  });
  const invocation = buildBatchExecInvocation({
    argsTemplate: pending.argsTemplate,
    entries,
  });
  const result = await context.executeCommand({
    command: pending.command,
    args: invocation.args,
    argumentEntryRefs: invocation.argumentEntryRefs,
  });
  return result.exitCode;
}

function hasDeleteAction({
  expr,
}: {
  expr: FindExpression,
}): boolean {
  switch (expr.kind) {
  case 'and':
  case 'or':
    return hasDeleteAction({ expr: expr.left }) || hasDeleteAction({ expr: expr.right });
  case 'not':
    return hasDeleteAction({ expr: expr.expr });
  case 'delete':
    return true;
  case 'name':
  case 'path':
  case 'regex':
  case 'type':
  case 'empty':
  case 'size':
  case 'perm':
  case 'newer':
  case 'print':
  case 'print0':
  case 'prune':
  case 'quit':
  case 'true':
  case 'false':
  case 'exec':
    return false;
  default: {
    const _ex: never = expr;
    throw new Error(`Unhandled find expression: ${_ex}`);
  }
  }
}

export const findCommandDefinition: WeshCommandDefinition = {
  meta: {
    name: 'find',
    description: 'Search for files in a directory hierarchy',
    usage: 'find [path...] [expression]',
  },
  fn: async ({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> => {
    const helpStatus = await maybeWriteStandaloneCommandHelp({
      context,
      command: 'find',
      argvSpec: findHelpArgvSpec,
      mode: isStandaloneCommandHelpRequest({
        args: context.args,
        acceptedForms: [['--help']],
      }) ? 'help-requested' : 'not-requested',
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

    const split = splitFindLeadingOptions({ args: context.args });
    const parsed = parseFindLikeArgv({ args: split.remainingArgs });
    const expression = tokenizeFindExpression({
      tokens: [...split.leadingOptions, ...parsed.expressionTokens],
    });

    if (!expression.ok) {
      await writeCommandUsageError({
        context,
        command: 'find',
        message: `find: ${expression.message}`,
      });
      return { exitCode: 1 };
    }

    let exitCode = 0;
    const pendingExecBatches = new Map<number, PendingExecBatch>();
    const stdout = createBufferedTextWriter({
      handle: context.stdout,
      maxBufferLength: 16 * 1024,
    });
    let shouldQuit = false;
    const traversal: FindTraversalOptions = {
      ...expression.traversal,
      depthFirst: expression.traversal.depthFirst || hasDeleteAction({ expr: expression.expr }),
    };
    let resolvedExpression: FindExpression;

    try {
      resolvedExpression = await resolveFindExpressionReferences({
        expr: expression.expr,
        context,
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      await writeCommandUsageError({
        context,
        command: 'find',
        message: `find: ${message}`,
      });
      return { exitCode: 1 };
    }

    const canSkipFullStat = canEvaluateWithoutFullStat({
      expr: resolvedExpression,
    });

    const resolveTraversalEntry = async ({
      path,
      isCommandLineArgument,
    }: {
      path: string,
      isCommandLineArgument: boolean,
    }): Promise<WeshEntryRef> => {
      const finalSymlinkTreatment = (() => {
        switch (traversal.symlinkMode) {
        case 'logical':
          return 'follow' as const;
        case 'command-line':
          return isCommandLineArgument ? 'follow' as const : 'no-follow' as const;
        case 'physical':
          return 'no-follow' as const;
        default: {
          const _ex: never = traversal.symlinkMode;
          throw new Error(`Unhandled symlink mode: ${_ex}`);
        }
        }
      })();

      return context.files.resolveEntry({
        path,
        finalSymlinkTreatment,
      });
    };

    const createFindEntry = async ({
      entryRef,
      operationPath,
      displayPath,
      name,
    }: {
      entryRef: WeshEntryRef,
      operationPath: string,
      displayPath: string,
      name: string,
    }): Promise<FindEntry> => {
      if (canSkipFullStat) {
        return {
          entryRef,
          fullPath: operationPath,
          displayPath,
          type: entryRef.type,
          name,
          size: 0,
          mtime: 0,
        };
      }

      const stat = await context.files.statEntry({ entry: entryRef });
      return {
        entryRef,
        fullPath: operationPath,
        displayPath,
        type: stat.type,
        name,
        size: stat.size,
        mtime: stat.mtime,
      };
    };

    const walk = async ({
      entryRef,
      operationPath,
      displayPath,
      name,
      depth,
    }: {
      entryRef: WeshEntryRef,
      operationPath: string,
      displayPath: string,
      name: string,
      depth: number,
    }): Promise<void> => {
      if (shouldQuit) return;

      try {
        const finalizedEntry = await createFindEntry({
          entryRef,
          operationPath,
          displayPath,
          name,
        });
        let shouldPruneChildren = false;
        let evaluation: FindEvaluationResult | undefined;
        const shouldEvaluate = depth >= traversal.minDepth;

        if (!traversal.depthFirst && shouldEvaluate) {
          evaluation = await evaluateExpression({
            expr: resolvedExpression,
            entry: finalizedEntry,
            context,
            pendingExecBatches,
            stdout,
          });

          if (evaluation.exitCode !== 0) {
            exitCode = evaluation.exitCode;
          }
          if (evaluation.shouldQuit) {
            shouldQuit = true;
          }
          if (evaluation.matched && !expression.hasAction) {
            await stdout.write({ text: `${displayPath}\n` });
          }
          shouldPruneChildren = evaluation.shouldPrune;
        }

        const canDescend = finalizedEntry.type === 'directory'
          && !shouldPruneChildren
          && !shouldQuit
          && (traversal.maxDepth === undefined || depth < traversal.maxDepth);

        if (canDescend) {
          const displayPathPrefix = displayPath === '/' ? '' : displayPath;
          const directoryEntry = asDirectoryEntryRef({
            entry: finalizedEntry.entryRef,
          });
          for await (const child of context.files.readDirEntry({ entry: directoryEntry })) {
            const childDisplayPath = `${displayPathPrefix}/${child.name}`;
            const childOperationPath = child.fullPath;
            const childEntry = traversal.symlinkMode === 'logical' && child.type === 'symlink'
              ? await resolveTraversalEntry({
                path: child.fullPath,
                isCommandLineArgument: false,
              })
              : child;
            await walk({
              entryRef: childEntry,
              operationPath: childOperationPath,
              displayPath: childDisplayPath,
              name: child.name,
              depth: depth + 1,
            });
            if (shouldQuit) break;
          }
        }

        if (traversal.depthFirst && !shouldQuit && shouldEvaluate) {
          evaluation = await evaluateExpression({
            expr: resolvedExpression,
            entry: finalizedEntry,
            context,
            pendingExecBatches,
            stdout,
          });

          if (evaluation.exitCode !== 0) {
            exitCode = evaluation.exitCode;
          }
          if (evaluation.shouldQuit) {
            shouldQuit = true;
          }
          if (evaluation.matched && !expression.hasAction) {
            await stdout.write({ text: `${displayPath}\n` });
          }
        }
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        await context.text().error({ text: `find: ${displayPath}: ${message}\n` });
        exitCode = 1;
      }
    };

    for (const path of parsed.paths) {
      const fullPath = resolvePath({ cwd: context.cwd, path });
      try {
        await walk({
          entryRef: await resolveTraversalEntry({
            path: fullPath,
            isCommandLineArgument: true,
          }),
          operationPath: fullPath,
          displayPath: path,
          name: basename({ path }),
          depth: 0,
        });
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        await context.text().error({ text: `find: ${path}: ${message}\n` });
        exitCode = 1;
      }
      if (shouldQuit) break;
    }

    for (const pendingExecBatch of pendingExecBatches.values()) {
      const batchExitCode = await flushPendingExecBatch({
        pending: pendingExecBatch,
        context,
      });
      if (batchExitCode !== 0) {
        exitCode = batchExitCode;
      }
    }

    await stdout.flush();
    return { exitCode };
  },
};

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {};
