import type { WeshCommandContext, WeshCommandResult } from '@/features/wesh/types';
import { getConfigValue, readEffectiveConfig, removeLocalConfigSection, setLocalConfigValue } from '@/features/wesh/commands/git/config';
import { pathExists } from '@/features/wesh/commands/git/files';
import { joinPath, discoverRepositoryFromContext } from '@/features/wesh/commands/git/repository';
import { sortGitUtf8Strings } from '@/features/wesh/commands/git/utf8-order';

function remoteNames({ config }: { config: Awaited<ReturnType<typeof readEffectiveConfig>> }): string[] {
  const names = new Set<string>();
  for (const key of config.keys()) {
    const match = /^remote\.(.+)\.url$/u.exec(key);
    if (match !== null) names.add(match[1]!);
  }
  return sortGitUtf8Strings({ values: names });
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
  const config = await readEffectiveConfig({ files: context.files, repository, homePath: context.env.get('HOME') ?? '/', env: context.env });
  if (args.length === 0 || (args.length === 1 && args[0] === '-v')) {
    const verbose = args.length === 1;
    for (const name of remoteNames({ config })) {
      if (!verbose) {
        await context.text().print({ text: `${name}\n` });
        continue;
      }
      const url = getConfigValue({ config, key: `remote.${name}.url` })!;
      await context.text().print({ text: `${name}\t${url} (fetch)\n${name}\t${url} (push)\n` });
    }
    return { exitCode: 0 };
  }

  const subcommand = args[0]!;
  switch (subcommand) {
  case 'add': {
    if (args.length !== 3) throw new Error('usage: git remote add <name> <url>');
    const name = args[1]!;
    if (getConfigValue({ config, key: `remote.${name}.url` }) !== undefined) {
      throw new Error(`remote ${name} already exists.`);
    }
    await setLocalConfigValue({ files: context.files, repository, key: `remote.${name}.url`, value: args[2]! });
    await setLocalConfigValue({
      files: context.files,
      repository,
      key: `remote.${name}.fetch`,
      value: `+refs/heads/*:refs/remotes/${name}/*`,
    });
    return { exitCode: 0 };
  }
  case 'get-url': {
    if (args.length !== 2) throw new Error('usage: git remote get-url <name>');
    const url = getConfigValue({ config, key: `remote.${args[1]!}.url` });
    if (url === undefined) throw new Error(`No such remote '${args[1]!}'`);
    await context.text().print({ text: `${url}\n` });
    return { exitCode: 0 };
  }
  case 'set-url': {
    if (args.length !== 3) throw new Error('usage: git remote set-url <name> <newurl>');
    const name = args[1]!;
    if (getConfigValue({ config, key: `remote.${name}.url` }) === undefined) {
      throw new Error(`No such remote '${name}'`);
    }
    await setLocalConfigValue({ files: context.files, repository, key: `remote.${name}.url`, value: args[2]! });
    return { exitCode: 0 };
  }
  case 'remove':
  case 'rm': {
    if (args.length !== 2) throw new Error(`usage: git remote ${subcommand} <name>`);
    const name = args[1]!;
    if (!await removeLocalConfigSection({ files: context.files, repository, section: 'remote', subsection: name })) {
      throw new Error(`No such remote: '${name}'`);
    }
    await removePathRecursively({
      context,
      path: joinPath({ base: repository.commonDirPath, child: `refs/remotes/${name}` }),
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
