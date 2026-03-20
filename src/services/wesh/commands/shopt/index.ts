import type {
  WeshCommandContext,
  WeshCommandDefinition,
  WeshCommandResult,
  WeshShellOption,
} from '@/services/wesh/types';
import { parseStandardArgv, type StandardArgvParserSpec } from '@/services/wesh/argv';
import { writeCommandHelp, writeCommandUsageError } from '@/services/wesh/commands/_shared/usage';

const KNOWN_SHELL_OPTIONS: WeshShellOption[] = ['dotglob', 'extglob', 'failglob', 'globstar', 'nullglob'];

const shoptArgvSpec: StandardArgvParserSpec = {
  options: [
    { kind: 'flag', short: 'p', long: undefined, effects: [{ key: 'print', value: true }], help: { summary: 'print shell option settings', category: 'common' } },
    { kind: 'flag', short: 'q', long: undefined, effects: [{ key: 'query', value: true }], help: { summary: 'suppress output and use exit status', category: 'common' } },
    { kind: 'flag', short: 's', long: undefined, effects: [{ key: 'set', value: true }], help: { summary: 'enable shell options', category: 'common' } },
    { kind: 'flag', short: 'u', long: undefined, effects: [{ key: 'unset', value: true }], help: { summary: 'disable shell options', category: 'common' } },
    { kind: 'flag', short: undefined, long: 'help', effects: [{ key: 'help', value: true }], help: { summary: 'display this help and exit', category: 'common' } },
  ],
  allowShortFlagBundles: true,
  stopAtDoubleDash: true,
  treatSingleDashAsPositional: true,
  specialTokenParsers: [],
};

function isKnownShellOption(name: string): name is WeshShellOption {
  return KNOWN_SHELL_OPTIONS.includes(name as WeshShellOption);
}

function getShoptMode({
  parsed,
}: {
  parsed: ReturnType<typeof parseStandardArgv>;
}): 'print' | 'query' | 'set' | 'unset' | undefined {
  const modes = [
    parsed.optionValues.print === true ? 'print' : undefined,
    parsed.optionValues.query === true ? 'query' : undefined,
    parsed.optionValues.set === true ? 'set' : undefined,
    parsed.optionValues.unset === true ? 'unset' : undefined,
  ].filter((mode): mode is 'print' | 'query' | 'set' | 'unset' => mode !== undefined);

  if (modes.length <= 1) {
    return modes[0] ?? 'print';
  }

  return undefined;
}

export const shoptCommandDefinition: WeshCommandDefinition = {
  meta: {
    name: 'shopt',
    description: 'Set and unset shell options',
    usage: 'shopt [-pqsu] [optname ...]',
  },
  fn: async ({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> => {
    const parsed = parseStandardArgv({
      args: context.args,
      spec: shoptArgvSpec,
    });

    const diagnostic = parsed.diagnostics[0];
    if (diagnostic !== undefined) {
      await writeCommandUsageError({
        context,
        command: 'shopt',
        message: `shopt: ${diagnostic.message}`,
        argvSpec: shoptArgvSpec,
      });
      return { exitCode: 1 };
    }

    if (parsed.optionValues.help === true) {
      await writeCommandHelp({
        context,
        command: 'shopt',
        argvSpec: shoptArgvSpec,
      });
      return { exitCode: 0 };
    }

    const mode = getShoptMode({ parsed });
    if (mode === undefined) {
      await writeCommandUsageError({
        context,
        command: 'shopt',
        message: 'shopt: options -p, -q, -s, and -u are mutually exclusive',
        argvSpec: shoptArgvSpec,
      });
      return { exitCode: 1 };
    }

    const targetNames = parsed.positionals.length > 0
      ? parsed.positionals
      : KNOWN_SHELL_OPTIONS;

    for (const name of targetNames) {
      if (!isKnownShellOption(name)) {
        await context.text().error({
          text: `shopt: ${name}: invalid shell option name\n`,
        });
        return { exitCode: 1 };
      }
    }

    const validatedTargetNames = targetNames.filter(isKnownShellOption);

    switch (mode) {
    case 'set':
      for (const name of validatedTargetNames) {
        context.setShellOption({ name, enabled: true });
      }
      return { exitCode: 0 };
    case 'unset':
      for (const name of validatedTargetNames) {
        context.setShellOption({ name, enabled: false });
      }
      return { exitCode: 0 };
    case 'query':
      for (const name of validatedTargetNames) {
        if (!context.getShellOption({ name })) {
          return { exitCode: 1 };
        }
      }
      return { exitCode: 0 };
    case 'print':
      for (const name of validatedTargetNames) {
        await context.text().print({
          text: `shopt -${context.getShellOption({ name }) ? 's' : 'u'} ${name}\n`,
        });
      }
      return { exitCode: 0 };
    default: {
      const _ex: never = mode;
      throw new Error(`Unhandled shopt mode: ${_ex}`);
    }
    }
  },
};
