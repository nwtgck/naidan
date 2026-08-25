import type { WeshCommandContext, WeshCommandResult } from "@/features/wesh/types";
import { joinPath, discoverRepositoryFromContext } from "@/features/wesh/commands/git/repository";
import { readReflog } from "@/features/wesh/commands/git/reflog";

export async function runReflog({ context, args }: {
  context: WeshCommandContext,
  args: readonly string[],
}): Promise<WeshCommandResult> {
  const repository = await discoverRepositoryFromContext({ context });
  let maxCount = Number.POSITIVE_INFINITY;
  const operands: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === '-n' || arg === '--max-count') {
      const value = args[index + 1];
      if (value === undefined || !/^[0-9]+$/u.test(value)) throw new Error(`option '${arg}' requires a numeric value`);
      maxCount = Number.parseInt(value, 10);
      index += 1;
    } else if (/^-[0-9]+$/u.test(arg)) {
      maxCount = Number.parseInt(arg.slice(1), 10);
    } else if (arg.startsWith('-')) {
      throw new Error(`unsupported reflog argument: ${arg}`);
    } else {
      operands.push(arg);
    }
  }
  if (operands[0] === 'show') operands.shift();
  if (operands.length > 1) throw new Error('too many reflog arguments');
  const name = operands[0] ?? 'HEAD';
  const logPath = name === 'HEAD'
    ? joinPath({ base: repository.gitDirPath, child: 'logs/HEAD' })
    : joinPath({
      base: repository.commonDirPath,
      child: name.startsWith('refs/') ? `logs/${name}` : `logs/refs/heads/${name}`,
    });
  const entries = await readReflog({ files: context.files, path: logPath });
  const displayName = name;
  let outputIndex = 0;
  for (let index = entries.length - 1; index >= 0 && outputIndex < maxCount; index -= 1) {
    const entry = entries[index]!;
    await context.text().print({
      text: `${entry.newObjectId.slice(0, 7)} ${displayName}@{${outputIndex}}: ${entry.message}\n`,
    });
    outputIndex += 1;
  }
  return { exitCode: 0 };
}

export const TEST_ONLY = {
};
