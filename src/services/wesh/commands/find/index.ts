import { parseFindLikeArgv } from '@/services/wesh/argv';
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
  WeshFileType,
} from '@/services/wesh/types';

type FindExpression =
  | { kind: 'and'; left: FindExpression; right: FindExpression }
  | { kind: 'or'; left: FindExpression; right: FindExpression }
  | { kind: 'not'; expr: FindExpression }
  | { kind: 'name'; pattern: string; caseInsensitive: boolean; compiledPattern: RegExp }
  | { kind: 'path'; pattern: string; compiledPattern: RegExp }
  | { kind: 'regex'; pattern: RegExp }
  | { kind: 'type'; expected: WeshFileType }
  | { kind: 'empty' }
  | { kind: 'size'; comparison: 'eq' | 'lt' | 'gt'; sizeInBytes: number }
  | { kind: 'perm'; matchMode: 'exact' | 'all' | 'any'; mode: number }
  | { kind: 'newer'; referencePath: string; referenceMtime: number }
  | { kind: 'print' }
  | { kind: 'print0' }
  | { kind: 'prune' }
  | { kind: 'delete' }
  | { kind: 'quit' }
  | { kind: 'true' }
  | { kind: 'false' }
  | { kind: 'exec'; id: number; mode: 'single' | 'batch'; command: string; args: string[] };

interface FindEntry {
  fullPath: string;
  displayPath: string;
  type: WeshFileType;
  name: string;
  size: number;
  mtime: number;
  readPath: string;
}

interface FindEvaluationResult {
  matched: boolean;
  actionInvoked: boolean;
  shouldPrune: boolean;
  shouldQuit: boolean;
  exitCode: number;
}

const EVAL_MATCHED: FindEvaluationResult = { matched: true, actionInvoked: false, shouldPrune: false, shouldQuit: false, exitCode: 0 };
const EVAL_NOT_MATCHED: FindEvaluationResult = { matched: false, actionInvoked: false, shouldPrune: false, shouldQuit: false, exitCode: 0 };

interface PendingExecBatch {
  id: number;
  command: string;
  argsTemplate: string[];
  paths: string[];
}

interface FindTraversalOptions {
  maxDepth: number | undefined;
  minDepth: number;
  depthFirst: boolean;
  symlinkMode: 'physical' | 'command-line' | 'logical';
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

function resolvePath({ cwd, path }: { cwd: string; path: string }): string {
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
  pattern: string;
  caseInsensitive: boolean;
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
  value: string;
  optionName: string;
}): { ok: true; value: number } | { ok: false; message: string } {
  if (!/^\d+$/.test(value)) {
    return { ok: false, message: `invalid argument to ${optionName}: ${value}` };
  }

  return { ok: true, value: parseInt(value, 10) };
}

