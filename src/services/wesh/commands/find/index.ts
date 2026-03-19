import { parseFindLikeArgv } from '@/services/wesh/argv';
import { writeCommandUsageError } from '@/services/wesh/commands/_shared/usage';
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
  | { kind: 'name'; pattern: string; caseInsensitive: boolean }
  | { kind: 'path'; pattern: string }
  | { kind: 'regex'; pattern: RegExp }
  | { kind: 'type'; expected: WeshFileType }
  | { kind: 'empty' }
  | { kind: 'size'; comparison: 'eq' | 'lt' | 'gt'; sizeInBytes: number }
  | { kind: 'print' }
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
}

interface FindEvaluationResult {
  matched: boolean;
  actionInvoked: boolean;
  shouldPrune: boolean;
  shouldQuit: boolean;
  exitCode: number;
}

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
}

function resolvePath({ cwd, path }: { cwd: string; path: string }): string {
  return path.startsWith('/') ? path : `${cwd}/${path}`;
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
      '-print',
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
      return { kind: 'name', pattern, caseInsensitive: false };
    }
    case '-iname': {
      const pattern = next();
      if (pattern === undefined) return "missing argument to '-iname'";
      return { kind: 'name', pattern, caseInsensitive: true };
    }
    case '-path': {
      const pattern = next();
      if (pattern === undefined) return "missing argument to '-path'";
      return { kind: 'path', pattern };
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
    case '-print':
      return { kind: 'print' };
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
    return {
      matched: globToRegExp({ pattern: expr.pattern, caseInsensitive: expr.caseInsensitive }).test(entry.name),
      actionInvoked: false,
      shouldPrune: false,
      shouldQuit: false,
      exitCode: 0,
    };
  case 'path':
    return {
      matched: globToRegExp({ pattern: expr.pattern, caseInsensitive: false }).test(entry.displayPath),
      actionInvoked: false,
      shouldPrune: false,
      shouldQuit: false,
      exitCode: 0,
    };
  case 'regex':
    return {
      matched: expr.pattern.test(entry.displayPath),
      actionInvoked: false,
      shouldPrune: false,
      shouldQuit: false,
      exitCode: 0,
    };
  case 'type':
    return {
      matched: entry.type === expr.expected,
      actionInvoked: false,
      shouldPrune: false,
      shouldQuit: false,
      exitCode: 0,
    };
  case 'empty':
    switch (entry.type) {
    case 'directory': {
      const entries = await context.kernel.readDir({ path: entry.fullPath });
      return {
        matched: entries.length === 0,
        actionInvoked: false,
        shouldPrune: false,
        shouldQuit: false,
        exitCode: 0,
      };
    }
    case 'file':
    case 'fifo':
    case 'chardev':
    case 'symlink':
      return {
        matched: entry.size === 0,
        actionInvoked: false,
        shouldPrune: false,
        shouldQuit: false,
        exitCode: 0,
      };
    default: {
      const _ex: never = entry.type;
      throw new Error(`Unhandled file type: ${_ex}`);
    }
    }
  case 'size':
    return {
      matched: (() => {
        switch (expr.comparison) {
        case 'eq':
          return entry.size === expr.sizeInBytes;
        case 'lt':
          return entry.size < expr.sizeInBytes;
        case 'gt':
          return entry.size > expr.sizeInBytes;
        default: {
          const _ex: never = expr.comparison;
          throw new Error(`Unhandled size comparison: ${_ex}`);
        }
        }
      })(),
      actionInvoked: false,
      shouldPrune: false,
      shouldQuit: false,
      exitCode: 0,
    };
  case 'print':
    await context.text().print({ text: `${entry.displayPath}\n` });
    return { matched: true, actionInvoked: true, shouldPrune: false, shouldQuit: false, exitCode: 0 };
  case 'prune':
    return { matched: true, actionInvoked: true, shouldPrune: true, shouldQuit: false, exitCode: 0 };
  case 'delete':
    switch (entry.type) {
    case 'directory':
      await context.kernel.rmdir({ path: entry.fullPath });
      break;
    case 'file':
    case 'fifo':
    case 'chardev':
    case 'symlink':
      await context.kernel.unlink({ path: entry.fullPath });
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
    return { matched: true, actionInvoked: false, shouldPrune: false, shouldQuit: false, exitCode: 0 };
  case 'false':
    return { matched: false, actionInvoked: false, shouldPrune: false, shouldQuit: false, exitCode: 0 };
  case 'exec': {
    switch (expr.mode) {
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
      const _ex: never = expr.mode;
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
  case 'print':
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
    const parsed = parseFindLikeArgv({ args: context.args });
    const expression = tokenizeFindExpression({ tokens: parsed.expressionTokens });

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

    const walk = async ({
      fullPath,
      displayPath,
      depth,
    }: {
      fullPath: string;
      displayPath: string;
      depth: number;
    }) => {
      if (shouldQuit) return;

      try {
        const stat = await context.kernel.stat({ path: fullPath });
        const entry: FindEntry = {
          fullPath,
          displayPath,
          type: stat.type,
          name: basename({ path: displayPath }),
          size: stat.size,
        };

        let shouldPruneChildren = false;
        let evaluation: FindEvaluationResult | undefined;
        const shouldEvaluate = depth >= traversal.minDepth;

        if (!traversal.depthFirst && shouldEvaluate) {
          evaluation = await evaluateExpression({
            expr: expression.expr,
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
          const entries = await context.kernel.readDir({ path: fullPath });
          for (const child of entries) {
            const childFullPath = fullPath === '/' ? `/${child.name}` : `${fullPath}/${child.name}`;
            const childDisplayPath = displayPath === '/' ? `/${child.name}` : `${displayPath}/${child.name}`;
            await walk({ fullPath: childFullPath, displayPath: childDisplayPath, depth: depth + 1 });
            if (shouldQuit) break;
          }
        }

        if (traversal.depthFirst && !shouldQuit && shouldEvaluate) {
          evaluation = await evaluateExpression({
            expr: expression.expr,
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
      await walk({ fullPath, displayPath: path, depth: 0 });
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
