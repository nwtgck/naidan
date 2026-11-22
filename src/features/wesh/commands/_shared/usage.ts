import type { StandardArgvParserSpec } from '@/features/wesh/argv';
import { formatArgvOptionHelp, formatArgvUsageSummary } from '@/features/wesh/argv';
import {
  writeCommandHelp as writeHelp,
  writeCommandUsageError as writeUsageError,
  type WeshCommandUsageContext,
} from './usage-output';

export async function writeCommandUsageError({
  context,
  command,
  message,
  argvSpec,
}: {
  context: WeshCommandUsageContext,
  command: string,
  message: string,
  argvSpec?: StandardArgvParserSpec,
}): Promise<void> {
  await writeUsageError({
    context,
    command,
    message,
    usageSummary: argvSpec === undefined ? undefined : formatArgvUsageSummary({ spec: argvSpec }),
  });
}

export async function writeCommandHelp({
  context,
  command,
  argvSpec,
}: {
  context: WeshCommandUsageContext,
  command: string,
  argvSpec?: StandardArgvParserSpec,
}): Promise<void> {
  await writeHelp({
    context,
    command,
    optionLines: argvSpec === undefined ? [] : formatArgvOptionHelp({ spec: argvSpec }),
  });
}

export async function maybeWriteStandaloneCommandHelp({
  context,
  command,
  argvSpec,
  mode,
}: {
  context: WeshCommandUsageContext,
  command: string,
  argvSpec?: StandardArgvParserSpec,
  mode: 'help-requested' | 'not-requested',
}): Promise<'handled' | 'not-handled'> {
  switch (mode) {
  case 'help-requested':
    await writeCommandHelp({
      context,
      command,
      argvSpec,
    });
    return 'handled';
  case 'not-requested':
    return 'not-handled';
  default: {
    const _ex: never = mode;
    throw new Error(`Unhandled help mode: ${_ex}`);
  }
  }
}

export { isStandaloneCommandHelpRequest } from './usage-output';

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
