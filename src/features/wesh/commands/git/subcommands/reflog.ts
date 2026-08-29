import type { WeshCommandContext, WeshCommandResult } from "@/features/wesh/types";
import { joinPath, discoverRepositoryFromContext } from "@/features/wesh/commands/git/repository";
import { readReflog } from "@/features/wesh/commands/git/reflog";
import { expandGitShortOptions } from "@/features/wesh/commands/git/short-options";
import { parseGitMaxCount } from "@/features/wesh/commands/git/max-count";
import { resolveRevision } from "@/features/wesh/commands/git/revision";
import { readHead, readRef } from "@/features/wesh/commands/git/refs";
import { readEffectiveConfig } from "@/features/wesh/commands/git/config";


interface ReflogSelection {
  readonly name: string,
  readonly startIndex: number,
}

function parseNumericReflogSelection({ name }: { name: string }): ReflogSelection | undefined {
  const match = /^(.*)@\{([0-9]+)\}$/u.exec(name);
  if (match === null) return undefined;
  return {
    name: match[1]!,
    startIndex: Number.parseInt(match[2]!, 10),
  };
}

export async function runReflog({ context, args }: {
  context: WeshCommandContext,
  args: readonly string[],
}): Promise<WeshCommandResult> {
  const repository = await discoverRepositoryFromContext({ context });
  await readEffectiveConfig({
    files: context.files,
    repository,
    homePath: context.env.get('HOME') ?? '/',
    cwd: context.cwd,
    env: context.env,
  });
  let maxCount = Number.POSITIVE_INFINITY;
  let optionTerminated = false;
  const operands: string[] = [];
  const normalizedArgs = expandGitShortOptions({ args, flagOptions: [], valueOptions: ['n'] });
  for (let index = 0; index < normalizedArgs.length; index += 1) {
    const arg = normalizedArgs[index]!;
    if (optionTerminated)
      throw new Error('reflog pathspecs are not supported yet');
    if (arg === '--') {
      optionTerminated = true;
    } else if (arg === '-n' || arg === '--max-count') {
      const value = normalizedArgs[index + 1];
      if (value === undefined) throw new Error(`option '${arg}' requires a numeric value`);
      maxCount = parseGitMaxCount({ value, option: arg });
      index += 1;
    } else if (arg.startsWith('--max-count=')) {
      const value = arg.slice('--max-count='.length);
      maxCount = parseGitMaxCount({ value, option: '--max-count' });
    } else if (/^-[0-9]+$/u.test(arg)) {
      maxCount = parseGitMaxCount({ value: arg.slice(1), option: '-n' });
    } else if (arg.startsWith('-')) {
      throw new Error(`unsupported reflog argument: ${arg}`);
    } else {
      operands.push(arg);
    }
  }
  if (operands[0] === 'show') operands.shift();
  if (operands.length > 1) throw new Error('too many reflog arguments');
  const requestedName = operands[0] ?? 'HEAD';
  const selection = parseNumericReflogSelection({ name: requestedName });
  const startIndex = selection?.startIndex ?? 0;
  let name = selection?.name ?? requestedName;
  let displayName = name;
  if (selection !== undefined && name.length === 0) {
    const head = await readHead({ files: context.files, repository });
    if (head.symbolicRef === undefined) name = 'HEAD';
    else {
      name = head.symbolicRef;
      displayName = head.symbolicRef;
    }
  }
  await resolveRevision({ files: context.files, repository, expression: name });
  let logPath: string;
  if (name === 'HEAD') {
    logPath = joinPath({ base: repository.gitDirPath, child: 'logs/HEAD' });
  } else if (name.startsWith('refs/')) {
    logPath = joinPath({ base: repository.commonDirPath, child: `logs/${name}` });
  } else {
    const headRefName = `refs/heads/${name}`;
    const remoteRefName = `refs/remotes/${name}`;
    const remoteHeadRefName = `refs/remotes/${name}/HEAD`;
    const refName = await readRef({ files: context.files, repository, refName: headRefName }) !== undefined
      ? headRefName
      : await readRef({ files: context.files, repository, refName: remoteRefName }) !== undefined
        ? remoteRefName
        : await readRef({ files: context.files, repository, refName: remoteHeadRefName }) !== undefined
          ? remoteHeadRefName
          : `refs/tags/${name}`;
    logPath = joinPath({ base: repository.commonDirPath, child: `logs/${refName}` });
    if (refName.startsWith('refs/remotes/')) displayName = refName;
  }
  const entries = await readReflog({ files: context.files, path: logPath });
  if (selection !== undefined && startIndex >= entries.length)
    throw new Error(`log for '${displayName}' only has ${entries.length} entries`);
  let outputCount = 0;
  for (let reflogIndex = startIndex; reflogIndex < entries.length && outputCount < maxCount; reflogIndex += 1) {
    const entry = entries[entries.length - 1 - reflogIndex]!;
    await context.text().print({
      text: `${entry.newObjectId.slice(0, 7)} ${displayName}@{${reflogIndex}}: ${entry.message}\n`,
    });
    outputCount += 1;
  }
  return { exitCode: 0 };
}

export const TEST_ONLY = {
  parseNumericReflogSelection,
};
