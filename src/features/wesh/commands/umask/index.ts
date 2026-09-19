import { DEFAULT_FILE_CREATION_MASK, getOptionalCoreMethod } from '@/features/wesh/commands/_shared/core-capability';
import { parseFilePermissionMode } from '@/features/wesh/commands/_shared/file-mode';
import { isStandaloneCommandHelpRequest, writeCommandHelp } from '@/features/wesh/commands/_shared/usage';
import type {
  WeshCommandContext,
  WeshCommandImplementation,
  WeshCommandResult,
} from '@/features/wesh/types';

function formatOctalMask({ mask }: { mask: number }): string {
  return mask.toString(8).padStart(4, '0');
}

function formatAllowedTriplet({ permissions }: { permissions: number }): string {
  return `${(permissions & 0o4) === 0 ? '' : 'r'}${(permissions & 0o2) === 0 ? '' : 'w'}${(permissions & 0o1) === 0 ? '' : 'x'}`;
}

function formatSymbolicMask({ mask }: { mask: number }): string {
  const allowed = (~mask) & 0o777;
  return [
    `u=${formatAllowedTriplet({ permissions: (allowed >> 6) & 0o7 })}`,
    `g=${formatAllowedTriplet({ permissions: (allowed >> 3) & 0o7 })}`,
    `o=${formatAllowedTriplet({ permissions: allowed & 0o7 })}`,
  ].join(',');
}

function isUmaskSymbolicMode({ value }: { value: string }): boolean {
  if (value.length === 0) return false;
  return value.split(',').every(clause => /^([ugoa]*)([+=-])([rwx]*)$/u.test(clause));
}

type ParsedUmaskArguments =
  | {
    readonly ok: true,
    readonly portable: boolean,
    readonly symbolic: boolean,
    readonly modeOperand: string | undefined,
  }
  | {
    readonly ok: false,
    readonly invalidOption: string,
  };

function parseUmaskArguments({
  args,
}: {
  args: readonly string[],
}): ParsedUmaskArguments {
  let portable = false;
  let symbolic = false;
  let optionsEnded = false;
  let modeOperand: string | undefined;

  for (const argument of args) {
    if (modeOperand !== undefined) {
      // Bash ignores every remaining argument after the first mode operand,
      // including option-looking tokens. Do not reopen option parsing here.
      continue;
    }
    if (!optionsEnded && argument === '--') {
      optionsEnded = true;
      continue;
    }
    if (!optionsEnded && argument.startsWith('-') && argument !== '-') {
      const optionCharacters = argument.slice(1);
      if (optionCharacters.length === 0 || !/^[pS]+$/u.test(optionCharacters)) {
        return { ok: false, invalidOption: argument };
      }
      for (const character of optionCharacters) {
        if (character === 'p') portable = true;
        if (character === 'S') symbolic = true;
      }
      continue;
    }
    modeOperand = argument;
  }

  return {
    ok: true,
    portable,
    symbolic,
    modeOperand,
  };
}

async function writeUmaskError({
  context,
  message,
  exitCode,
}: {
  context: WeshCommandContext;
  message: string;
  exitCode: number;
}): Promise<WeshCommandResult> {
  await context.text().error({ text: `umask: ${message}\n` });
  return { exitCode };
}

export const umaskCommandImplementation: WeshCommandImplementation = {
  fn: async ({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> => {
    if (isStandaloneCommandHelpRequest({ args: context.args, acceptedForms: [['--help']] })) {
      await writeCommandHelp({ context, command: 'umask' });
      return { exitCode: 0 };
    }
    const parsedArguments = parseUmaskArguments({ args: context.args });
    if (!parsedArguments.ok) {
      return writeUmaskError({
        context,
        message: `${parsedArguments.invalidOption}: invalid option`,
        exitCode: 2,
      });
    }
    const { portable, symbolic, modeOperand } = parsedArguments;

    const getUmask = getOptionalCoreMethod<() => number>({
      object: context,
      name: 'getUmask',
    });
    const setUmask = getOptionalCoreMethod<({ mask }: { mask: number }) => void>({
      object: context,
      name: 'setUmask',
    });
    const currentMask = getUmask?.() ?? DEFAULT_FILE_CREATION_MASK;

    if (modeOperand !== undefined) {
      if (setUmask === undefined) {
        return writeUmaskError({
          context,
          message: 'setting the mask requires Wesh core umask state support',
          exitCode: 1,
        });
      }
      const numericMatch = modeOperand.match(/^[0-7]{1,4}$/u);
      if (numericMatch !== null) {
        setUmask({ mask: Number.parseInt(modeOperand, 8) & 0o777 });
      } else {
        if (!isUmaskSymbolicMode({ value: modeOperand })) {
          return writeUmaskError({ context, message: `${modeOperand}: invalid symbolic mode character`, exitCode: 1 });
        }
        const currentAllowedMode = (~currentMask) & 0o777;
        const parsed = parseFilePermissionMode({
          value: modeOperand,
          initialMode: currentAllowedMode,
          umask: 0,
          allowSpecialBits: false,
        });
        if (!parsed.ok) {
          return writeUmaskError({ context, message: `${modeOperand}: invalid symbolic mode operator`, exitCode: 1 });
        }
        setUmask({ mask: (~parsed.mode) & 0o777 });
      }
    }

    const shouldPrint = modeOperand === undefined || symbolic;
    if (shouldPrint) {
      const mask = getUmask?.() ?? DEFAULT_FILE_CREATION_MASK;
      const output = symbolic
        ? `${portable ? 'umask -S ' : ''}${formatSymbolicMask({ mask })}`
        : portable
          ? `umask ${formatOctalMask({ mask })}`
          : formatOctalMask({ mask });
      await context.text().print({ text: `${output}\n` });
    }

    return { exitCode: 0 };
  },
};

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
  parseUmaskArguments,
};
