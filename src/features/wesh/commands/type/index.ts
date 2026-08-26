import { parseStandardArgv, type StandardArgvParserSpec } from '@/features/wesh/argv';
import { hasShellFunction, resolveCommand, resolvePathCommands, shellControlFlowBuiltinNames } from '@/features/wesh/command-resolution';
import { writeCommandHelp, writeCommandUsageError } from '@/features/wesh/commands/_shared/usage';
import { stopStandardOptionParsingAtFirstPositional } from '@/features/wesh/commands/_shared/argv';
import type {
  WeshCommandContext,
  WeshCommandDefinition,
  WeshCommandResult,
} from '@/features/wesh/types';

const typeArgvSpec: StandardArgvParserSpec = {
  options: [
    { kind: 'flag', short: 'a', long: undefined, effects: [{ key: 'all', value: true }], help: { summary: 'print all matching command locations' } },
    { kind: 'flag', short: 'f', long: undefined, effects: [{ key: 'suppressFunctions', value: true }], help: { summary: 'suppress shell-function lookup' } },
    { kind: 'flag', short: 'p', long: undefined, effects: [{ key: 'pathOnly', value: true }], help: { summary: 'print the executable path when available' } },
    { kind: 'flag', short: 'P', long: undefined, effects: [{ key: 'forcePath', value: true }], help: { summary: 'force a PATH search for each name' } },
    { kind: 'flag', short: 't', long: undefined, effects: [{ key: 'typeOnly', value: true }], help: { summary: 'print one word describing each command type' } },
    { kind: 'flag', short: undefined, long: 'help', effects: [{ key: 'help', value: true }], help: { summary: 'display this help and exit', category: 'common' } },
  ],
  allowShortFlagBundles: true,
  stopAtDoubleDash: true,
  treatSingleDashAsPositional: true,
  specialTokenParsers: [],
};

type CommandClassification =
  | { kind: 'alias', value: string }
  | { kind: 'function' }
  | { kind: 'builtin' }
  | { kind: 'file', path: string };

async function resolvePathClassification({
  context,
  name,
}: {
  context: WeshCommandContext,
  name: string,
}): Promise<Extract<CommandClassification, { kind: 'file' }> | undefined> {
  const resolved = (await resolvePathCommands({ context, name }))[0];
  return resolved === undefined
    ? undefined
    : {
      kind: 'file',
      path: resolved.invocationPath,
    };
}

async function classifyCommands({
  context,
  name,
  includeAll,
  suppressFunctions,
  forcePath,
}: {
  context: WeshCommandContext,
  name: string,
  includeAll: boolean,
  suppressFunctions: boolean,
  forcePath: boolean,
}): Promise<readonly CommandClassification[]> {
  if (forcePath) {
    const path = await resolvePathClassification({ context, name });
    return path === undefined ? [] : [path];
  }

  const classifications: CommandClassification[] = [];
  const alias = context.getAliases().find(candidate => candidate.name === name);
  if (alias !== undefined) {
    classifications.push({ kind: 'alias', value: alias.value });
    if (!includeAll) return classifications;
  }

  if (!suppressFunctions && hasShellFunction({ context, name })) {
    classifications.push({ kind: 'function' });
    if (!includeAll) return classifications;
  }

  if (shellControlFlowBuiltinNames.has(name)) {
    classifications.push({ kind: 'builtin' });
    if (!includeAll) return classifications;
  } else {
    const resolved = await resolveCommand({ context, name });
    switch (resolved.kind) {
    case 'not_found':
      break;
    case 'file':
      classifications.push({
        kind: 'file',
        path: resolved.invocationPath,
      });
      return classifications;
    case 'builtin':
      switch (resolved.resolution) {
      case 'builtin-name':
        classifications.push({ kind: 'builtin' });
        if (!includeAll) return classifications;
        break;
      case 'path-lookup':
      case 'explicit-path':
        classifications.push({
          kind: 'file',
          path: resolved.invocationPath ?? resolved.name,
        });
        return classifications;
      default: {
        const _ex: never = resolved;
        throw new Error(`Unhandled type command resolution: ${JSON.stringify(_ex)}`);
      }
      }
      break;
    default: {
      const _ex: never = resolved;
      throw new Error(`Unhandled resolved command: ${JSON.stringify(_ex)}`);
    }
    }
  }

  if (includeAll) {
    const path = await resolvePathClassification({ context, name });
    if (path !== undefined) classifications.push(path);
  }
  return classifications;
}

