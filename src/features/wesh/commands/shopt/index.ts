import { stopStandardOptionParsingAtFirstPositional } from '@/features/wesh/commands/_shared/argv';
import type {
  WeshCommandContext,
  WeshCommandDefinition,
  WeshCommandResult,
  WeshShellOption,
} from '@/features/wesh/types';
import { parseStandardArgv, type StandardArgvParserSpec } from '@/features/wesh/argv';
import { writeCommandHelp, writeCommandUsageError } from '@/features/wesh/commands/_shared/usage';

type KnownShellOptionName = WeshShellOption | 'expand_aliases' | 'pipefail';

const KNOWN_SHOPT_OPTIONS: readonly KnownShellOptionName[] = ['dotglob', 'expand_aliases', 'extglob', 'failglob', 'globstar', 'nullglob'];
const KNOWN_SET_OPTIONS: readonly KnownShellOptionName[] = ['pipefail'];

function isCoreShellOption(name: KnownShellOptionName): name is WeshShellOption {
  return name !== 'expand_aliases' && name !== 'pipefail';
}

function getShellOptionEnabled({
  context,
  name,
}: {
  context: WeshCommandContext;
  name: KnownShellOptionName;
}): boolean {
  return isCoreShellOption(name) && context.getShellOption({ name });
}

const shoptArgvSpec: StandardArgvParserSpec = {
  options: [
    { kind: 'flag', short: 'o', long: undefined, effects: [{ key: 'setOptions', value: true }], help: { summary: 'operate on set -o options', category: 'common' } },
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

function resolveKnownShellOption({
  name,
  knownOptions,
}: {
  name: string;
  knownOptions: readonly KnownShellOptionName[];
}): KnownShellOptionName | undefined {
  return knownOptions.find(knownOption => knownOption === name);
}

async function writeShellOption({
  context,
  name,
  format,
  optionFamily,
}: {
  context: WeshCommandContext;
  name: KnownShellOptionName;
  format: 'human-readable' | 'reusable';
  optionFamily: 'set' | 'shopt';
}): Promise<void> {
  const enabled = getShellOptionEnabled({ context, name });
  switch (format) {
  case 'human-readable':
    await context.text().print({
      text: `${name.padEnd(15)}\t${enabled ? 'on' : 'off'}\n`,
    });
    return;
  case 'reusable': {
    let text: string;
    switch (optionFamily) {
    case 'set':
      text = `set ${enabled ? '-' : '+'}o ${name}\n`;
      break;
    case 'shopt':
      text = `shopt -${enabled ? 's' : 'u'} ${name}\n`;
      break;
    default: {
      const _ex: never = optionFamily;
      throw new Error(`Unhandled shopt option family: ${_ex}`);
    }
    }
    await context.text().print({ text });
    return;
  }
  default: {
    const _ex: never = format;
    throw new Error(`Unhandled shopt output format: ${_ex}`);
  }
  }
}

async function writeInvalidOptionName({
  context,
  name,
}: {
  context: WeshCommandContext;
  name: string;
}): Promise<void> {
  await context.text().error({
    text: `shopt: ${name}: invalid shell option name\n`,
  });
}

export const shoptCommandDefinition: WeshCommandDefinition = {
  meta: {
    name: 'shopt',
    description: 'Set and unset shell options',
    usage: 'shopt [-opqsu] [optname ...]',
  },
  fn: async ({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> => {
    const parsed = parseStandardArgv({
      args: stopStandardOptionParsingAtFirstPositional({ args: context.args, spec: shoptArgvSpec }),
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
      return { exitCode: 2 };
    }

    if (parsed.optionValues.help === true) {
      await writeCommandHelp({
        context,
        command: 'shopt',
        argvSpec: shoptArgvSpec,
      });
      return { exitCode: 0 };
    }

    const optionFamily: 'set' | 'shopt' = parsed.optionValues.setOptions === true ? 'set' : 'shopt';
    const knownOptions = (() => {
      switch (optionFamily) {
      case 'set':
        return KNOWN_SET_OPTIONS;
      case 'shopt':
        return KNOWN_SHOPT_OPTIONS;
      default: {
        const _ex: never = optionFamily;
        throw new Error(`Unhandled shopt option family: ${_ex}`);
      }
      }
    })();
    const shouldSet = parsed.optionValues.set === true;
    const shouldUnset = parsed.optionValues.unset === true;
    const shouldQuery = parsed.optionValues.query === true;
    const reusableOutput = parsed.optionValues.print === true;

    if (shouldSet && shouldUnset) {
      await context.text().error({
        text: 'shopt: cannot set and unset shell options simultaneously\n',
      });
      return { exitCode: 1 };
    }

    if (parsed.positionals.length === 0) {
      if (shouldQuery) {
        return { exitCode: 0 };
      }

      const names = shouldSet
        ? knownOptions.filter((name) => getShellOptionEnabled({ context, name }))
        : shouldUnset
          ? knownOptions.filter((name) => !getShellOptionEnabled({ context, name }))
          : knownOptions;
      for (const name of names) {
        await writeShellOption({
          context,
          name,
          format: reusableOutput ? 'reusable' : 'human-readable',
          optionFamily,
        });
      }
      return { exitCode: 0 };
    }

    if (shouldSet || shouldUnset) {
      let hadInvalidName = false;
      for (const name of parsed.positionals) {
        const knownName = resolveKnownShellOption({ name, knownOptions });
        if (knownName === undefined) {
          hadInvalidName = true;
          await writeInvalidOptionName({ context, name });
          continue;
        }
        if (!isCoreShellOption(knownName)) {
          hadInvalidName = true;
          await context.text().error({
            text: `shopt: ${knownName}: operation requires Wesh core shell-option support\n`,
          });
          continue;
        }
        context.setShellOption({ name: knownName, enabled: shouldSet });
      }
      let invalidNameExitCode = 0;
      switch (optionFamily) {
      case 'set':
        break;
      case 'shopt':
        invalidNameExitCode = hadInvalidName ? 1 : 0;
        break;
      default: {
        const _ex: never = optionFamily;
        throw new Error(`Unhandled shopt option family: ${_ex}`);
      }
      }
      return { exitCode: invalidNameExitCode };
    }

    if (shouldQuery) {
      let failed = false;
      for (const name of parsed.positionals) {
        const knownName = resolveKnownShellOption({ name, knownOptions });
        if (knownName === undefined) {
          failed = true;
          await writeInvalidOptionName({ context, name });
          continue;
        }
        if (!getShellOptionEnabled({ context, name: knownName })) {
          failed = true;
        }
      }
      return { exitCode: failed ? 1 : 0 };
    }

    let failed = false;
    for (const name of parsed.positionals) {
      const knownName = resolveKnownShellOption({ name, knownOptions });
      if (knownName === undefined) {
        failed = true;
        await writeInvalidOptionName({ context, name });
        continue;
      }
      await writeShellOption({
        context,
        name: knownName,
        format: reusableOutput ? 'reusable' : 'human-readable',
        optionFamily,
      });
      if (!getShellOptionEnabled({ context, name: knownName })) {
        failed = true;
      }
    }
    return { exitCode: failed ? 1 : 0 };
  },
};

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
