import type {
  WeshCommandContext,
  WeshCommandDefinition,
  WeshCommandResult,
} from '@/features/wesh/types';
import { compareAsciiStrings } from '@/features/wesh/commands/_shared/ascii-order';
import { isStandaloneCommandHelpRequest, writeCommandHelp } from '@/features/wesh/commands/_shared/usage';
import { resolveCharacterLocaleMode, type WeshCharacterLocaleMode } from '@/features/wesh/commands/_shared/locale';


const UTF8_ENCODER = new TextEncoder();
const ASSIGNED_UNICODE_CHARACTER_PATTERN = /^\p{Assigned}$/u;

function isAsciiLocale({
  localeMode,
}: {
  localeMode: WeshCharacterLocaleMode;
}): boolean {
  switch (localeMode) {
  case 'ascii': return true;
  case 'unicode': return false;
  default: {
    const _ex: never = localeMode;
    throw new Error(`Unhandled character locale mode: ${_ex}`);
  }
  }
}

function escapeAnsiCByte({ byte }: { byte: number }): string {
  switch (byte) {
  case 0x07: return '\\a';
  case 0x08: return '\\b';
  case 0x1b: return '\\e';
  case 0x0c: return '\\f';
  case 0x0a: return '\\n';
  case 0x0d: return '\\r';
  case 0x09: return '\\t';
  case 0x0b: return '\\v';
  case 0x5c: return '\\\\';
  case 0x27: return "\\'";
  default:
    if (byte < 0x20 || byte === 0x7f) {
      return `\\x${byte.toString(16).padStart(2, '0')}`;
    }
    if (byte >= 0x80) {
      return `\\${byte.toString(8).padStart(3, '0')}`;
    }
    return String.fromCharCode(byte);
  }
}

function escapeAnsiCCharacter({ character }: { character: string }): string {
  const codePoint = character.codePointAt(0) ?? 0;
  if (
    (codePoint >= 0x80 && codePoint <= 0x9f)
    || codePoint === 0x2028
    || codePoint === 0x2029
  ) {
    return Array.from(UTF8_ENCODER.encode(character), byte => (
      `\\${byte.toString(8).padStart(3, '0')}`
    )).join('');
  }
  return Array.from(UTF8_ENCODER.encode(character), byte => escapeAnsiCByte({ byte })).join('');
}

function formatAnsiCQuotedValue({
  value,
  localeMode,
}: {
  value: string;
  localeMode: WeshCharacterLocaleMode;
}): string {
  const escaped = isAsciiLocale({ localeMode })
    ? Array.from(UTF8_ENCODER.encode(value), byte => escapeAnsiCByte({ byte })).join('')
    : Array.from(value, character => escapeAnsiCCharacter({ character })).join('');
  return `$'${escaped}'`;
}

function requiresAnsiCQuoting({
  value,
  localeMode,
}: {
  value: string;
  localeMode: WeshCharacterLocaleMode;
}): boolean {
  if (isAsciiLocale({ localeMode }) && UTF8_ENCODER.encode(value).some(byte => byte >= 0x80)) {
    return true;
  }
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint < 0x20
      || (codePoint >= 0x7f && codePoint <= 0x9f)
      || codePoint === 0x2028
      || codePoint === 0x2029
      || (!isAsciiLocale({ localeMode }) && !ASSIGNED_UNICODE_CHARACTER_PATTERN.test(character));
  });
}

function isReusableUnquotedValue({
  value,
  localeMode,
}: {
  value: string;
  localeMode: WeshCharacterLocaleMode;
}): boolean {
  return Array.from(value).every((character, index) => {
    const codePoint = character.codePointAt(0) ?? 0;
    if (
      !isAsciiLocale({ localeMode })
      && codePoint > 0x9f
      && codePoint !== 0x2028
      && codePoint !== 0x2029
      && ASSIGNED_UNICODE_CHARACTER_PATTERN.test(character)
    ) {
      return true;
    }
    if (/^[A-Za-z0-9_@%+=:,./-]$/u.test(character)) {
      return true;
    }
    return index > 0 && (character === '#' || character === '~');
  });
}

function formatSetVariableValue({
  value,
  localeMode,
}: {
  value: string;
  localeMode: WeshCharacterLocaleMode;
}): string {
  if (value.length === 0) {
    return '';
  }
  if (requiresAnsiCQuoting({ value, localeMode })) {
    return formatAnsiCQuotedValue({ value, localeMode });
  }
  if (isReusableUnquotedValue({ value, localeMode })) {
    return value;
  }
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function printShellVariables({ context }: { context: WeshCommandContext }): Promise<void> {
  const entries = [...context.env.entries()].sort(([left], [right]) => compareAsciiStrings({ left, right }));
  const localeMode = resolveCharacterLocaleMode({ env: context.env });
  for (const [name, value] of entries) {
    await context.text().print({
      text: `${name}=${formatSetVariableValue({ value, localeMode })}\n`,
    });
  }
}



async function writeStateCapabilityError({
  context,
}: {
  context: WeshCommandContext;
}): Promise<WeshCommandResult> {
  await context.text().error({
    text: 'set: operation requires Wesh core positional-parameter or pipefail state support\n',
  });
  return { exitCode: 1 };
}

export const setCommandDefinition: WeshCommandDefinition = {
  meta: {
    name: 'set',
    description: 'Display shell variables in reusable assignment form',
    usage: 'set',
  },
  fn: async ({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> => {
    if (isStandaloneCommandHelpRequest({ args: context.args, acceptedForms: [['--help']] })) {
      await writeCommandHelp({ context, command: 'set' });
      return { exitCode: 0 };
    }
    const args = context.args;
    if (args.length === 0) {
      await printShellVariables({ context });
      return { exitCode: 0 };
    }

    return writeStateCapabilityError({ context });
  },
};

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
