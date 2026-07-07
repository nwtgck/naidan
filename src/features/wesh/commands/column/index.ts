import { parseStandardArgv } from '@/features/wesh/argv';
import { writeCommandHelp, writeCommandUsageError } from '@/features/wesh/commands/_shared/usage';
import type { WeshCommandContext, WeshCommandDefinition, WeshCommandResult } from '@/features/wesh/types';
import { createBufferedTextWriter } from '@/features/wesh/utils/io';
import { renderList, renderTable } from './format';
import { readCommandInput } from './input';
import { columnArgvSpec, normalizeOptions } from './options';

export const columnCommandDefinition: WeshCommandDefinition = {
  meta: {
    name: 'column',
    description: 'Columnate lists or create aligned tables',
    usage: 'column [OPTION]... [FILE]...',
  },
  fn: async ({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> => {
    const parsed = parseStandardArgv({
      args: context.args,
      spec: columnArgvSpec,
    });

    const diagnostic = parsed.diagnostics[0];
    if (diagnostic !== undefined) {
      await writeCommandUsageError({
        context,
        command: 'column',
        message: `column: ${diagnostic.message}`,
        argvSpec: columnArgvSpec,
      });
      return { exitCode: 1 };
    }

    if (parsed.optionValues.help === true) {
      await writeCommandHelp({
        context,
        command: 'column',
        argvSpec: columnArgvSpec,
      });
      return { exitCode: 0 };
    }

    const optionsResult = normalizeOptions({
      context,
      optionValues: parsed.optionValues,
    });
    if (!optionsResult.ok) {
      await writeCommandUsageError({
        context,
        command: 'column',
        message: optionsResult.message,
        argvSpec: columnArgvSpec,
      });
      return { exitCode: 1 };
    }

    const input = await readCommandInput({
      context,
      operands: parsed.positionals,
    });
    const output = (() => {
      switch (optionsResult.options.renderMode) {
      case 'table':
        return renderTable({ text: input.text, options: optionsResult.options });
      case 'list':
        return renderList({ text: input.text, options: optionsResult.options });
      default: {
        const _ex: never = optionsResult.options.renderMode;
        throw new Error(`Unhandled column render mode: ${_ex}`);
      }
      }
    })();
    const writer = createBufferedTextWriter({
      handle: context.stdout,
      maxBufferLength: 16 * 1024,
    });
    await writer.write({ text: output });
    await writer.flush();

    return { exitCode: input.exitCode };
  },
};

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
