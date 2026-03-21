import type { StandardArgvParserSpec } from '@/services/wesh/argv';
import { formatArgvOptionHelp, formatArgvUsageSummary } from '@/services/wesh/argv';
import type { WeshCommandContext } from '@/services/wesh/types';

export async function writeCommandUsageError({
  context,
  command,
  message,
  argvSpec,
}: {
  context: WeshCommandContext;
  command: string;
  message: string;
  argvSpec?: StandardArgvParserSpec;
}): Promise<void> {
  const meta = context.getWeshCommandMeta({ name: command });
  const usageLine = meta === undefined ? undefined : `usage: ${meta.usage}`;
  const summaryLine = argvSpec === undefined ? undefined : formatArgvUsageSummary({ spec: argvSpec });
  const text = [message, usageLine, summaryLine].filter((line) => line !== undefined).join('\n') + '\n';
  await context.text().error({ text });
}

export async function writeCommandHelp({
  context,
  command,
  argvSpec,
}: {
  context: WeshCommandContext;
  command: string;
  argvSpec?: StandardArgvParserSpec;
}): Promise<void> {
  const meta = context.getWeshCommandMeta({ name: command });
  const usageLine = meta === undefined ? undefined : `usage: ${meta.usage}`;
  const descriptionLine = meta?.description;
  const optionLines = argvSpec === undefined ? [] : formatArgvOptionHelp({ spec: argvSpec });
  const text = [
    descriptionLine,
    usageLine,
    optionLines.length > 0 ? 'options:' : undefined,
    ...optionLines,
  ].filter((line) => line !== undefined).join('\n') + '\n';
  await context.text().print({ text });
}

export async function maybeWriteStandaloneCommandHelp({
  context,
  command,
  argvSpec,
  mode,
}: {
  context: WeshCommandContext;
  command: string;
  argvSpec?: StandardArgvParserSpec;
  mode: 'help-requested' | 'not-requested';
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

export function isStandaloneCommandHelpRequest({
  args,
  acceptedForms,
}: {
  args: string[];
  acceptedForms: string[][];
}): boolean {
  return acceptedForms.some((acceptedForm) => {
    if (args.length !== acceptedForm.length) {
      return false;
    }

    return acceptedForm.every((token, index) => args[index] === token);
  });
}