function parseFindRegex({
  value,
}: {
  value: string;
}): { ok: true; value: RegExp } | { ok: false; message: string } {
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
  value: string;
}): { ok: true; comparison: 'eq' | 'lt' | 'gt'; sizeInBytes: number } | { ok: false; message: string } {
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
  value: string;
}): { ok: true; matchMode: 'exact' | 'all' | 'any'; mode: number } | { ok: false; message: string } {
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
  args: string[];
}): {
  leadingOptions: string[];
  remainingArgs: string[];
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
  tokens: string[];
}): {
  ok: true;
  traversal: FindTraversalOptions;
  expr: FindExpression;
  hasAction: boolean;
} | {
  ok: false;
  message: string;
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
  expr: FindExpression;
  context: WeshCommandContext;
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
}: {
  expr: FindExpression;
  entry: FindEntry;
  context: WeshCommandContext;
  pendingExecBatches: Map<number, PendingExecBatch>;
}): Promise<FindEvaluationResult> {
  switch (expr.kind) {
  case 'and': {
    const left = await evaluateExpression({ expr: expr.left, entry, context, pendingExecBatches });
    if (!left.matched) return left;
    const right = await evaluateExpression({ expr: expr.right, entry, context, pendingExecBatches });
    return {
      matched: left.matched && right.matched,
      actionInvoked: left.actionInvoked || right.actionInvoked,
      shouldPrune: left.shouldPrune || right.shouldPrune,
      shouldQuit: left.shouldQuit || right.shouldQuit,
      exitCode: left.exitCode !== 0 ? left.exitCode : right.exitCode,
    };
  }
  case 'or': {
    const left = await evaluateExpression({ expr: expr.left, entry, context, pendingExecBatches });
    if (left.matched) return left;
    const right = await evaluateExpression({ expr: expr.right, entry, context, pendingExecBatches });
    return {
      matched: right.matched,
      actionInvoked: left.actionInvoked || right.actionInvoked,
      shouldPrune: left.shouldPrune || right.shouldPrune,
      shouldQuit: left.shouldQuit || right.shouldQuit,
      exitCode: left.exitCode !== 0 ? left.exitCode : right.exitCode,
    };
  }
  case 'not': {
    const inner = await evaluateExpression({ expr: expr.expr, entry, context, pendingExecBatches });
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
      for await (const _ of context.files.readDir({ path: entry.fullPath })) {
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
    await context.text().print({ text: `${entry.displayPath}\n` });
    return { matched: true, actionInvoked: true, shouldPrune: false, shouldQuit: false, exitCode: 0 };
  case 'print0':
    await context.text().print({ text: `${entry.displayPath}\0` });
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
      const existing = pendingExecBatches.get(expr.id);
      if (existing === undefined) {
        pendingExecBatches.set(expr.id, {
          id: expr.id,
          command: expr.command,
          argsTemplate: expr.args,
          paths: [entry.displayPath],
        });
      } else {
        existing.paths.push(entry.displayPath);
      }

      return {
        matched: true,
        actionInvoked: true,
        shouldPrune: false,
        shouldQuit: false,
        exitCode: 0,
      };
    }
    case 'single': {
      const result = await context.executeCommand({
        command: expr.command,
        args: expr.args.map((arg) => arg.replace(/\{\}/g, entry.displayPath)),
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

function buildBatchExecArgs({
  argsTemplate,
  paths,
}: {
  argsTemplate: string[];
  paths: string[];
}): string[] {
  const args: string[] = [];

  for (const arg of argsTemplate) {
    if (!arg.includes('{}')) {
      args.push(arg);
      continue;
    }

    for (const path of paths) {
      args.push(arg.replace(/\{\}/g, path));
    }
  }

  return args;
}

function hasDeleteAction({
  expr,
}: {
  expr: FindExpression;
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
    let shouldQuit = false;
    const traversal: FindTraversalOptions = {
      ...expression.traversal,
      depthFirst: expression.traversal.depthFirst || hasDeleteAction({ expr: expression.expr }),
    };
    let resolvedExpression: FindExpression;

    const getPathStat = async ({
      path,
      isCommandLineArgument,
    }: {
      path: string;
      isCommandLineArgument: boolean;
    }) => {
      switch (traversal.symlinkMode) {
      case 'logical':
        return context.files.stat({ path });
      case 'command-line':
        return isCommandLineArgument ? context.files.stat({ path }) : context.files.lstat({ path });
      case 'physical':
        return context.files.lstat({ path });
      default: {
        const _ex: never = traversal.symlinkMode;
        throw new Error(`Unhandled symlink mode: ${_ex}`);
      }
      }
    };

    try {
      resolvedExpression = await resolveFindExpressionReferences({
        expr: expression.expr,
        context,
      });
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      await writeCommandUsageError({
        context,
        command: 'find',
        message: `find: ${message}`,
      });
      return { exitCode: 1 };
    }

    const getReadPath = async ({
      path,
      type,
    }: {
      path: string;
      type: WeshFileType;
    }) => {
      switch (type) {
      case 'directory':
        return (await context.files.resolve({ path })).fullPath;
      case 'file':
      case 'fifo':
      case 'chardev':
      case 'symlink':
        return path;
      default: {
        const _ex: never = type;
        throw new Error(`Unhandled file type: ${_ex}`);
      }
      }
    };

    const walk = async ({
      fullPath,
      displayPath,
      name,
      depth,
      isCommandLineArgument,
    }: {
      fullPath: string;
      displayPath: string;
      name: string;
      depth: number;
      isCommandLineArgument: boolean;
    }) => {
      if (shouldQuit) return;

      try {
        const stat = await getPathStat({ path: fullPath, isCommandLineArgument });
        const entry: FindEntry = {
          fullPath,
          displayPath,
          type: stat.type,
          name,
          size: stat.size,
          mtime: stat.mtime,
          readPath: await getReadPath({ path: fullPath, type: stat.type }),
        };

        let shouldPruneChildren = false;
        let evaluation: FindEvaluationResult | undefined;
        const shouldEvaluate = depth >= traversal.minDepth;

        if (!traversal.depthFirst && shouldEvaluate) {
          evaluation = await evaluateExpression({
            expr: resolvedExpression,
            entry,
            context,
            pendingExecBatches,
          });

          if (evaluation.exitCode !== 0) {
            exitCode = evaluation.exitCode;
          }
          if (evaluation.shouldQuit) {
            shouldQuit = true;
          }
          if (evaluation.matched && !expression.hasAction) {
            await context.text().print({ text: `${displayPath}\n` });
          }
          shouldPruneChildren = evaluation.shouldPrune;
        }

        const canDescend = entry.type === 'directory'
          && !shouldPruneChildren
          && !shouldQuit
          && (traversal.maxDepth === undefined || depth < traversal.maxDepth);

        if (canDescend) {
          const readPathPrefix = entry.readPath === '/' ? '' : entry.readPath;
          const displayPathPrefix = displayPath === '/' ? '' : displayPath;
          for await (const child of context.files.readDir({ path: entry.readPath })) {
            const childFullPath = `${readPathPrefix}/${child.name}`;
            const childDisplayPath = `${displayPathPrefix}/${child.name}`;
            await walk({
              fullPath: childFullPath,
              displayPath: childDisplayPath,
              name: child.name,
              depth: depth + 1,
              isCommandLineArgument: false,
            });
            if (shouldQuit) break;
          }
        }

        if (traversal.depthFirst && !shouldQuit && shouldEvaluate) {
          evaluation = await evaluateExpression({
            expr: resolvedExpression,
            entry,
            context,
            pendingExecBatches,
          });

          if (evaluation.exitCode !== 0) {
            exitCode = evaluation.exitCode;
          }
          if (evaluation.shouldQuit) {
            shouldQuit = true;
          }
          if (evaluation.matched && !expression.hasAction) {
            await context.text().print({ text: `${displayPath}\n` });
          }
        }
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : String(e);
        await context.text().error({ text: `find: ${displayPath}: ${message}\n` });
        exitCode = 1;
      }
    };

    for (const path of parsed.paths) {
      const fullPath = resolvePath({ cwd: context.cwd, path });
      await walk({
        fullPath,
        displayPath: path,
        name: basename({ path }),
        depth: 0,
        isCommandLineArgument: true,
      });
      if (shouldQuit) break;
    }

    for (const pendingExecBatch of pendingExecBatches.values()) {
      if (pendingExecBatch.paths.length === 0) continue;

      const result = await context.executeCommand({
        command: pendingExecBatch.command,
        args: buildBatchExecArgs({
          argsTemplate: pendingExecBatch.argsTemplate,
          paths: pendingExecBatch.paths,
        }),
      });

      if (result.exitCode !== 0) {
        exitCode = result.exitCode;
      }
    }

    return { exitCode };
  },
};
