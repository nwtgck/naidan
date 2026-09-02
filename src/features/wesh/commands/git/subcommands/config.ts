import { formatGitAmbiguousLongOption } from '@/features/wesh/commands/git/argv-diagnostics';
import { GitUsageError } from '@/features/wesh/commands/git/errors';
import { analyzeArgvLongForm, defineArgvCatalog } from '@/features/wesh/argv-v2';
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


type ConfigLongOptionSemantic =
  | 'scope-global'
  | 'scope-local'
  | 'action-list'
  | 'action-get'
  | 'action-get-all'
  | 'action-unset'
  | 'action-unset-all'
  | 'action-add';

const CONFIG_LONG_ARGV_CATALOG = defineArgvCatalog<ConfigLongOptionSemantic>({
  nonExecutableLongOptions: [
    'system',
    'worktree',
    'file',
    'blob',
    'get-regexp',
    'get-urlmatch',
    'replace-all',
    'rename-section',
    'remove-section',
    'edit',
    'get-color',
    'get-colorbool',
    'null',
    'name-only',
    'show-origin',
    'show-scope',
    'show-names',
    'type',
    'bool',
    'int',
    'bool-or-int',
    'bool-or-str',
    'path',
    'expiry-date',
    'default',
    'comment',
    'fixed-value',
    'includes',
    'no-global',
    'no-system',
    'no-local',
    'no-worktree',
    'no-file',
    'no-blob',
    'no-null',
    'no-name-only',
    'no-show-origin',
    'no-show-scope',
    'no-show-names',
    'no-type',
    'no-default',
    'no-comment',
    'no-fixed-value',
    'no-includes',
  ],
  definitions: [
    { semantic: 'scope-global', forms: [{ kind: 'long', name: 'global', value: { kind: 'none' } }] },
    { semantic: 'scope-local', forms: [{ kind: 'long', name: 'local', value: { kind: 'none' } }] },
    { semantic: 'action-list', forms: [{ kind: 'long', name: 'list', value: { kind: 'none' } }] },
    { semantic: 'action-get', forms: [{ kind: 'long', name: 'get', value: { kind: 'none' } }] },
    { semantic: 'action-get-all', forms: [{ kind: 'long', name: 'get-all', value: { kind: 'none' } }] },
    { semantic: 'action-unset', forms: [{ kind: 'long', name: 'unset', value: { kind: 'none' } }] },
    { semantic: 'action-unset-all', forms: [{ kind: 'long', name: 'unset-all', value: { kind: 'none' } }] },
    { semantic: 'action-add', forms: [{ kind: 'long', name: 'add', value: { kind: 'none' } }] },
  ],
});

function resolveConfigLongOption({ arg }: { arg: string }): ConfigLongOptionSemantic | undefined {
  if (!arg.startsWith('--')) return undefined;
  if (!arg.includes('=')) {
    const optionName = arg.slice(2);
    if (optionName === 'g' || optionName === 'ge' || optionName === 'get-') {
      throw new GitUsageError({
        message: formatGitAmbiguousLongOption({
          option: arg,
          candidateOptions: ['--get-color', '--get-colorbool'],
        }),
      });
    }
  }
  const analysis = analyzeArgvLongForm({
    token: arg,
    catalog: CONFIG_LONG_ARGV_CATALOG,
    longNameMatch: 'unique-prefix',
  });
  switch (analysis.kind) {
  case 'matched':
    switch (analysis.value.kind) {
    case 'none':
      return analysis.semantic;
    case 'unexpected-inline':
    case 'inline':
    case 'following-required':
      throw new GitUsageError({ message: `unknown option: ${arg}` });
    default: {
      const _ex: never = analysis.value;
      throw new Error(`Unhandled config argv-v2 value analysis: ${JSON.stringify(_ex)}`);
    }
    }
  case 'ambiguous':
    throw new GitUsageError({
      message: formatGitAmbiguousLongOption({
        option: analysis.option,
        candidateOptions: analysis.candidateOptions,
      }),
    });
  case 'unknown':
    return undefined;
  default: {
    const _ex: never = analysis;
    throw new Error(`Unhandled config argv-v2 analysis: ${JSON.stringify(_ex)}`);
  }
  }
}


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
    const longOption = parsingOptions ? resolveConfigLongOption({ arg }) : undefined;
    switch (longOption) {
    case 'scope-global':
    case 'scope-local': {
      const nextScope = (() => {
        switch (longOption) {
        case 'scope-global':
          return 'global' as const;
        case 'scope-local':
          return 'local' as const;
        default: {
          const _ex: never = longOption;
          throw new Error(`Unhandled config scope semantic: ${_ex}`);
        }
        }
      })();
      if (scope !== 'effective' && scope !== nextScope)
        throw new Error('only one config file at a time');
      scope = nextScope;
      continue;
    }
    case 'action-list':
      commandArgs.push('--list');
      continue;
    case 'action-get':
      commandArgs.push('--get');
      continue;
    case 'action-get-all':
      commandArgs.push('--get-all');
      continue;
    case 'action-unset':
      commandArgs.push('--unset');
      continue;
    case 'action-unset-all':
      commandArgs.push('--unset-all');
      continue;
    case 'action-add':
      commandArgs.push('--add');
      continue;
    case undefined:
      break;
    default: {
      const _ex: never = longOption;
      throw new Error(`Unhandled config long option semantic: ${_ex}`);
    }
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
