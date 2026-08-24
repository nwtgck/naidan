import { normalizePath } from '@/features/wesh/path';
import type { WeshCommandContext, WeshCommandDefinition, WeshCommandResult } from '@/features/wesh/types';
import { runAdd, runBranch, runCheckout, runCherryPick, runClean, runClone, runCommit, runConfig, runFetch, runInit, runLog, runMerge, runPull, runPush, runRebase, runReflog, runReset, runRestore, runRevert, runRm, runRevParse, runShow, runStash, runStatus, runSwitch } from './operations';
import { runDiff } from './diff';
import { runLsFiles } from './ls-files';
import { runRemote } from './remote';
import { runTag } from './tag';
import { runApply } from './apply';
import { runMv } from './mv';
import { assertSupportedSafeCrlfClean, assertSupportedWorktreeContentConfig, parseConfigKey, readCommandConfigEntries, readEffectiveConfig, readGlobalConfigEntries } from './config';
import type { GitConfig } from './config';
import { discoverRepositoryFromContext } from './repository';

const HELP_TEXT = `\
usage: git [--version] [--help] <command> [<args>]

Common commands:
   init       Create an empty Git repository
   clone      Clone a local repository into a new directory
   config     Get and set repository options
   remote     Manage local repository remotes
   fetch      Download objects and refs from a local repository
   pull       Fetch and integrate with the current branch
   push       Update refs in a local repository
   add        Add file contents to the index
   apply      Apply a patch to the index or check whether it applies
   clean      Remove untracked files from the working tree
   rm         Remove files from the working tree and index
   mv         Move or rename a tracked file
   status     Show the working tree status
   diff       Show changes between states
   commit     Record changes to the repository
   log        Show commit logs
   show       Show revision contents
   branch     List, create, or delete branches
   tag        Create, list, or delete tags
   switch     Switch branches
   checkout   Switch branches or detach HEAD
   reset      Reset current HEAD to a revision
   restore    Restore working tree files
   merge      Join development histories
   cherry-pick Apply the changes introduced by a commit
   revert     Revert an existing commit
   rebase     Reapply commits on top of another base
   stash      Stash changes in a dirty working directory
   reflog     Manage reflog information
   rev-parse  Pick out and massage parameters
   ls-files   Show information about files in the index
`;

async function parseInvocation({ context }: { context: WeshCommandContext }): Promise<{
  context: WeshCommandContext,
  args: string[],
}> {
  let cwd = context.cwd;
  const env = new Map(context.env);
  let index = 0;
  while (index < context.args.length) {
    const arg = context.args[index]!;
    if (arg === '--no-pager') {
      index += 1;
      continue;
    }
    if (arg === '-c') {
      const assignment = context.args[index + 1];
      if (assignment === undefined) throw new Error("option '-c' requires a value");
      const separator = assignment.indexOf('=');
      const key = separator < 0 ? assignment : assignment.slice(0, separator);
      const value = separator < 0 ? '' : assignment.slice(separator + 1);
      parseConfigKey({ key });
      const rawCount = env.get('GIT_CONFIG_COUNT') ?? '0';
      if (!/^(?:0|[1-9][0-9]*)$/u.test(rawCount)) throw new Error('invalid GIT_CONFIG_COUNT');
      const count = Number(rawCount);
      env.set(`GIT_CONFIG_KEY_${count}`, key);
      env.set(`GIT_CONFIG_VALUE_${count}`, value);
      env.set('GIT_CONFIG_COUNT', String(count + 1));
      index += 2;
      continue;
    }
    if (arg === '--git-dir' || arg.startsWith('--git-dir=')) {
      const path = arg === '--git-dir' ? context.args[index + 1] : arg.slice('--git-dir='.length);
      if (path === undefined || path.length === 0) throw new Error("option '--git-dir' requires a value");
      env.set('GIT_DIR', normalizePath({ cwd, path }));
      index += arg === '--git-dir' ? 2 : 1;
      continue;
    }
    if (arg === '--work-tree' || arg.startsWith('--work-tree=')) {
      const path = arg === '--work-tree' ? context.args[index + 1] : arg.slice('--work-tree='.length);
      if (path === undefined || path.length === 0) throw new Error("option '--work-tree' requires a value");
      env.set('GIT_WORK_TREE', normalizePath({ cwd, path }));
      index += arg === '--work-tree' ? 2 : 1;
      continue;
    }
    if (arg !== '-C') break;
    const path = context.args[index + 1];
    if (path === undefined) throw new Error("option '-C' requires a value");
    const resolved = normalizePath({ cwd, path });
    let stat;
    try {
      stat = await context.files.stat({ path: resolved });
    } catch {
      throw new Error(`cannot change to '${path}': No such file or directory`);
    }
    switch (stat.type) {
    case 'directory':
      cwd = resolved;
      break;
    case 'file':
    case 'fifo':
    case 'chardev':
    case 'symlink':
      throw new Error(`cannot change to '${path}': Not a directory`);
    default: {
      const _ex: never = stat.type;
      throw new Error(`Unhandled -C target type: ${_ex}`);
    }
    }
    index += 2;
  }
  return { context: { ...context, cwd, env }, args: context.args.slice(index) };
}

