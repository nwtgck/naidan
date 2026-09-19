import { formatGitAmbiguousLongOption } from '@/features/wesh/commands/git/argv-diagnostics';
import { GitUsageError } from '@/features/wesh/commands/git/errors';
import { analyzeArgvLongForm, defineArgvCatalog } from '@/features/wesh/argv-v2';
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

type RemoteGlobalLongOptionSemantic = 'verbose' | 'no-verbose';

const REMOTE_GLOBAL_LONG_ARGV_CATALOG = defineArgvCatalog<RemoteGlobalLongOptionSemantic>({
  nonExecutableLongOptions: [],
  definitions: [
    { semantic: 'verbose', forms: [{ kind: 'long', name: 'verbose', value: { kind: 'none' } }] },
    { semantic: 'no-verbose', forms: [{ kind: 'long', name: 'no-verbose', value: { kind: 'none' } }] },
  ],
});

function resolveRemoteGlobalLongOption({ arg }: { arg: string }): boolean | undefined {
  if (arg === '--' || !arg.startsWith('--')) return undefined;
  if (arg === '--no-') {
    throw new GitUsageError({
      message: formatGitAmbiguousLongOption({
        option: arg,
        candidateOptions: ['--no-verbose', '--no-verbose'],
      }),
    });
  }
  const analysis = analyzeArgvLongForm({
    token: arg,
    catalog: REMOTE_GLOBAL_LONG_ARGV_CATALOG,
    longNameMatch: 'unique-prefix',
  });
  switch (analysis.kind) {
  case 'matched':
    switch (analysis.value.kind) {
    case 'none':
      switch (analysis.semantic) {
      case 'verbose':
        return true;
      case 'no-verbose':
        return false;
      default: {
        const _ex: never = analysis.semantic;
        throw new Error(`Unhandled remote global semantic: ${_ex}`);
      }
      }
    case 'unexpected-inline': {
      const optionName = (() => {
        switch (analysis.semantic) {
        case 'verbose':
          return 'verbose';
        case 'no-verbose':
          return 'no-verbose';
        default: {
          const _ex: never = analysis.semantic;
          throw new Error(`Unhandled remote global semantic: ${_ex}`);
        }
        }
      })();
      throw new GitUsageError({
        message: `option \`${optionName}' takes no value`,
      });
    }
    case 'inline':
    case 'following-required':
      throw new Error(`Unexpected remote argv-v2 value claim for ${arg}`);
    default: {
      const _ex: never = analysis.value;
      throw new Error(`Unhandled remote argv-v2 value analysis: ${JSON.stringify(_ex)}`);
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
    throw new Error(`Unhandled remote argv-v2 analysis: ${JSON.stringify(_ex)}`);
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

  let verbose = false;
  let globalArgCount = 0;
  while (globalArgCount < args.length) {
    const arg = args[globalArgCount]!;
    if (arg === '-v') {
      verbose = true;
      globalArgCount += 1;
      continue;
    }
    const longVerbose = resolveRemoteGlobalLongOption({ arg });
    if (longVerbose === undefined) break;
    verbose = longVerbose;
    globalArgCount += 1;
  }

  const remainingArgs = args.slice(globalArgCount);
  const listArgs = remainingArgs.at(-1) === '--' ? remainingArgs.slice(0, -1) : remainingArgs;
  if (listArgs.length === 0) {
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

  const commandArgs = remainingArgs[1] === '--'
    ? [remainingArgs[0]!, ...remainingArgs.slice(2)]
    : remainingArgs.at(-1) === '--'
      ? remainingArgs.slice(0, -1)
      : remainingArgs;
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
