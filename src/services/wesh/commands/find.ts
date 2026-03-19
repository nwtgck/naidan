import { parseFindLikeArgv } from '@/services/wesh/argv';
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
  | { kind: 'type'; expected: WeshFileType }
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

      if (token === '-maxdepth') {
        traversal.maxDepth = parsed.value;
      } else {
        traversal.minDepth = parsed.value;
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
      '-type',
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
    case 'type':
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
          mode = arg === ';' ? 'single' : 'batch';
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
  case 'type':
    return {
      matched: entry.type === expr.expected,
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
    if (entry.type === 'directory') {
      await context.kernel.rmdir({ path: entry.fullPath });
    } else {
      await context.kernel.unlink({ path: entry.fullPath });
    }
    return { matched: true, actionInvoked: true, shouldPrune: false, shouldQuit: false, exitCode: 0 };
  case 'quit':
    return { matched: true, actionInvoked: true, shouldPrune: false, shouldQuit: true, exitCode: 0 };
  case 'true':
    return { matched: true, actionInvoked: false, shouldPrune: false, shouldQuit: false, exitCode: 0 };
  case 'false':
    return { matched: false, actionInvoked: false, shouldPrune: false, shouldQuit: false, exitCode: 0 };
  case 'exec': {
    if (expr.mode === 'batch') {
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
  case 'type':
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
      await context.text().error({ text: `find: ${expression.message}\n` });
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
