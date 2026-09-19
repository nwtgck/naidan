import { analyzeArgvLongForm, defineArgvCatalog } from '@/features/wesh/argv-v2';
import { normalizePath } from "@/features/wesh/path";
import type { WeshCommandContext } from "@/features/wesh/types";
import { parseConfigKey, registerGitCommandConfigEntries, type GitCommandConfigEntry } from "./config";
import { GitUsageError } from "./errors";

type GitGlobalLongSemantic = 'no-pager' | 'git-dir' | 'work-tree';

const GIT_GLOBAL_LONG_ARGV_CATALOG = defineArgvCatalog<GitGlobalLongSemantic>({
  nonExecutableLongOptions: [],
  definitions: [
    {
      semantic: 'no-pager',
      forms: [{ kind: 'long', name: 'no-pager', value: { kind: 'none' } }],
    },
    {
      semantic: 'git-dir',
      forms: [{ kind: 'long', name: 'git-dir', value: { kind: 'required', missingValueName: 'path' } }],
    },
    {
      semantic: 'work-tree',
      forms: [{ kind: 'long', name: 'work-tree', value: { kind: 'required', missingValueName: 'path' } }],
    },
  ],
});

function missingGitDirectoryValue({ option }: { option: '--git-dir' | '--work-tree' }): GitUsageError {
  return new GitUsageError({ message: `no directory given for '${option}' option`, prefix: 'none' });
}

export async function parseGitInvocation({ context }: { context: WeshCommandContext }): Promise<{
  context: WeshCommandContext,
  args: string[],
}> {
  let cwd = context.cwd;
  const env = new Map(context.env);
  const commandConfigEntries: GitCommandConfigEntry[] = [];
  let index = 0;
  while (index < context.args.length) {
    const arg = context.args[index]!;
    if (arg === '--help' || arg === '--version') break;
    if (arg.startsWith('--')) {
      const analysis = analyzeArgvLongForm({
        token: arg,
        catalog: GIT_GLOBAL_LONG_ARGV_CATALOG,
        longNameMatch: 'exact',
      });
      switch (analysis.kind) {
      case 'matched':
        switch (analysis.semantic) {
        case 'no-pager':
          switch (analysis.value.kind) {
          case 'none':
            index += 1;
            continue;
          case 'unexpected-inline':
          case 'inline':
          case 'following-required':
            throw new GitUsageError({ message: `unknown option: ${arg}`, prefix: 'none' });
          default: {
            const _ex: never = analysis.value;
            throw new Error(`Unhandled --no-pager argv-v2 value analysis: ${JSON.stringify(_ex)}`);
          }
          }
        case 'git-dir':
        case 'work-tree': {
          const target = (() => {
            switch (analysis.semantic) {
            case 'git-dir':
              return { option: '--git-dir', envName: 'GIT_DIR' } as const;
            case 'work-tree':
              return { option: '--work-tree', envName: 'GIT_WORK_TREE' } as const;
            default: {
              const _ex: never = analysis.semantic;
              throw new Error(`Unhandled Git directory argv-v2 semantic: ${_ex}`);
            }
            }
          })();
          const value = (() => {
            switch (analysis.value.kind) {
            case 'inline':
              return analysis.value.rawValue;
            case 'following-required': {
              const following = context.args[index + 1];
              if (following === undefined) throw missingGitDirectoryValue({ option: target.option });
              index += 1;
              return following;
            }
            case 'none':
            case 'unexpected-inline':
              throw new Error(`Unexpected ${target.option} argv-v2 value analysis: ${JSON.stringify(analysis.value)}`);
            default: {
              const _ex: never = analysis.value;
              throw new Error(`Unhandled ${target.option} argv-v2 value analysis: ${JSON.stringify(_ex)}`);
            }
            }
          })();
          env.set(target.envName, value);
          index += 1;
          continue;
        }
        default: {
          const _ex: never = analysis.semantic;
          throw new Error(`Unhandled Git global argv-v2 semantic: ${_ex}`);
        }
        }
      case 'unknown':
        throw new GitUsageError({ message: `unknown option: ${arg}`, prefix: 'none' });
      case 'ambiguous':
        throw new Error(`Exact Git global argv-v2 analysis returned ambiguity: ${JSON.stringify(analysis)}`);
      default: {
        const _ex: never = analysis;
        throw new Error(`Unhandled Git global argv-v2 analysis: ${JSON.stringify(_ex)}`);
      }
      }
    }
    if (arg === '-c') {
      const assignment = context.args[index + 1];
      if (assignment === undefined) throw new Error("option '-c' requires a value");
      const separator = assignment.indexOf('=');
      const key = separator < 0 ? assignment : assignment.slice(0, separator);
      const value: GitCommandConfigEntry['value'] = separator < 0
        ? { kind: 'implicit-boolean' }
        : { kind: 'explicit', value: assignment.slice(separator + 1) };
      parseConfigKey({ key });
      commandConfigEntries.push({ key, value });
      index += 2;
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
  registerGitCommandConfigEntries({ env, entries: commandConfigEntries });
  return { context: { ...context, cwd, env }, args: context.args.slice(index) };
}

export const TEST_ONLY = {
};
