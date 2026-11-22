import { defineArgvCatalog, defineArgvHelpPresentation, formatArgvOptionHelp, formatArgvUsageSummary, parseStandardArgv, type StandardArgvAction } from '@/features/wesh/argv-v2';
import { writeCommandHelp, writeCommandUsageError } from '@/features/wesh/commands/_shared/usage-output';
import { resolveCommand, resolvePathCommands, shellIntrinsicNames } from '@/features/wesh/command-resolution';
import type {
  WeshBuiltinCommandContext,
  WeshShellBuiltinFunction,
  WeshCommandResult,
} from '@/features/wesh/types';

const typeOptions = [
  {
    forms: [{ kind: 'short', name: 'a', value: { kind: 'none' } }],
    semantic: { kind: 'effects', effects: [{ key: 'all', value: true }] },
    summary: 'print all matching command locations',
  },
  {
    forms: [{ kind: 'short', name: 'f', value: { kind: 'none' } }],
    semantic: { kind: 'effects', effects: [{ key: 'suppressFunctions', value: true }] },
    summary: 'suppress shell-function lookup',
  },
  {
    forms: [{ kind: 'short', name: 'p', value: { kind: 'none' } }],
    semantic: { kind: 'effects', effects: [{ key: 'pathOnly', value: true }] },
    summary: 'print the executable path when available',
  },
  {
    forms: [{ kind: 'short', name: 'P', value: { kind: 'none' } }],
    semantic: { kind: 'effects', effects: [{ key: 'forcePath', value: true }] },
    summary: 'force a PATH search for each name',
  },
  {
    forms: [{ kind: 'short', name: 't', value: { kind: 'none' } }],
    semantic: { kind: 'effects', effects: [{ key: 'typeOnly', value: true }] },
    summary: 'print one word describing each command type',
  },
  {
    forms: [{ kind: 'long', name: 'help', value: { kind: 'none' } }],
    semantic: { kind: 'effects', effects: [{ key: 'help', value: true }] },
    summary: 'display this help and exit',
    category: 'common',
  },
] as const;

const typeArgvCatalog = defineArgvCatalog<StandardArgvAction<never>>({ definitions: typeOptions, nonExecutableLongOptions: [] });
const typeArgvHelp = defineArgvHelpPresentation({ catalog: typeArgvCatalog, rows: typeOptions });

type CommandClassification =
  | { kind: 'alias', value: string }
  | { kind: 'function' }
  | { kind: 'builtin' }
  | { kind: 'file', path: string };

async function resolvePathClassification({
  context,
  name,
  searchPathEntries,
}: {
  context: WeshBuiltinCommandContext,
  name: string,
  searchPathEntries: readonly string[],
}): Promise<Extract<CommandClassification, { kind: 'file' }> | undefined> {
  const resolved = (await resolvePathCommands({ context, name, searchPathEntries }))[0];
  return resolved === undefined
    ? undefined
    : {
      kind: 'file',
      path: resolved.invocationPath,
    };
}

async function classifyCommands({
  context,
  getAliases,
  hasFunction,
  name,
  searchPathEntries,
  includeAll,
  suppressFunctions,
  forcePath,
}: {
  context: WeshBuiltinCommandContext,
  getAliases: () => readonly { name: string, value: string }[],
  hasFunction: ({ name }: { name: string }) => boolean,
  name: string,
  searchPathEntries: readonly string[],
  includeAll: boolean,
  suppressFunctions: boolean,
  forcePath: boolean,
}): Promise<readonly CommandClassification[]> {
  if (forcePath) {
    const path = await resolvePathClassification({ context, name, searchPathEntries });
    return path === undefined ? [] : [path];
  }

  const classifications: CommandClassification[] = [];
  const alias = getAliases().find(candidate => candidate.name === name);
  if (alias !== undefined) {
    classifications.push({ kind: 'alias', value: alias.value });
    if (!includeAll) {
      return classifications;
    }
  }

  if (!suppressFunctions && hasFunction({ name })) {
    classifications.push({ kind: 'function' });
    if (!includeAll) {
      return classifications;
    }
  }

  if (shellIntrinsicNames.has(name)) {
    classifications.push({ kind: 'builtin' });
    if (!includeAll) {
      return classifications;
    }
  } else {
    const resolved = await resolveCommand({ context, name, searchPathEntries });
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
        if (!includeAll) {
          return classifications;
        }
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
    const path = await resolvePathClassification({ context, name, searchPathEntries });
    if (path !== undefined) {
      classifications.push(path);
    }
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

export const typeCommandImplementation = {
  fn: async ({ context, shell }): Promise<WeshCommandResult> => {
    const parsed = parseStandardArgv({
      args: context.args,
      catalog: typeArgvCatalog,
      policy: { longNameMatch: 'exact', optionBoundary: 'first-positional', occurrenceRetention: 'none' },
    });
    const diagnostic = parsed.diagnostics[0];
    if (diagnostic !== undefined) {
      await writeCommandUsageError({
        context,
        command: 'type',
        message: `type: ${diagnostic.message}`,
        usageSummary: formatArgvUsageSummary({ presentation: typeArgvHelp }),
      });
      return { exitCode: 2 };
    }
    if (parsed.optionValues.help === true) {
      await writeCommandHelp({ context, command: 'type', optionLines: formatArgvOptionHelp({ presentation: typeArgvHelp }) });
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
    const searchPathEntries = (shell.getSearchPath() ?? '').split(':');
    let exitCode = 0;

    for (const name of parsed.positionals) {
      const classifications = await classifyCommands({
        context,
        getAliases: shell.getAliases,
        hasFunction: shell.hasFunction,
        name,
        searchPathEntries,
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
} satisfies { readonly fn: WeshShellBuiltinFunction<'getAliases' | 'getSearchPath' | 'hasFunction'> };

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
  classifyCommands,
  formatClassification,
  resolvePathClassification,
};
