import { GitUsageError } from '@/features/wesh/commands/git/errors';
import type { WeshCommandContext, WeshCommandResult } from '@/features/wesh/types';
import { getRawConfigValue, readEffectiveConfigEntries, readLocalConfigEntries, removeLocalConfigSection, setLocalConfigValue, unsetLocalConfigValue } from '@/features/wesh/commands/git/config';
import type { GitConfigEntry } from '@/features/wesh/commands/git/config';
import { pathExists } from '@/features/wesh/commands/git/files';
import { joinPath, discoverRepositoryFromContext } from '@/features/wesh/commands/git/repository';
import { sortGitUtf8Strings } from '@/features/wesh/commands/git/utf8-order';
import { deleteRef, listRefs } from '@/features/wesh/commands/git/refs';

function remoteNames({ entries }: { entries: readonly GitConfigEntry[] }): string[] {
  const names = new Set<string>();
  for (const entry of entries) {
    const match = /^remote\.(.+)\.[^.]+$/u.exec(entry.key);
    if (match !== null) names.add(match[1]!);
  }
  return sortGitUtf8Strings({ values: names });
}

function configValues({ entries, key }: { entries: readonly GitConfigEntry[], key: string }): string[] {
  return entries.filter(entry => entry.key === key).map(entry => getRawConfigValue({ value: entry.value }));
}

async function removePathRecursively({ context, path }: { context: WeshCommandContext, path: string }): Promise<void> {
  if (!await pathExists({ files: context.files, path })) return;
  const stat = await context.files.lstat({ path });
  switch (stat.type) {
  case 'directory':
    for await (const entry of context.files.readDir({ path })) {
      await removePathRecursively({ context, path: entry.fullPath });
    }
    await context.files.rmdir({ path });
    return;
  case 'file':
  case 'fifo':
  case 'chardev':
  case 'symlink':
    await context.files.unlink({ path });
    return;
  default: {
    const _ex: never = stat.type;
    throw new Error(`Unhandled remote ref entry type: ${_ex}`);
  }
  }
}