function commandRequiresSafeCrlfClean({ command, args }: { command: string, args: readonly string[] }): boolean {
  switch (command) {
  case 'add':
    return true;
  case 'commit':
    return args.includes('-a') || args.includes('--all');
  case 'stash': {
    const subcommand = args[0] === undefined || args[0].startsWith('-') ? 'push' : args[0];
    return subcommand === 'push';
  }
  default:
    return false;
  }
}

function commandUsesWorktreeContentSemantics({ command, args }: { command: string, args: readonly string[] }): boolean {
  switch (command) {
  case 'clone':
  case 'add':
  case 'apply':
  case 'rm':
  case 'status':
  case 'diff':
  case 'pull':
  case 'switch':
  case 'checkout':
  case 'reset':
  case 'restore':
  case 'merge':
  case 'cherry-pick':
  case 'revert':
  case 'rebase':
  case 'stash':
    return true;
  case 'commit':
    return args.includes('-a') || args.includes('--all');
  case 'init':
  case 'config':
  case 'remote':
  case 'fetch':
  case 'push':
  case 'clean':
  case 'mv':
  case 'log':
  case 'show':
  case 'branch':
  case 'tag':
  case 'reflog':
  case 'rev-parse':
  case 'ls-files':
    return false;
  default:
    return false;
  }
}

async function assertSupportedContentPolicy({ context, command, args }: {
  context: WeshCommandContext,
  command: string,
  args: readonly string[],
}): Promise<void> {
  if (!commandUsesWorktreeContentSemantics({ command, args })) return;
  let config: GitConfig;
  if (command === 'clone') {
    config = new Map();
    for (const entry of await readGlobalConfigEntries({ files: context.files, homePath: context.env.get('HOME') ?? '/' })) {
      config.set(entry.key, entry.value);
    }
    for (const entry of readCommandConfigEntries({ env: context.env })) config.set(entry.key, entry.value);
  } else {
    const repository = await discoverRepositoryFromContext({ context });
    config = await readEffectiveConfig({
      files: context.files,
      repository,
      homePath: context.env.get('HOME') ?? '/',
      env: context.env,
    });
  }
  assertSupportedWorktreeContentConfig({ config });
  if (commandRequiresSafeCrlfClean({ command, args })) assertSupportedSafeCrlfClean({ config });
}

async function executeSubcommand({ context, command, args }: {
  context: WeshCommandContext,
  command: string,
  args: readonly string[],
}): Promise<WeshCommandResult> {
  switch (command) {
  case 'init':
    return runInit({ context, args });
  case 'clone':
    return runClone({ context, args });
  case 'config':
    return runConfig({ context, args });
  case 'remote':
    return runRemote({ context, args });
  case 'fetch':
    return runFetch({ context, args });
  case 'pull':
    return runPull({ context, args });
  case 'push':
    return runPush({ context, args });
  case 'add':
    return runAdd({ context, args });
  case 'apply':
    return runApply({ context, args });
  case 'clean':
    return runClean({ context, args });
  case 'rm':
    return runRm({ context, args });
  case 'mv':
    return runMv({ context, args });
  case 'status':
    return runStatus({ context, args });
  case 'diff':
    return runDiff({ context, args });
  case 'commit':
    return runCommit({ context, args });
  case 'log':
    return runLog({ context, args });
  case 'show':
    return runShow({ context, args });
  case 'branch':
    return runBranch({ context, args });
  case 'tag':
    return runTag({ context, args });
  case 'switch':
    return runSwitch({ context, args });
  case 'checkout':
    return runCheckout({ context, args });
  case 'reset':
    return runReset({ context, args });
  case 'restore':
    return runRestore({ context, args });
  case 'merge':
    return runMerge({ context, args });
  case 'cherry-pick':
    return runCherryPick({ context, args });
  case 'revert':
    return runRevert({ context, args });
  case 'rebase':
    return runRebase({ context, args });
  case 'stash':
    return runStash({ context, args });
  case 'reflog':
    return runReflog({ context, args });
  case 'rev-parse':
    return runRevParse({ context, args });
  case 'ls-files':
    return runLsFiles({ context, args });
  default:
    await context.text().error({
      text: `git: '${command}' is not a git command. See 'git --help'.\n`,
    });
    return { exitCode: 1 };
  }
}

export const gitCommandDefinition: WeshCommandDefinition = {
  meta: {
    name: 'git',
    description: 'Git-compatible version control commands',
    usage: 'git [--version] [--help] <command> [<args>]',
  },
  fn: async ({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> => {
    try {
      const invocation = await parseInvocation({ context });
      const invocationContext = invocation.context;
      const invocationArgs = invocation.args;
      if (invocationArgs.length === 0 || invocationArgs[0] === '--help' || invocationArgs[0] === '-h') {
        await invocationContext.text().print({ text: HELP_TEXT });
        return { exitCode: 0 };
      }
      if (invocationArgs[0] === '--version') {
        await invocationContext.text().print({ text: 'git version wesh\n' });
        return { exitCode: 0 };
      }

      const command = invocationArgs[0]!;
      const commandArgs = invocationArgs.slice(1);
      await assertSupportedContentPolicy({ context: invocationContext, command, args: commandArgs });
      return await executeSubcommand({ context: invocationContext, command, args: commandArgs });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.startsWith('Author identity unknown')) {
        await context.text().error({ text: `${message}\n` });
      } else {
        await context.text().error({ text: `fatal: ${message}\n` });
      }
      return { exitCode: 128 };
    }
  },
};

export const TEST_ONLY = {
};
