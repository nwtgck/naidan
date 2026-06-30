import { parseStandardArgv, type StandardArgvParserSpec } from '@/features/wesh/argv';
import { openTextLineIterator } from '@/features/wesh/commands/_shared/text';
import { writeCommandHelp, writeCommandUsageError } from '@/features/wesh/commands/_shared/usage';
import type { WeshCommandContext, WeshCommandDefinition, WeshCommandResult } from '@/features/wesh/types';
import { createBufferedTextWriter } from '@/features/wesh/utils/io';

function compareLines({
  left,
  right,
}: {
  left: string,
  right: string,
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
  column: 1 | 2 | 3,
  suppress1: boolean,
  suppress2: boolean,
  suppress3: boolean,
}): string {
  const visibleBefore = [
    !suppress1,
    !suppress2,
    !suppress3,
  ].slice(0, column - 1).filter(Boolean).length;
  return '\t'.repeat(visibleBefore);
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

    const leftPath = parsed.positionals[0]!;
    const rightPath = parsed.positionals[1]!;
    if (leftPath === '-' && rightPath === '-') {
      await context.text().error({ text: 'comm: -: Bad file descriptor\n' });
      return { exitCode: 1 };
    }

    const suppress1 = parsed.optionValues.suppress1 === true;
    const suppress2 = parsed.optionValues.suppress2 === true;
    const suppress3 = parsed.optionValues.suppress3 === true;
    let leftIterator: AsyncIterator<string> | undefined;
    let rightIterator: AsyncIterator<string> | undefined;
    const writer = createBufferedTextWriter({
      handle: context.stdout,
      maxBufferLength: 16 * 1024,
    });

    try {
      leftIterator = await openTextLineIterator({ context, path: leftPath });
      rightIterator = await openTextLineIterator({ context, path: rightPath });
      let left = await leftIterator.next();
      let right = await rightIterator.next();

      while (!left.done || !right.done) {
        if (!left.done && !right.done) {
          const compared = compareLines({ left: left.value, right: right.value });
          if (compared === 0) {
            if (!suppress3) {
              await writer.write({
                text: `${columnPrefix({ column: 3, suppress1, suppress2, suppress3 })}${left.value}\n`,
              });
            }
            left = await leftIterator.next();
            right = await rightIterator.next();
            continue;
          }

          if (compared < 0) {
            if (!suppress1) {
              await writer.write({
                text: `${columnPrefix({ column: 1, suppress1, suppress2, suppress3 })}${left.value}\n`,
              });
            }
            left = await leftIterator.next();
            continue;
          }

          if (!suppress2) {
            await writer.write({
              text: `${columnPrefix({ column: 2, suppress1, suppress2, suppress3 })}${right.value}\n`,
            });
          }
          right = await rightIterator.next();
          continue;
        }

        if (!left.done) {
          if (!suppress1) {
            await writer.write({
              text: `${columnPrefix({ column: 1, suppress1, suppress2, suppress3 })}${left.value}\n`,
            });
          }
          left = await leftIterator.next();
          continue;
        }

        if (!right.done) {
          if (!suppress2) {
            await writer.write({
              text: `${columnPrefix({ column: 2, suppress1, suppress2, suppress3 })}${right.value}\n`,
            });
          }
          right = await rightIterator.next();
        }
      }
      return { exitCode: 0 };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      await context.text().error({ text: `comm: ${leftPath}: ${message}\n` });
      return { exitCode: 1 };
    } finally {
      await writer.flush();
      await leftIterator?.return?.();
      await rightIterator?.return?.();
    }
  },
};

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {};