function formatClassification({
  name,
  classification,
  typeOnly,
}: {
  name: string,
  classification: CommandClassification,
  typeOnly: boolean,
}): string {
  if (typeOnly) {
    switch (classification.kind) {
    case 'alias':
      return 'alias';
    case 'function':
      return 'function';
    case 'builtin':
      return 'builtin';
    case 'file':
      return 'file';
    default: {
      const _ex: never = classification;
      throw new Error(`Unhandled type classification: ${JSON.stringify(_ex)}`);
    }
    }
  }

  switch (classification.kind) {
  case 'alias':
    return `${name} is aliased to \`${classification.value}'`;
  case 'function':
    return `${name} is a function`;
  case 'builtin':
    return `${name} is a shell builtin`;
  case 'file':
    return `${name} is ${classification.path}`;
  default: {
    const _ex: never = classification;
    throw new Error(`Unhandled type classification: ${JSON.stringify(_ex)}`);
  }
  }
}

export const typeCommandDefinition: WeshCommandDefinition = {
  meta: {
    name: 'type',
    description: 'Describe how command names are interpreted',
    usage: 'type [-afptP] name [name ...]',
  },
  fn: async ({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> => {
    const parsed = parseStandardArgv({
      args: stopStandardOptionParsingAtFirstPositional({ args: context.args, spec: typeArgvSpec }),
      spec: typeArgvSpec,
    });
    const diagnostic = parsed.diagnostics[0];
    if (diagnostic !== undefined) {
      await writeCommandUsageError({
        context,
        command: 'type',
        message: `type: ${diagnostic.message}`,
        argvSpec: typeArgvSpec,
      });
      return { exitCode: 2 };
    }
    if (parsed.optionValues.help === true) {
      await writeCommandHelp({ context, command: 'type', argvSpec: typeArgvSpec });
      return { exitCode: 0 };
    }
    if (parsed.positionals.length === 0) {
      return { exitCode: 0 };
    }

    const includeAll = parsed.optionValues.all === true;
    const suppressFunctions = parsed.optionValues.suppressFunctions === true;
    const pathOnly = parsed.optionValues.pathOnly === true;
    const forcePath = parsed.optionValues.forcePath === true;
    const typeOnly = parsed.optionValues.typeOnly === true;
    let exitCode = 0;

    for (const name of parsed.positionals) {
      const classifications = await classifyCommands({
        context,
        name,
        includeAll,
        suppressFunctions,
        forcePath,
      });
      if (classifications.length === 0) {
        exitCode = 1;
        if (!typeOnly && !pathOnly && !forcePath) {
          await context.text().error({ text: `type: ${name}: not found\n` });
        }
        continue;
      }

      for (const classification of classifications) {
        const output = (() => {
          if (!pathOnly && !forcePath) {
            return formatClassification({ name, classification, typeOnly });
          }
          switch (classification.kind) {
          case 'file':
            return classification.path;
          case 'alias':
          case 'function':
          case 'builtin':
            return undefined;
          default: {
            const _ex: never = classification;
            throw new Error(`Unhandled type path classification: ${JSON.stringify(_ex)}`);
          }
          }
        })();
        if (output === undefined) {
          continue;
        }
        await context.text().print({ text: `${output}\n` });
      }
    }
    return { exitCode };
  },
};

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
  classifyCommands,
  formatClassification,
  resolvePathClassification,
};
