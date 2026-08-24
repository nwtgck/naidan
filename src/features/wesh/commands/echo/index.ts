import type { WeshCommandDefinition, WeshCommandResult, WeshCommandContext } from '@/features/wesh/types';
import type { StandardArgvParserSpec } from '@/features/wesh/argv';
import { writeCommandHelp } from '@/features/wesh/commands/_shared/usage';
import { writeAllBytesToHandle } from '@/features/wesh/utils/fs';

const echoHelpArgvSpec: StandardArgvParserSpec = {
  options: [
    { kind: 'flag', short: 'n', long: undefined, effects: [{ key: 'noNewline', value: true }], help: { summary: 'do not output the trailing newline' } },
    { kind: 'flag', short: 'e', long: undefined, effects: [{ key: 'escapeMode', value: 'enable' }], help: { summary: 'enable interpretation of backslash escapes' } },
    { kind: 'flag', short: 'E', long: undefined, effects: [{ key: 'escapeMode', value: 'disable' }], help: { summary: 'disable interpretation of backslash escapes' } },
    { kind: 'flag', short: undefined, long: 'help', effects: [{ key: 'help', value: true }], help: { summary: 'display this help and exit', category: 'common' } },
  ],
  allowShortFlagBundles: true,
  stopAtDoubleDash: true,
  treatSingleDashAsPositional: true,
  specialTokenParsers: [],
};

function isOctalByte({ value }: { value: number }): boolean {
  return value >= 0x30 && value <= 0x37;
}

function hexDigitValue({ value }: { value: number }): number | undefined {
  if (value >= 0x30 && value <= 0x39) return value - 0x30;
  if (value >= 0x41 && value <= 0x46) return value - 0x41 + 10;
  if (value >= 0x61 && value <= 0x66) return value - 0x61 + 10;
  return undefined;
}

// A numeric result is the UTF-16 code-unit offset of the first effective `\c`.
type EchoArgumentEscapeScan = 'none' | 'escape' | number;

function scanEchoArgumentEscapes({ value }: { value: string }): EchoArgumentEscapeScan {
  const firstBackslashOffset = value.indexOf('\\');
  if (firstBackslashOffset === -1) return 'none';

  let candidateOffset = value.indexOf('\\c', firstBackslashOffset);
  while (candidateOffset !== -1) {
    let runStart = candidateOffset;
    while (runStart > 0 && value.charCodeAt(runStart - 1) === 0x5c) {
      runStart -= 1;
    }
    const backslashCount = candidateOffset - runStart + 1;
    if (backslashCount % 2 === 1) return candidateOffset;
    candidateOffset = value.indexOf('\\c', candidateOffset + 2);
  }
  return 'escape';
}

const echoTextEncoder = new TextEncoder();
const echoNewlineBytes = Uint8Array.of(0x0a);

function joinEchoArguments({
  args,
  start,
  end,
}: {
  args: readonly string[],
  start: number,
  end: number,
}): string {
  const count = end - start;
  if (count <= 0) return '';
  let joined = args[start]!;
  for (let index = start + 1; index < end; index += 1) {
    joined += ` ${args[index]!}`;
  }
  return joined;
}