export async function runRemote({ context, args }: {
  context: WeshCommandContext,
  args: readonly string[],
}): Promise<WeshCommandResult> {
  const repository = await discoverRepositoryFromContext({ context });
  const configEntries = await readEffectiveConfigEntries({
    files: context.files,
    repository,
    homePath: context.env.get('HOME') ?? '/',
    cwd: context.cwd,
    env: context.env,
  });
  const names = remoteNames({ entries: configEntries });
  const localConfigEntries = await readLocalConfigEntries({ files: context.files, repository });
  const localRemoteNames = remoteNames({ entries: localConfigEntries });
  const listArgs = args.at(-1) === '--' ? args.slice(0, -1) : args;
  if (listArgs.length === 0 || (listArgs.length === 1 && listArgs[0] === '-v')) {
    const verbose = listArgs.length === 1;
    for (const name of names) {
      if (!verbose) {
        await context.text().print({ text: `${name}\n` });
        continue;
      }
      const urls = configValues({ entries: configEntries, key: `remote.${name}.url` });
      const pushUrls = configValues({ entries: configEntries, key: `remote.${name}.pushurl` });
      const fetchUrl = urls[0];
      await context.text().print({ text: fetchUrl === undefined ? `${name}\t\n` : `${name}\t${fetchUrl} (fetch)\n` });
      for (const pushUrl of pushUrls.length > 0 ? pushUrls : urls) {
        await context.text().print({ text: `${name}\t${pushUrl} (push)\n` });
      }
    }
    return { exitCode: 0 };
  }

  const commandArgs = args[1] === '--'
    ? [args[0]!, ...args.slice(2)]
    : args.at(-1) === '--'
      ? args.slice(0, -1)
      : args;
  const subcommand = commandArgs[0]!;
  if (subcommand.startsWith('-')) throw new GitUsageError({ message: `unknown option: ${subcommand}` });
  switch (subcommand) {
  case 'add': {
    if (commandArgs.length !== 3) throw new GitUsageError({ message: 'usage: git remote add <name> <url>', prefix: 'none' });
    const name = commandArgs[1]!;
    if (localRemoteNames.includes(name)) {
      await context.text().error({ text: `error: remote ${name} already exists.\n` });
      return { exitCode: 3 };
    }
    await setLocalConfigValue({ files: context.files, repository, key: `remote.${name}.url`, value: commandArgs[2]!, valuePattern: undefined });
    await setLocalConfigValue({
      files: context.files,
      repository,
      key: `remote.${name}.fetch`,
      value: `+refs/heads/*:refs/remotes/${name}/*`,
      valuePattern: undefined,
    });
    return { exitCode: 0 };
  }
  case 'get-url': {
    if (commandArgs.length !== 2) throw new GitUsageError({ message: 'usage: git remote get-url <name>', prefix: 'none' });
    const name = commandArgs[1]!;
    if (!localRemoteNames.includes(name)) {
      await context.text().error({ text: `error: No such remote '${name}'\n` });
      return { exitCode: 2 };
    }
    const url = configValues({ entries: configEntries, key: `remote.${name}.url` })[0] ?? name;
    await context.text().print({ text: `${url}\n` });
    return { exitCode: 0 };
  }
  case 'set-url': {
    if (commandArgs.length !== 3) throw new GitUsageError({ message: 'usage: git remote set-url <name> <newurl>', prefix: 'none' });
    const name = commandArgs[1]!;
    if (!localRemoteNames.includes(name)) {
      await context.text().error({ text: `error: No such remote '${name}'\n` });
      return { exitCode: 2 };
    }
    const key = `remote.${name}.url`;
    const value = commandArgs[2]!;
    const setResult = await setLocalConfigValue({ files: context.files, repository, key, value, valuePattern: undefined });
    switch (setResult) {
    case 'set':
      return { exitCode: 0 };
    case 'multiple':
      await context.text().error({ text: `warning: ${key} has multiple values\n` });
      await context.text().error({ text: `fatal: could not set '${key}' to '${value}'\n` });
      return { exitCode: 128 };
    default: {
      const _ex: never = setResult;
      throw new Error(`Unhandled remote set-url result: ${_ex}`);
    }
    }
  }
  case 'remove':
  case 'rm': {
    if (commandArgs.length !== 2) throw new GitUsageError({ message: `usage: git remote ${subcommand} <name>`, prefix: 'none' });
    const name = commandArgs[1]!;
    if (!await removeLocalConfigSection({ files: context.files, repository, section: 'remote', subsection: name })) {
      await context.text().error({ text: `error: No such remote: '${name}'\n` });
      return { exitCode: 2 };
    }
    const branchesUsingRemote = new Set<string>();
    const branchesUsingPushRemote = new Set<string>();
    for (const entry of localConfigEntries) {
      const match = /^branch\.(.+)\.(remote|pushremote)$/u.exec(entry.key);
      if (match === null || getRawConfigValue({ value: entry.value }) !== name) continue;
      if (match[2] === 'remote') branchesUsingRemote.add(match[1]!);
      else branchesUsingPushRemote.add(match[1]!);
    }
    for (const branchName of branchesUsingRemote) {
      await unsetLocalConfigValue({ files: context.files, repository, key: `branch.${branchName}.remote`, all: true, valuePattern: undefined });
      await unsetLocalConfigValue({ files: context.files, repository, key: `branch.${branchName}.merge`, all: true, valuePattern: undefined });
    }
    for (const branchName of branchesUsingPushRemote) {
      await unsetLocalConfigValue({ files: context.files, repository, key: `branch.${branchName}.pushremote`, all: true, valuePattern: undefined });
    }
    const remoteRefPrefix = `refs/remotes/${name}`;
    for (const ref of await listRefs({ files: context.files, repository, prefix: 'refs' })) {
      if (ref.refName === remoteRefPrefix || ref.refName.startsWith(`${remoteRefPrefix}/`)) {
        await deleteRef({ files: context.files, repository, refName: ref.refName });
      }
    }
    await removePathRecursively({
      context,
      path: joinPath({ base: repository.commonDirPath, child: `logs/${remoteRefPrefix}` }),
    });
    return { exitCode: 0 };
  }
  default:
    throw new Error(`Unknown subcommand: ${subcommand}`);
  }
}

export const TEST_ONLY = {
  remoteNames,
};
