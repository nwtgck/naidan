import { runClone } from "./subcommands/clone";
import { runPull } from "./subcommands/pull";
import { runAdd } from "./subcommands/add";
import { runStatus } from "./subcommands/status";
import { runRm } from "./subcommands/rm";
import { runClean } from "./subcommands/clean";
import { runCommit } from "./subcommands/commit";
import { runRestore } from "./subcommands/restore";
import { runReset } from "./subcommands/reset";
import { runMerge } from "./subcommands/merge";
import { runCherryPick } from "./subcommands/cherry-pick";
import { runRevert } from "./subcommands/revert";
import { runRebase } from "./subcommands/rebase";
import { runLog } from "./subcommands/log";
import { runGrep } from "./subcommands/grep";
import { runBlame } from "./subcommands/blame";
import { runBranch } from "./subcommands/branch";
import { runSwitch } from "./subcommands/switch";
import { runCheckout } from "./subcommands/checkout";
import { runStash } from "./subcommands/stash";
import { runShow } from "./subcommands/show";
import { runInit } from './subcommands/init';
import { runFetch } from './subcommands/fetch';
import { runPush } from './subcommands/push';
import { runConfig } from './subcommands/config';
import { runRevParse } from './subcommands/rev-parse';
import { runReflog } from './subcommands/reflog';
import type { WeshCommandContext, WeshCommandImplementation, WeshCommandResult } from '@/features/wesh/types';
import { runDiff } from './subcommands/diff';
import { runLsFiles } from './subcommands/ls-files';
import { runRemote } from './subcommands/remote';
import { runTag } from './subcommands/tag';
import { runApply } from './subcommands/apply';
import { runMv } from './subcommands/mv';
import { parseGitInvocation } from "./command-invocation";
import { GitUsageError } from "./errors";

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
   grep       Print lines matching a pattern
   blame      Show what revision last modified each line
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
  case 'grep':
    return runGrep({ context, args });
  case 'blame':
    return runBlame({ context, args });
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

export const gitCommandImplementation: WeshCommandImplementation = {
  fn: async ({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> => {
    try {
      const invocation = await parseGitInvocation({ context });
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
      return await executeSubcommand({ context: invocationContext, command, args: commandArgs });
    } catch (error: unknown) {
      if (error instanceof GitUsageError) {
        const prefix = (() => {
          switch (error.prefix) {
          case 'error':
            return 'error: ';
          case 'fatal':
            return 'fatal: ';
          case 'none':
            return '';
          default: {
            const _ex: never = error.prefix;
            throw new Error(`Unhandled Git usage error prefix: ${_ex}`);
          }
          }
        })();
        await context.text().error({ text: `${prefix}${error.message}\n` });
        return { exitCode: 129 };
      }
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