function interpretEscapes({ value }: { value: string }): {
  readonly output: Uint8Array,
  readonly suppressNewline: boolean,
} {
  // Every supported escape consumes at least as many UTF-8 bytes as it emits.
  // Reuse the encoded input buffer in-place so long `echo -e` arguments do not
  // allocate one Uint8Array per character/escape.
  const output = echoTextEncoder.encode(value);
  let readOffset = 0;
  let writeOffset = 0;

  const appendByte = ({ byte }: { byte: number }): void => {
    output[writeOffset] = byte & 0xff;
    writeOffset += 1;
  };
  const finish = ({ suppressNewline }: { suppressNewline: boolean }) => ({
    output: output.subarray(0, writeOffset),
    suppressNewline,
  });

  while (readOffset < output.byteLength) {
    const current = output[readOffset]!;
    if (current !== 0x5c || readOffset + 1 >= output.byteLength) {
      appendByte({ byte: current });
      readOffset += 1;
      continue;
    }

    const escaped = output[readOffset + 1]!;
    readOffset += 2;

    if (escaped >= 0x31 && escaped <= 0x37) {
      let parsed = escaped - 0x30;
      let digitCount = 1;
      while (
        digitCount < 3
        && readOffset < output.byteLength
        && isOctalByte({ value: output[readOffset]! })
      ) {
        parsed = (parsed * 8) + (output[readOffset]! - 0x30);
        digitCount += 1;
        readOffset += 1;
      }
      appendByte({ byte: parsed });
      continue;
    }

    switch (escaped) {
    case 0x61: // a
      appendByte({ byte: 0x07 });
      break;
    case 0x62: // b
      appendByte({ byte: 0x08 });
      break;
    case 0x63: // c
      return finish({ suppressNewline: true });
    case 0x65: // e
      appendByte({ byte: 0x1b });
      break;
    case 0x66: // f
      appendByte({ byte: 0x0c });
      break;
    case 0x6e: // n
      appendByte({ byte: 0x0a });
      break;
    case 0x72: // r
      appendByte({ byte: 0x0d });
      break;
    case 0x74: // t
      appendByte({ byte: 0x09 });
      break;
    case 0x76: // v
      appendByte({ byte: 0x0b });
      break;
    case 0x5c: // \\
      appendByte({ byte: 0x5c });
      break;
    case 0x78: { // x
      let parsed = 0;
      let digitCount = 0;
      while (digitCount < 2 && readOffset < output.byteLength) {
        const digit = hexDigitValue({ value: output[readOffset]! });
        if (digit === undefined) break;
        parsed = (parsed * 16) + digit;
        digitCount += 1;
        readOffset += 1;
      }
      if (digitCount === 0) {
        appendByte({ byte: 0x5c });
        appendByte({ byte: 0x78 });
      } else {
        appendByte({ byte: parsed });
      }
      break;
    }
    case 0x30: { // 0
      let parsed = 0;
      let digitCount = 0;
      while (
        digitCount < 3
        && readOffset < output.byteLength
        && isOctalByte({ value: output[readOffset]! })
      ) {
        parsed = (parsed * 8) + (output[readOffset]! - 0x30);
        digitCount += 1;
        readOffset += 1;
      }
      appendByte({ byte: parsed });
      break;
    }
    default:
      // Unknown escapes stay byte-for-byte literal. This is also safe for a
      // non-ASCII code point after the backslash: its remaining UTF-8 bytes
      // are copied by subsequent loop iterations.
      appendByte({ byte: 0x5c });
      appendByte({ byte: escaped });
      break;
    }
  }

  return finish({ suppressNewline: false });
}

async function writePlainText({
  context,
  value,
  noNewline,
}: {
  context: WeshCommandContext,
  value: string,
  noNewline: boolean,
}): Promise<void> {
  if (value.length === 0) {
    if (!noNewline) {
      await writeAllBytesToHandle({ handle: context.stdout, data: echoNewlineBytes });
    }
    return;
  }

  const output = echoTextEncoder.encode(noNewline ? value : `${value}\n`);
  await writeAllBytesToHandle({ handle: context.stdout, data: output });
}

