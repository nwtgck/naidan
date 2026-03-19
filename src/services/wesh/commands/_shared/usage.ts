import type { WeshCommandContext } from '@/services/wesh/types';

export async function writeCommandUsageError({
  context,
  command,
  message,
}: {
  context: WeshCommandContext;
  command: string;
  message: string;
}): Promise<void> {
  const meta = context.getWeshCommandMeta({ name: command });
  const usageLine = meta === undefined ? undefined : `usage: ${meta.usage}`;
  const text = usageLine === undefined ? `${message}\n` : `${message}\n${usageLine}\n`;
  await context.text().error({ text });
}
