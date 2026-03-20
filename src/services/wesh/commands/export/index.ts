import type { WeshCommandDefinition, WeshCommandResult, WeshCommandContext } from '@/services/wesh/types';
import { parseStandardArgv } from '@/services/wesh/argv';

export const exportCmdCommandDefinition: WeshCommandDefinition = {
  meta: {
    name: 'export',
    description: 'Set environment variables',
    usage: 'export [-p] name=value...',
  },
  fn: async ({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> => {
    const parsed = parseStandardArgv({
      args: context.args,
      spec: {
        options: [
          { kind: 'flag', short: 'p', long: undefined, effects: [{ key: 'print', value: true }], help: { summary: 'list exported variables in a reusable format' } },
        ],
        allowShortFlagBundles: true,
        stopAtDoubleDash: true,
        treatSingleDashAsPositional: true,
        specialTokenParsers: [],
      },
    });

    const text = context.text();
    if (parsed.optionValues.print === true) {
      for (const [key, val] of context.env) {
        await text.print({ text: `export ${key}='${val}'\n` });
      }
      return { exitCode: 0 };
    }

    for (const p of parsed.positionals) {
      const idx = p.indexOf('=');
      if (idx !== -1) {
        const key = p.slice(0, idx);
        const value = p.slice(idx + 1);
        context.setEnv({ key, value });
      }
    }

    return { exitCode: 0 };
  },
};
