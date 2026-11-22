import type {
  WeshBuiltinCommandContext,
  WeshShellBuiltinContext,
  WeshShellBuiltinFunction,
  WeshCommandResult,
  WeshShellOption,
} from '@/features/wesh/types';
import { defineArgvCatalog, defineArgvHelpPresentation, formatArgvOptionHelp, formatArgvUsageSummary, parseStandardArgv, type StandardArgvAction, type StandardArgvPolicy } from '@/features/wesh/argv';
import { writeCommandHelp, writeCommandUsageError } from '@/features/wesh/commands/_shared/usage-output';
import { SHELL_EXECUTION_OPTION_NAMES, type WeshExecutionOptions } from '@/features/wesh/shell/invocation';

type ShoptOptionName = WeshShellOption | 'expand_aliases';
type ExecutionOptionName = keyof WeshExecutionOptions;
type KnownShellOptionName = ShoptOptionName | ExecutionOptionName;

const KNOWN_SHOPT_OPTIONS: readonly ShoptOptionName[] = ['dotglob', 'expand_aliases', 'extglob', 'failglob', 'globstar', 'nullglob'];

function isExecutionOption(name: KnownShellOptionName): name is ExecutionOptionName {
  return SHELL_EXECUTION_OPTION_NAMES.some(option => name === option);
}

function isSupportedShoptOption(name: ShoptOptionName): name is WeshShellOption {
  return name !== 'expand_aliases';
}

function getShellOptionEnabled({
  shell,
  name,
}: {
  shell: Pick<WeshShellBuiltinContext, 'getExecutionOption' | 'getShellOption'>;
  name: KnownShellOptionName;
}): boolean {
  return isExecutionOption(name)
    ? shell.getExecutionOption({ name })
    : isSupportedShoptOption(name) && shell.getShellOption({ name });
}

const shoptOptions = [
  {
    semantic: { kind: 'effects', effects: [{ key: 'setOptions', value: true }] },
    forms: [{ kind: 'short', name: 'o', value: { kind: 'none' } }],
    summary: 'operate on set -o options',
    category: 'common',
  },
  {
    semantic: { kind: 'effects', effects: [{ key: 'print', value: true }] },
    forms: [{ kind: 'short', name: 'p', value: { kind: 'none' } }],
    summary: 'print shell option settings',
    category: 'common',
  },
  {
    semantic: { kind: 'effects', effects: [{ key: 'query', value: true }] },
    forms: [{ kind: 'short', name: 'q', value: { kind: 'none' } }],
    summary: 'suppress output and use exit status',
    category: 'common',
  },
  {
    semantic: { kind: 'effects', effects: [{ key: 'set', value: true }] },
    forms: [{ kind: 'short', name: 's', value: { kind: 'none' } }],
    summary: 'enable shell options',
    category: 'common',
  },
  {
    semantic: { kind: 'effects', effects: [{ key: 'unset', value: true }] },
    forms: [{ kind: 'short', name: 'u', value: { kind: 'none' } }],
    summary: 'disable shell options',
    category: 'common',
  },
  {
    semantic: { kind: 'effects', effects: [{ key: 'help', value: true }] },
    forms: [{ kind: 'long', name: 'help', value: { kind: 'none' } }],
    summary: 'display this help and exit',
    category: 'common',
  },
] as const;

const shoptArgvCatalog = defineArgvCatalog<StandardArgvAction<never>>({
  definitions: shoptOptions,
  nonExecutableLongOptions: [],
});
const shoptArgvHelp = defineArgvHelpPresentation({ catalog: shoptArgvCatalog, rows: shoptOptions });
const shoptArgvPolicy: StandardArgvPolicy = {
  longNameMatch: 'exact',
  optionBoundary: 'first-positional',
  occurrenceRetention: 'none',
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
  enabled,
  format,
  optionFamily,
}: {
  context: WeshBuiltinCommandContext;
  name: KnownShellOptionName;
  enabled: boolean;
  format: 'human-readable' | 'reusable';
  optionFamily: 'set' | 'shopt';
}): Promise<void> {
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
  context: WeshBuiltinCommandContext;
  name: string;
}): Promise<void> {
  await context.text().error({
    text: `shopt: ${name}: invalid shell option name\n`,
  });
}

export const shoptCommandImplementation = {
  fn: async ({ context, shell }): Promise<WeshCommandResult> => {
    const { setExecutionOption, setShellOption } = shell;
    const parsed = parseStandardArgv({
      args: context.args,
      catalog: shoptArgvCatalog,
      policy: shoptArgvPolicy,
    });

    const diagnostic = parsed.diagnostics[0];
    if (diagnostic !== undefined) {
      await writeCommandUsageError({
        context,
        command: 'shopt',
        message: `shopt: ${diagnostic.message}`,
        usageSummary: formatArgvUsageSummary({ presentation: shoptArgvHelp }),
      });
      return { exitCode: 2 };
    }

    if (parsed.optionValues.help === true) {
      await writeCommandHelp({
        context,
        command: 'shopt',
        optionLines: formatArgvOptionHelp({ presentation: shoptArgvHelp }),
      });
      return { exitCode: 0 };
    }

    const optionFamily: 'set' | 'shopt' = parsed.optionValues.setOptions === true ? 'set' : 'shopt';
    const knownOptions = (() => {
      switch (optionFamily) {
      case 'set':
        return SHELL_EXECUTION_OPTION_NAMES;
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
        ? knownOptions.filter((name) => getShellOptionEnabled({ shell, name }))
        : shouldUnset
          ? knownOptions.filter((name) => !getShellOptionEnabled({ shell, name }))
          : knownOptions;
      for (const name of names) {
        await writeShellOption({
          context,
          name,
          enabled: getShellOptionEnabled({ shell, name }),
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
        if (isExecutionOption(knownName)) {
          setExecutionOption({ name: knownName, enabled: shouldSet });
          continue;
        }
        if (!isSupportedShoptOption(knownName)) {
          hadInvalidName = true;
          await context.text().error({
            text: `shopt: ${knownName}: operation requires Wesh core shell-option support\n`,
          });
          continue;
        }
        setShellOption({ name: knownName, enabled: shouldSet });
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
        if (!getShellOptionEnabled({ shell, name: knownName })) {
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
      const enabled = getShellOptionEnabled({ shell, name: knownName });
      await writeShellOption({
        context,
        name: knownName,
        enabled,
        format: reusableOutput ? 'reusable' : 'human-readable',
        optionFamily,
      });
      if (!enabled) {
        failed = true;
      }
    }
    return { exitCode: failed ? 1 : 0 };
  },
} satisfies { readonly fn: WeshShellBuiltinFunction<'getExecutionOption' | 'setExecutionOption' | 'getShellOption' | 'setShellOption'> };

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