async function writeEscapedArguments({
  context,
  positionalStart,
  noNewline,
}: {
  context: WeshCommandContext,
  positionalStart: number,
  noNewline: boolean,
}): Promise<void> {
  // Scan and join the reachable argv prefix in one pass. A real `\c` makes
  // both the rest of its argument and every later argument unreachable.
  let joined = '';
  let hasEscapes = false;
  for (let index = positionalStart; index < context.args.length; index += 1) {
    if (index > positionalStart) joined += ' ';

    const value = context.args[index]!;
    const escapeScan = scanEchoArgumentEscapes({ value });
    if (escapeScan !== 'none') hasEscapes = true;
    if (typeof escapeScan === 'number') {
      joined += value.slice(0, escapeScan + 2);
      break;
    }
    joined += value;
  }
  if (!hasEscapes) {
    await writePlainText({ context, value: joined, noNewline });
    return;
  }

  const interpreted = interpretEscapes({ value: joined });
  if (!noNewline && !interpreted.suppressNewline) {
    const outputEnd = interpreted.output.byteOffset + interpreted.output.byteLength;
    if (outputEnd < interpreted.output.buffer.byteLength) {
      // A shrinking escape leaves spare capacity in the interpreter's encoded
      // input buffer. Reuse one byte for the newline instead of issuing a
      // second write or allocating another output buffer.
      const outputWithNewline = new Uint8Array(
        interpreted.output.buffer,
        interpreted.output.byteOffset,
        interpreted.output.byteLength + 1,
      );
      outputWithNewline[interpreted.output.byteLength] = 0x0a;
      await writeAllBytesToHandle({ handle: context.stdout, data: outputWithNewline });
      return;
    }
  }

  if (interpreted.output.byteLength !== 0) {
    await writeAllBytesToHandle({ handle: context.stdout, data: interpreted.output });
  }
  if (!noNewline && !interpreted.suppressNewline) {
    await writeAllBytesToHandle({ handle: context.stdout, data: echoNewlineBytes });
  }
}

export const echoCommandDefinition: WeshCommandDefinition = {
  meta: {
    name: 'echo',
    description: 'Display a line of text',
    usage: 'echo [-neE] [string...]',
  },
  fn: async ({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> => {
    const posixlyCorrect = context.env.has('POSIXLY_CORRECT');
    if (!posixlyCorrect && context.args.length === 1 && context.args[0] === '--help') {
      await writeCommandHelp({
        context,
        command: 'echo',
        argvSpec: echoHelpArgvSpec,
      });
      return { exitCode: 0 };
    }

    // GNU echo's option grammar is intentionally not routed through the shared
    // argv parser: an unknown option-looking token ends scanning, and under
    // POSIXLY_CORRECT scanning starts only for an exact leading `-n`.
    let noNewline = false;
    let escapeMode: 'enable' | 'disable' | undefined = posixlyCorrect ? 'enable' : undefined;
    let positionalStart = 0;
    const mayParseOptions = !posixlyCorrect || context.args[0] === '-n';
    while (mayParseOptions && positionalStart < context.args.length) {
      const token = context.args[positionalStart]!;
      if (token.length < 2 || token.charCodeAt(0) !== 0x2d) break;

      let tokenNoNewline = false;
      let tokenEscapeMode: 'enable' | 'disable' | undefined;
      let validOptionToken = true;
      for (let offset = 1; offset < token.length; offset += 1) {
        switch (token.charCodeAt(offset)) {
        case 0x6e: // n
          tokenNoNewline = true;
          break;
        case 0x65: // e
          tokenEscapeMode = 'enable';
          break;
        case 0x45: // E
          tokenEscapeMode = 'disable';
          break;
        default:
          validOptionToken = false;
          break;
        }
        if (!validOptionToken) break;
      }
      if (!validOptionToken) break;

      if (tokenNoNewline) noNewline = true;
      if (!posixlyCorrect && tokenEscapeMode !== undefined) escapeMode = tokenEscapeMode;
      positionalStart += 1;
    }

    switch (escapeMode) {
    case 'enable':
      await writeEscapedArguments({ context, positionalStart, noNewline });
      break;
    case 'disable':
    case undefined: {
      const joined = joinEchoArguments({ args: context.args, start: positionalStart, end: context.args.length });
      await writePlainText({ context, value: joined, noNewline });
      break;
    }
    default: {
      const _ex: never = escapeMode;
      throw new Error(`Unhandled echo escape mode: ${_ex}`);
    }
    }

    return { exitCode: 0 };
  },
};

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
  interpretEscapes,
  scanEchoArgumentEscapes,
};
