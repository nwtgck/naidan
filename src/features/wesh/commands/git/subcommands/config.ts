import { GitUsageError } from '@/features/wesh/commands/git/errors';
import type { WeshCommandContext, WeshCommandResult } from "@/features/wesh/types";
import {
  addGlobalConfigValue,
  addLocalConfigValue,
  compileGitConfigValuePattern,
  configKeysEqual,
  configValueMatchesPattern,
  formatConfigEntryForList,
  getRawConfigValue,
  parseConfigKey,
  readCommandConfigEntries,
  readEffectiveConfigEntries,
  readGlobalConfigEntries,
  readLocalConfigEntries,
  readRequiredGlobalConfigEntries,
  setGlobalConfigValue,
  setLocalConfigValue,
  type GitConfigEntry,
  type GitConfigValuePattern,
  unsetGlobalConfigValue,
  unsetLocalConfigValue,
} from '@/features/wesh/commands/git/config';
import { discoverRepositoryFromContext, discoverRepositoryFromContextIfPresent } from "@/features/wesh/commands/git/repository";


async function compileValuePatternOrReport({ context, pattern }: {
  context: WeshCommandContext,
  pattern: string,
}): Promise<GitConfigValuePattern | 'invalid'> {
  try {
    return compileGitConfigValuePattern({ pattern });
  } catch {
    await context.text().error({ text: `error: invalid pattern: ${pattern}\n` });
    return 'invalid';
  }
}

function rawConfigValuesMatching({ entries, key, valuePattern }: {
  entries: readonly GitConfigEntry[],
  key: string,
  valuePattern: GitConfigValuePattern | undefined,
}): string[] {
  return entries
    .filter(entry => configKeysEqual({ left: entry.key, right: key }))
    .map(entry => getRawConfigValue({ value: entry.value }))
    .filter(value => valuePattern === undefined || configValueMatchesPattern({ value, valuePattern }));
}

