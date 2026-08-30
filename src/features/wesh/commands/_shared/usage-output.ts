import type { WeshCommandContext } from '@/features/wesh/types';

export async function writeCommandUsageError({
  context,
  command,
  message,
  usageSummary,
}: {
  context: WeshCommandContext,
  command: string,
  message: string,
  usageSummary: string | undefined,
}): Promise<void> {
  const meta = context.getWeshCommandMeta({ name: command });
  const usageLine = meta === undefined ? undefined : `usage: ${meta.usage}`;
  const text = [message, usageLine, usageSummary].filter((line) => line !== undefined).join('\n') + '\n';
  await context.text().error({ text });
}

export async function writeCommandHelp({
  context,
  command,
  optionLines,
}: {
  context: WeshCommandContext,
  command: string,
  optionLines: readonly string[],
}): Promise<void> {
  const meta = context.getWeshCommandMeta({ name: command });
  const usageLine = meta === undefined ? undefined : `usage: ${meta.usage}`;
  const descriptionLine = meta?.description;
  const text = [
    descriptionLine,
    usageLine,
    optionLines.length > 0 ? 'options:' : undefined,
    ...optionLines,
  ].filter((line) => line !== undefined).join('\n') + '\n';
  await context.text().print({ text });
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
