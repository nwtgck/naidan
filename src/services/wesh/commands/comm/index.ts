import { parseStandardArgv, type StandardArgvParserSpec } from '@/services/wesh/argv';
import { writeCommandHelp, writeCommandUsageError } from '@/services/wesh/commands/_shared/usage';
import { readTextFromFile, readTextFromHandle, splitTextLines } from '@/services/wesh/commands/_shared/text';
import type { WeshCommandContext, WeshCommandDefinition, WeshCommandResult } from '@/services/wesh/types';
import { resolvePath } from '@/services/wesh/path';

function compareLines({
  left,
  right,
}: {
  left: string;
  right: string;
}): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

function columnPrefix({
  column,
  suppress1,
  suppress2,
  suppress3,
}: {
  column: 1 | 2 | 3;
  suppress1: boolean;
  suppress2: boolean;
  suppress3: boolean;
}): string {
  const visibleBefore = [
    !suppress1,
    !suppress2,
    !suppress3,
  ].slice(0, column - 1).filter(Boolean).length;
  return '\t'.repeat(visibleBefore);
}

async function readSourceLines({
  context,
  path,
  stdinText,
}: {
  context: WeshCommandContext;
  path: string;
  stdinText: string | undefined;
}): Promise<string[]> {
  if (path === '-') {
    const text = stdinText ?? await readTextFromHandle({ handle: context.stdin });
    return splitTextLines({ text });
  }

  const fullPath = resolvePath({ cwd: context.cwd, path });
  const text = await readTextFromFile({ files: context.files, path: fullPath });
  return splitTextLines({ text });
}

const commArgvSpec: StandardArgvParserSpec = {
  options: [
    { kind: 'flag', short: '1', long: undefined, effects: [{ key: 'suppress1', value: true }], help: { summary: 'suppress column 1', category: 'common' } },
    { kind: 'flag', short: '2', long: undefined, effects: [{ key: 'suppress2', value: true }], help: { summary: 'suppress column 2', category: 'common' } },
    { kind: 'flag', short: '3', long: undefined, effects: [{ key: 'suppress3', value: true }], help: { summary: 'suppress column 3', category: 'common' } },
    { kind: 'flag', short: undefined, long: 'help', effects: [{ key: 'help', value: true }], help: { summary: 'display this help and exit', category: 'common' } },
  ],
  allowShortFlagBundles: true,
  stopAtDoubleDash: true,
  treatSingleDashAsPositional: true,
  specialTokenParsers: [],
};

export const commCommandDefinition: WeshCommandDefinition = {
  meta: {
    name: 'comm',
    description: 'Compare two sorted files line by line',
    usage: 'comm [OPTION]... FILE1 FILE2',
  },
  fn: async ({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> => {
    const parsed = parseStandardArgv({
      args: context.args,
      spec: commArgvSpec,
    });

    const diagnostic = parsed.diagnostics[0];
    if (diagnostic !== undefined) {
      await writeCommandUsageError({
        context,
        command: 'comm',
        message: `comm: ${diagnostic.message}`,
        argvSpec: commArgvSpec,
      });
      return { exitCode: 1 };
    }

    if (parsed.optionValues.help === true) {
      await writeCommandHelp({
        context,
        command: 'comm',
        argvSpec: commArgvSpec,
      });
      return { exitCode: 0 };
    }

    if (parsed.positionals.length < 2) {
      await writeCommandUsageError({
        context,
        command: 'comm',
        message: 'comm: missing operand',
        argvSpec: commArgvSpec,
      });
      return { exitCode: 1 };
    }

    if (parsed.positionals.length > 2) {
      await writeCommandUsageError({
        context,
        command: 'comm',
        message: `comm: extra operand '${parsed.positionals[2] ?? ''}'`,
        argvSpec: commArgvSpec,
      });
      return { exitCode: 1 };
    }

    if (parsed.positionals[0] === '-' && parsed.positionals[1] === '-') {
      await context.text().error({ text: 'comm: -: Bad file descriptor\n' });
      return { exitCode: 1 };
    }

    const suppress1 = parsed.optionValues.suppress1 === true;
    const suppress2 = parsed.optionValues.suppress2 === true;
    const suppress3 = parsed.optionValues.suppress3 === true;
    const [leftPath, rightPath] = parsed.positionals;
    let stdinText: string | undefined;

    try {
      const leftLines = await readSourceLines({
        context,
        path: leftPath!,
        stdinText,
      });
      if (leftPath === '-') {
        stdinText ??= leftLines.join('\n');
      }

      const rightLines = await readSourceLines({
        context,
        path: rightPath!,
        stdinText,
      });

      const output: string[] = [];
      let leftIndex = 0;
      let rightIndex = 0;

      while (leftIndex < leftLines.length || rightIndex < rightLines.length) {
        const left = leftLines[leftIndex];
        const right = rightLines[rightIndex];

        if (left !== undefined && right !== undefined) {
          const compared = compareLines({ left, right });
          if (compared === 0) {
            if (!suppress3) {
              output.push(`${columnPrefix({ column: 3, suppress1, suppress2, suppress3 })}${left}`);
            }
            leftIndex += 1;
            rightIndex += 1;
            continue;
          }

          if (compared < 0) {
            if (!suppress1) {
              output.push(`${columnPrefix({ column: 1, suppress1, suppress2, suppress3 })}${left}`);
            }
            leftIndex += 1;
            continue;
          }

          if (!suppress2) {
            output.push(`${columnPrefix({ column: 2, suppress1, suppress2, suppress3 })}${right}`);
          }
          rightIndex += 1;
          continue;
        }

        if (left !== undefined) {
          if (!suppress1) {
            output.push(`${columnPrefix({ column: 1, suppress1, suppress2, suppress3 })}${left}`);
          }
          leftIndex += 1;
          continue;
        }

        if (right !== undefined) {
          if (!suppress2) {
            output.push(`${columnPrefix({ column: 2, suppress1, suppress2, suppress3 })}${right}`);
          }
          rightIndex += 1;
        }
      }

      await context.text().print({
        text: output.map((line) => `${line}\n`).join(''),
      });
      return { exitCode: 0 };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      const failingPath = parsed.positionals[0] ?? parsed.positionals[1] ?? '';
      await context.text().error({ text: `comm: ${failingPath}: ${message}\n` });
      return { exitCode: 1 };
    }
  },
};