export async function runConfig({ context, args }: {
  context: WeshCommandContext,
  args: readonly string[],
}): Promise<WeshCommandResult> {
  let scope: 'effective' | 'global' | 'local' = 'effective';
  const commandArgs: string[] = [];
  let parsingOptions = true;
  for (const arg of args) {
    if (parsingOptions && arg === '--') {
      parsingOptions = false;
      continue;
    }
    if (parsingOptions && (arg === '--global' || arg === '--local')) {
      let nextScope: 'global' | 'local';
      switch (arg) {
      case '--global':
        nextScope = 'global';
        break;
      case '--local':
        nextScope = 'local';
        break;
      default: {
        const _ex: never = arg;
        throw new Error(`Unhandled config scope option: ${_ex}`);
      }
      }
      if (scope !== 'effective' && scope !== nextScope)
        throw new Error('only one config file at a time');
      scope = nextScope;
      continue;
    }
    commandArgs.push(arg);
    if (!arg.startsWith('-'))
      parsingOptions = false;
  }
  const keyToValidate = (() => {
    switch (commandArgs[0]) {
    case '--get':
    case '--get-all':
    case '--unset':
    case '--unset-all':
      return commandArgs.length === 2 || commandArgs.length === 3 ? commandArgs[1] : undefined;
    case '--add':
      return commandArgs.length === 3 ? commandArgs[1] : undefined;
    case '--list':
      return undefined;
    default:
      if ((commandArgs.length === 1 || commandArgs.length === 2 || commandArgs.length === 3)
        && !commandArgs[0]?.startsWith('-')) {
        return commandArgs[0];
      }
      return undefined;
    }
  })();
  if (keyToValidate !== undefined) {
    try {
      parseConfigKey({ key: keyToValidate });
    } catch {
      await context.text().error({ text: `error: invalid key: ${keyToValidate}\n` });
      return { exitCode: 1 };
    }
  }

  const homePath = context.env.get('HOME') ?? '/';
  const access = await (async () => {
    switch (scope) {
    case 'effective':
      return {
        readEntries: async () => {
          const repository = await discoverRepositoryFromContextIfPresent({ context });
          if (repository !== undefined) {
            return readEffectiveConfigEntries({
              files: context.files,
              repository,
              homePath,
              cwd: context.cwd,
              env: context.env,
            });
          }
          return [
            ...await readGlobalConfigEntries({ files: context.files, homePath, cwd: context.cwd, env: context.env }),
            ...readCommandConfigEntries({ env: context.env }),
          ];
        },
        setValue: async ({ key, value, valuePattern }: {
          key: string,
          value: string,
          valuePattern: GitConfigValuePattern | undefined,
        }) => {
          const repository = await discoverRepositoryFromContext({ context });
          return setLocalConfigValue({ files: context.files, repository, key, value, valuePattern });
        },
        addValue: async ({ key, value }: { key: string, value: string }) => {
          const repository = await discoverRepositoryFromContext({ context });
          await addLocalConfigValue({ files: context.files, repository, key, value });
        },
        unsetValue: async ({ key, all, valuePattern }: {
          key: string,
          all: boolean,
          valuePattern: GitConfigValuePattern | undefined,
        }) => {
          const repository = await discoverRepositoryFromContext({ context });
          return unsetLocalConfigValue({ files: context.files, repository, key, all, valuePattern });
        },
      };
    case 'global':
      return {
        readEntries: () => readGlobalConfigEntries({ files: context.files, homePath, cwd: context.cwd, env: context.env }),
        setValue: ({ key, value, valuePattern }: {
          key: string,
          value: string,
          valuePattern: GitConfigValuePattern | undefined,
        }) => setGlobalConfigValue({
          files: context.files,
          homePath,
          cwd: context.cwd,
          env: context.env,
          key,
          value,
          valuePattern,
        }),
        addValue: ({ key, value }: { key: string, value: string }) =>
          addGlobalConfigValue({ files: context.files, homePath, cwd: context.cwd, env: context.env, key, value }),
        unsetValue: ({ key, all, valuePattern }: {
          key: string,
          all: boolean,
          valuePattern: GitConfigValuePattern | undefined,
        }) => unsetGlobalConfigValue({
          files: context.files,
          homePath,
          cwd: context.cwd,
          env: context.env,
          key,
          all,
          valuePattern,
        }),
      };
    case 'local': {
      const repository = await discoverRepositoryFromContext({ context });
      return {
        readEntries: () => readLocalConfigEntries({ files: context.files, repository }),
        setValue: ({ key, value, valuePattern }: {
          key: string,
          value: string,
          valuePattern: GitConfigValuePattern | undefined,
        }) => setLocalConfigValue({ files: context.files, repository, key, value, valuePattern }),
        addValue: ({ key, value }: { key: string, value: string }) =>
          addLocalConfigValue({ files: context.files, repository, key, value }),
        unsetValue: ({ key, all, valuePattern }: {
          key: string,
          all: boolean,
          valuePattern: GitConfigValuePattern | undefined,
        }) => unsetLocalConfigValue({ files: context.files, repository, key, all, valuePattern }),
      };
    }
    default: {
      const _ex: never = scope;
      throw new Error(`Unhandled config scope: ${_ex}`);
    }
    }
  })();

  const commandOption = commandArgs[0];
  if (commandOption !== undefined && commandOption.startsWith('-')
    && !['--list', '--get', '--get-all', '--unset', '--unset-all', '--add'].includes(commandOption)) {
    await access.readEntries();
    throw new GitUsageError({ message: `unknown option: ${commandOption}` });
  }

  switch (commandArgs[0]) {
  case '--list': {
    if (commandArgs.length !== 1) throw new GitUsageError({ message: 'wrong number of arguments' });
    const entries = await (async () => {
      switch (scope) {
      case 'global':
        return readRequiredGlobalConfigEntries({ files: context.files, homePath, cwd: context.cwd, env: context.env });
      case 'effective':
      case 'local':
        return access.readEntries();
      default: {
        const _ex: never = scope;
        throw new Error(`Unhandled config scope: ${_ex}`);
      }
      }
    })();
    for (const entry of entries) {
      await context.text().print({ text: `${formatConfigEntryForList({ entry })}\n` });
    }
    return { exitCode: 0 };
  }
  case '--get': {
    if (commandArgs.length < 2 || commandArgs.length > 3)
      throw new GitUsageError({ message: 'wrong number of arguments, should be from 1 to 2' });
    const key = commandArgs[1]!;
    const entries = await access.readEntries();
    const compiled = commandArgs[2] === undefined
      ? undefined
      : await compileValuePatternOrReport({ context, pattern: commandArgs[2] });
    if (compiled === 'invalid') return { exitCode: 6 };
    const values = rawConfigValuesMatching({ entries, key, valuePattern: compiled });
    if (values.length === 0) return { exitCode: 1 };
    await context.text().print({ text: `${values[values.length - 1]!}\n` });
    return { exitCode: 0 };
  }
  case '--get-all': {
    if (commandArgs.length < 2 || commandArgs.length > 3)
      throw new GitUsageError({ message: 'wrong number of arguments, should be from 1 to 2' });
    const key = commandArgs[1]!;
    const entries = await access.readEntries();
    const compiled = commandArgs[2] === undefined
      ? undefined
      : await compileValuePatternOrReport({ context, pattern: commandArgs[2] });
    if (compiled === 'invalid') return { exitCode: 6 };
    const values = rawConfigValuesMatching({ entries, key, valuePattern: compiled });
    if (values.length === 0) return { exitCode: 1 };
    for (const value of values) await context.text().print({ text: `${value}\n` });
    return { exitCode: 0 };
  }
  case '--unset': {
    if (commandArgs.length < 2 || commandArgs.length > 3)
      throw new GitUsageError({ message: 'wrong number of arguments' });
    if (commandArgs[2] !== undefined) await access.readEntries();
    const compiled = commandArgs[2] === undefined
      ? undefined
      : await compileValuePatternOrReport({ context, pattern: commandArgs[2] });
    if (compiled === 'invalid') return { exitCode: 6 };
    const result = await access.unsetValue({ key: commandArgs[1]!, all: false, valuePattern: compiled });
    switch (result) {
    case 'missing':
      return { exitCode: 5 };
    case 'multiple':
      await context.text().error({ text: `warning: ${commandArgs[1]} has multiple values\n` });
      return { exitCode: 5 };
    case 'removed':
      return { exitCode: 0 };
    default: {
      const _ex: never = result;
      throw new Error(`Unhandled config unset result: ${_ex}`);
    }
    }
  }
  case '--unset-all': {
    if (commandArgs.length < 2 || commandArgs.length > 3)
      throw new GitUsageError({ message: 'wrong number of arguments' });
    if (commandArgs[2] !== undefined) await access.readEntries();
    const compiled = commandArgs[2] === undefined
      ? undefined
      : await compileValuePatternOrReport({ context, pattern: commandArgs[2] });
    if (compiled === 'invalid') return { exitCode: 6 };
    const result = await access.unsetValue({ key: commandArgs[1]!, all: true, valuePattern: compiled });
    switch (result) {
    case 'missing':
      return { exitCode: 5 };
    case 'multiple':
      throw new Error('Unexpected multiple result while unsetting all config values');
    case 'removed':
      return { exitCode: 0 };
    default: {
      const _ex: never = result;
      throw new Error(`Unhandled config unset-all result: ${_ex}`);
    }
    }
  }
  case '--add':
    if (commandArgs.length !== 3) throw new GitUsageError({ message: 'wrong number of arguments' });
    await access.addValue({ key: commandArgs[1]!, value: commandArgs[2]! });
    return { exitCode: 0 };
  default:
    break;
  }

  if (commandArgs.length === 1) {
    const entries = await access.readEntries();
    const key = commandArgs[0]!;
    const values = entries.filter(entry => configKeysEqual({ left: entry.key, right: key })).map(entry => getRawConfigValue({ value: entry.value }));
    if (values.length === 0) return { exitCode: 1 };
    await context.text().print({ text: `${values[values.length - 1]!}\n` });
    return { exitCode: 0 };
  }
  if (commandArgs.length === 2 || commandArgs.length === 3) {
    const key = commandArgs[0]!;
    if (commandArgs[2] !== undefined) await access.readEntries();
    const compiled = commandArgs[2] === undefined
      ? undefined
      : await compileValuePatternOrReport({ context, pattern: commandArgs[2] });
    if (compiled === 'invalid') return { exitCode: 6 };
    const result = await access.setValue({ key, value: commandArgs[1]!, valuePattern: compiled });
    switch (result) {
    case 'set':
      return { exitCode: 0 };
    case 'multiple':
      await context.text().error({ text: `warning: ${key} has multiple values\n` });
      if (compiled === undefined) {
        await context.text().error({ text: 'error: cannot overwrite multiple values with a single value\n' });
      }
      return { exitCode: 5 };
    default: {
      const _ex: never = result;
      throw new Error(`Unhandled config set result: ${_ex}`);
    }
    }
  }
  throw new GitUsageError({ message: 'wrong number of arguments' });
}

export const TEST_ONLY = {
};
