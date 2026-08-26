import { normalizePath } from "@/features/wesh/path";
import type { WeshCommandContext } from "@/features/wesh/types";
import { COMMAND_CONFIG_IMPLICIT_BOOLEAN_SENTINEL, parseConfigKey } from "./config";

export async function parseGitInvocation({ context }: { context: WeshCommandContext }): Promise<{
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
      const value = separator < 0
        ? COMMAND_CONFIG_IMPLICIT_BOOLEAN_SENTINEL
        : assignment.slice(separator + 1);
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
      env.set('GIT_DIR', path);
      index += arg === '--git-dir' ? 2 : 1;
      continue;
    }
    if (arg === '--work-tree' || arg.startsWith('--work-tree=')) {
      const path = arg === '--work-tree' ? context.args[index + 1] : arg.slice('--work-tree='.length);
      if (path === undefined || path.length === 0) throw new Error("option '--work-tree' requires a value");
      env.set('GIT_WORK_TREE', path);
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

export const TEST_ONLY = {
};
