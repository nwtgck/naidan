import type { WeshCommandContext, WeshCommandResult } from "@/features/wesh/types";
import { addGlobalConfigValue, addLocalConfigValue, readEffectiveConfigEntries, readGlobalConfigEntries, readLocalConfigEntries, setGlobalConfigValue, setLocalConfigValue, unsetGlobalConfigValue, unsetLocalConfigValue } from "@/features/wesh/commands/git/config";
import { discoverRepositoryFromContext } from "@/features/wesh/commands/git/repository";

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
  const homePath = context.env.get('HOME') ?? '/';
  const access = await (async () => {
    switch (scope) {
    case 'effective': {
      const repository = await discoverRepositoryFromContext({ context });
      return {
        readEntries: () => readEffectiveConfigEntries({
          files: context.files,
          repository,
          homePath,
          env: context.env,
        }),
        setValue: ({ key, value }: { key: string, value: string }) =>
          setLocalConfigValue({ files: context.files, repository, key, value }),
        addValue: ({ key, value }: { key: string, value: string }) =>
          addLocalConfigValue({ files: context.files, repository, key, value }),
        unsetValue: ({ key, all }: { key: string, all: boolean }) =>
          unsetLocalConfigValue({ files: context.files, repository, key, all }),
      };
    }
    case 'global':
      return {
        readEntries: () => readGlobalConfigEntries({ files: context.files, homePath }),
        setValue: ({ key, value }: { key: string, value: string }) =>
          setGlobalConfigValue({ files: context.files, homePath, key, value }),
        addValue: ({ key, value }: { key: string, value: string }) =>
          addGlobalConfigValue({ files: context.files, homePath, key, value }),
        unsetValue: ({ key, all }: { key: string, all: boolean }) =>
          unsetGlobalConfigValue({ files: context.files, homePath, key, all }),
      };
    case 'local': {
      const repository = await discoverRepositoryFromContext({ context });
      return {
        readEntries: () => readLocalConfigEntries({ files: context.files, repository }),
        setValue: ({ key, value }: { key: string, value: string }) =>
          setLocalConfigValue({ files: context.files, repository, key, value }),
        addValue: ({ key, value }: { key: string, value: string }) =>
          addLocalConfigValue({ files: context.files, repository, key, value }),
        unsetValue: ({ key, all }: { key: string, all: boolean }) =>
          unsetLocalConfigValue({ files: context.files, repository, key, all }),
      };
    }
    default: {
      const _ex: never = scope;
      throw new Error(`Unhandled config scope: ${_ex}`);
    }
    }
  })();

  switch (commandArgs[0]) {
  case '--list': {
    if (commandArgs.length !== 1) throw new Error('wrong number of arguments');
    for (const entry of await access.readEntries()) {
      await context.text().print({ text: `${entry.key}=${entry.value}\n` });
    }
    return { exitCode: 0 };
  }
  case '--get': {
    if (commandArgs.length !== 2) throw new Error('wrong number of arguments, should be from 1 to 2');
    const key = commandArgs[1]!.toLowerCase();
    const values = (await access.readEntries()).filter(entry => entry.key.toLowerCase() === key).map(entry => entry.value);
    if (values.length === 0) return { exitCode: 1 };
    await context.text().print({ text: `${values[values.length - 1]!}\n` });
    return { exitCode: 0 };
  }
  case '--get-all': {
    if (commandArgs.length !== 2) throw new Error('wrong number of arguments, should be from 1 to 2');
    const key = commandArgs[1]!.toLowerCase();
    const values = (await access.readEntries()).filter(entry => entry.key.toLowerCase() === key).map(entry => entry.value);
    if (values.length === 0) return { exitCode: 1 };
    for (const value of values) await context.text().print({ text: `${value}\n` });
    return { exitCode: 0 };
  }
  case '--unset': {
    if (commandArgs.length !== 2) throw new Error('wrong number of arguments');
    const result = await access.unsetValue({ key: commandArgs[1]!, all: false });
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
    if (commandArgs.length !== 2) throw new Error('wrong number of arguments');
    const result = await access.unsetValue({ key: commandArgs[1]!, all: true });
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
    if (commandArgs.length !== 3) throw new Error('wrong number of arguments');
    await access.addValue({ key: commandArgs[1]!, value: commandArgs[2]! });
    return { exitCode: 0 };
  default:
    break;
  }

  if (commandArgs.length === 1) {
    const entries = await access.readEntries();
    const key = commandArgs[0]!.toLowerCase();
    const values = entries.filter(entry => entry.key.toLowerCase() === key).map(entry => entry.value);
    if (values.length === 0) return { exitCode: 1 };
    await context.text().print({ text: `${values[values.length - 1]!}\n` });
    return { exitCode: 0 };
  }
  if (commandArgs.length === 2) {
    await access.setValue({ key: commandArgs[0]!, value: commandArgs[1]! });
    return { exitCode: 0 };
  }
  throw new Error('wrong number of arguments');
}

export const TEST_ONLY = {
};
