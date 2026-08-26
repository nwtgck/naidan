import { encodeCommandDataText } from '@/features/wesh/commands/_shared/data-codec';
import type { WeshCharacterLocaleMode } from '@/features/wesh/commands/_shared/locale';
import type { WeshFileType, WeshStat } from '@/features/wesh/types';
import type { CompiledStatFormat, StatFormatDirectiveToken } from './format-parser';

export interface StatRenderInput {
  operand: string,
  stat: WeshStat,
  symlinkTarget: string | undefined,
  characterLocaleMode: WeshCharacterLocaleMode,
}

const textEncoder = new TextEncoder();

function getTypeBits({ type }: { type: WeshFileType }): number {
  switch (type) {
  case 'file':
    return 0o100000;
  case 'directory':
    return 0o040000;
  case 'fifo':
    return 0o010000;
  case 'chardev':
    return 0o020000;
  case 'symlink':
    return 0o120000;
  default: {
    const _ex: never = type;
    throw new Error(`Unhandled file type: ${_ex}`);
  }
  }
}

function getTypeCharacter({ type }: { type: WeshFileType }): string {
  switch (type) {
  case 'file':
    return '-';
  case 'directory':
    return 'd';
  case 'fifo':
    return 'p';
  case 'chardev':
    return 'c';
  case 'symlink':
    return 'l';
  default: {
    const _ex: never = type;
    throw new Error(`Unhandled file type: ${_ex}`);
  }
  }
}

function getTypeDescription({ type }: { type: WeshFileType }): string {
  switch (type) {
  case 'file':
    return 'regular file';
  case 'directory':
    return 'directory';
  case 'fifo':
    return 'fifo';
  case 'chardev':
    return 'character special file';
  case 'symlink':
    return 'symbolic link';
  default: {
    const _ex: never = type;
    throw new Error(`Unhandled file type: ${_ex}`);
  }
  }
}

function permissionTriplet({
  mode,
  shift,
  specialBit,
  specialEnabled,
  specialDisabled,
}: {
  mode: number,
  shift: number,
  specialBit: number,
  specialEnabled: string,
  specialDisabled: string,
}): string {
  const read = (mode & (0o4 << shift)) !== 0 ? 'r' : '-';
  const write = (mode & (0o2 << shift)) !== 0 ? 'w' : '-';
  const execute = (mode & (0o1 << shift)) !== 0;
  const special = (mode & specialBit) !== 0;
  const executeCharacter = special
    ? (execute ? specialEnabled : specialDisabled)
    : (execute ? 'x' : '-');
  return `${read}${write}${executeCharacter}`;
}

function formatSymbolicMode({ stat }: { stat: WeshStat }): string {
  const mode = stat.mode & 0o7777;
  return getTypeCharacter({ type: stat.type })
    + permissionTriplet({
      mode,
      shift: 6,
      specialBit: 0o4000,
      specialEnabled: 's',
      specialDisabled: 'S',
    })
    + permissionTriplet({
      mode,
      shift: 3,
      specialBit: 0o2000,
      specialEnabled: 's',
      specialDisabled: 'S',
    })
    + permissionTriplet({
      mode,
      shift: 0,
      specialBit: 0o1000,
      specialEnabled: 't',
      specialDisabled: 'T',
    });
}

function formatUtcTimestamp({ milliseconds }: { milliseconds: number }): string {
  const date = new Date(milliseconds);
  const iso = date.toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 23)}000000 +0000`;
}

function floorDivideBigInt({
  dividend,
  divisor,
}: {
  dividend: bigint,
  divisor: bigint,
}): bigint {
  const quotient = dividend / divisor;
  const remainder = dividend % divisor;
  if (remainder < 0n) return quotient - 1n;
  return quotient;
}

function formatScaledSeconds({
  scaledSeconds,
  precision,
}: {
  scaledSeconds: bigint,
  precision: number,
}): string {
  if (precision === 0) return scaledSeconds.toString();
  const scale = 10n ** BigInt(precision);
  const sign = scaledSeconds < 0n ? '-' : '';
  const absolute = scaledSeconds < 0n ? -scaledSeconds : scaledSeconds;
  const integerPart = absolute / scale;
  const fractionPart = (absolute % scale).toString().padStart(precision, '0');
  return `${sign}${integerPart}.${fractionPart}`;
}

function formatEpochSeconds({
  milliseconds,
  precision,
}: {
  milliseconds: number,
  precision: number | undefined,
}): string {
  const millisecondsInteger = BigInt(milliseconds);
  if (precision === undefined || precision === 0) {
    return floorDivideBigInt({
      dividend: millisecondsInteger,
      divisor: 1000n,
    }).toString();
  }

  const representedPrecision = Math.min(precision, 3);
  const divisor = 10n ** BigInt(3 - representedPrecision);
  const scaledSeconds = floorDivideBigInt({
    dividend: millisecondsInteger,
    divisor,
  });
  const represented = formatScaledSeconds({
    scaledSeconds,
    precision: representedPrecision,
  });
  if (precision <= 3) return represented;
  return `${represented}${'0'.repeat(precision - 3)}`;
}

function isControlCodePoint({ codePoint }: { codePoint: number }): boolean {
  return codePoint < 0x20 || (codePoint >= 0x7f && codePoint <= 0x9f);
}

function isSurrogateEscapedByte({ codeUnit }: { codeUnit: number }): boolean {
  return codeUnit >= 0xdc80 && codeUnit <= 0xdcff;
}

function canUseDoubleQuotes({ value }: { value: string }): boolean {
  for (const character of value) {
    if (character === "'" || character === ' ') continue;
    if (/^[\p{L}\p{M}\p{N}_+,.\-/:@%]$/u.test(character)) continue;
    return false;
  }
  return true;
}

function quotePrintableStatSegment({ value }: { value: string }): string {
  if (!value.includes("'")) return `'${value}'`;
  if (canUseDoubleQuotes({ value })) return `"${value}"`;
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function escapeStatByte({ byte }: { byte: number }): string {
  switch (byte) {
  case 0x07: return '\\a';
  case 0x08: return '\\b';
  case 0x09: return '\\t';
  case 0x0a: return '\\n';
  case 0x0b: return '\\v';
  case 0x0c: return '\\f';
  case 0x0d: return '\\r';
  default: return `\\${byte.toString(8).padStart(3, '0')}`;
  }
}

export function quoteStatName({
  value,
  characterLocaleMode,
}: {
  value: string,
  characterLocaleMode: WeshCharacterLocaleMode,
}): string {
  const rendered: string[] = [];
  let printable = '';
  let escapedBytes: number[] = [];

  const flushPrintable = ({ evenIfEmpty }: { evenIfEmpty: boolean }): void => {
    if (printable.length === 0 && !evenIfEmpty) return;
    rendered.push(quotePrintableStatSegment({ value: printable }));
    printable = '';
  };
  const flushEscaped = (): void => {
    if (escapedBytes.length === 0) return;
    rendered.push(`$'${escapedBytes.map(byte => escapeStatByte({ byte })).join('')}'`);
    escapedBytes = [];
  };

  for (let index = 0; index < value.length;) {
    const codeUnit = value.charCodeAt(index);
    if (isSurrogateEscapedByte({ codeUnit })) {
      flushPrintable({ evenIfEmpty: rendered.length === 0 });
      escapedBytes.push(codeUnit - 0xdc00);
      index += 1;
      continue;
    }

    const codePoint = value.codePointAt(index)!;
    const character = String.fromCodePoint(codePoint);
    const printableInLocale = !isControlCodePoint({ codePoint })
      && (characterLocaleMode === 'unicode' || codePoint <= 0x7e);
    if (printableInLocale) {
      flushEscaped();
      printable += character;
    } else {
      flushPrintable({ evenIfEmpty: rendered.length === 0 });
      escapedBytes.push(...encodeCommandDataText({ text: character }));
    }
    index += character.length;
  }

  flushEscaped();
  flushPrintable({ evenIfEmpty: rendered.length === 0 });
  return rendered.join('');
}

export function validateStatMetadata({ stat }: { stat: WeshStat }): string | undefined {
  const safeIntegerFields: Array<{ name: string, value: number }> = [
    { name: 'size', value: stat.size },
    { name: 'mode', value: stat.mode },
    { name: 'ino', value: stat.ino },
    { name: 'uid', value: stat.uid },
    { name: 'gid', value: stat.gid },
  ];
  for (const field of safeIntegerFields) {
    if (!Number.isSafeInteger(field.value) || field.value < 0) {
      return `${field.name} must be a non-negative safe integer`;
    }
  }
  if (stat.mode > 0o177777) {
    return 'mode must fit within the supported Unix mode bit range';
  }
  if (!Number.isSafeInteger(stat.mtime)) {
    return 'mtime must be a safe integer number of milliseconds';
  }
  if (Number.isNaN(new Date(stat.mtime).getTime())) {
    return 'mtime must be within the JavaScript Date range';
  }

  switch (stat.type) {
  case 'file':
  case 'directory':
  case 'fifo':
  case 'chardev':
  case 'symlink':
    return undefined;
  default: {
    const _ex: never = stat.type;
    return `unsupported file type: ${String(_ex)}`;
  }
  }
}

function repeatByte({ byte, count }: { byte: number, count: number }): Uint8Array {
  const result = new Uint8Array(count);
  result.fill(byte);
  return result;
}

function combineByteArrays({ parts }: { parts: readonly Uint8Array[] }): Uint8Array {
  const byteLength = parts.reduce((total, part) => total + part.byteLength, 0);
  const result = new Uint8Array(byteLength);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}

function applyFieldWidth({
  value,
  token,
  supportsZeroPadding,
  zeroPaddingPrefixLength,
}: {
  value: Uint8Array,
  token: StatFormatDirectiveToken,
  supportsZeroPadding: boolean,
  zeroPaddingPrefixLength: number,
}): Uint8Array {
  const width = token.width;
  if (width === undefined || value.byteLength >= width) return value;

  const paddingLength = width - value.byteLength;
  if (token.alignment === 'right' && token.padding === 'zero' && supportsZeroPadding) {
    const prefix = value.slice(0, zeroPaddingPrefixLength);
    const remainder = value.slice(zeroPaddingPrefixLength);
    return combineByteArrays({
      parts: [prefix, repeatByte({ byte: 0x30, count: paddingLength }), remainder],
    });
  }

  const padding = repeatByte({ byte: 0x20, count: paddingLength });
  switch (token.alignment) {
  case 'left':
    return combineByteArrays({ parts: [value, padding] });
  case 'right':
    return combineByteArrays({ parts: [padding, value] });
  default: {
    const _ex: never = token.alignment;
    throw new Error(`Unhandled stat alignment: ${_ex}`);
  }
  }
}

function applyUnsignedIntegerPrecision({
  digits,
  precision,
}: {
  digits: string,
  precision: number | undefined,
}): string {
  if (precision === undefined) return digits;
  if (precision === 0 && digits === '0') return '';
  return digits.padStart(precision, '0');
}

function applyTimestampSign({
  value,
  sign,
}: {
  value: string,
  sign: StatFormatDirectiveToken['sign'],
}): string {
  if (value.startsWith('-')) return value;
  switch (sign) {
  case 'none':
    return value;
  case 'plus':
    return `+${value}`;
  case 'space':
    return ` ${value}`;
  default: {
    const _ex: never = sign;
    throw new Error(`Unhandled stat sign flag: ${_ex}`);
  }
  }
}

function truncateBytes({
  bytes,
  precision,
}: {
  bytes: Uint8Array,
  precision: number | undefined,
}): Uint8Array {
  if (precision === undefined || bytes.byteLength <= precision) return bytes;
  return bytes.slice(0, precision);
}

function hasStatFormattingModifiers({ token }: { token: StatFormatDirectiveToken }): boolean {
  return token.width !== undefined
    || token.precision !== undefined
    || token.alignment === 'left'
    || token.padding === 'zero'
    || token.alternateForm === 'enabled'
    || token.sign !== 'none'
    || token.grouping === 'enabled';
}

function renderDirective({
  token,
  input,
  quoteModifiedNameDirectives,
}: {
  token: StatFormatDirectiveToken,
  input: StatRenderInput,
  quoteModifiedNameDirectives: boolean,
}): Uint8Array {
  let value: Uint8Array;
  let supportsZeroPadding = false;
  let zeroPaddingPrefixLength = 0;

  switch (token.directive) {
  case 'permissions-octal': {
    let digits = applyUnsignedIntegerPrecision({
      digits: (input.stat.mode & 0o7777).toString(8),
      precision: token.precision,
    });
    if (token.alternateForm === 'enabled' && digits !== '0' && !digits.startsWith('0')) {
      digits = `0${digits}`;
    }
    value = textEncoder.encode(digits);
    supportsZeroPadding = token.precision === undefined;
    break;
  }
  case 'permissions-symbolic':
    value = truncateBytes({
      bytes: textEncoder.encode(formatSymbolicMode({ stat: input.stat })),
      precision: token.precision,
    });
    break;
  case 'raw-mode': {
    const digits = applyUnsignedIntegerPrecision({
      digits: (getTypeBits({ type: input.stat.type }) | (input.stat.mode & 0o7777)).toString(16),
      precision: token.precision,
    });
    const prefix = (() => {
      switch (token.alternateForm) {
      case 'enabled':
        return '0x';
      case 'disabled':
        return '';
      default: {
        const _ex: never = token.alternateForm;
        throw new Error(`Unhandled stat alternate-form flag: ${_ex}`);
      }
      }
    })();
    value = textEncoder.encode(`${prefix}${digits}`);
    supportsZeroPadding = token.precision === undefined;
    zeroPaddingPrefixLength = prefix.length;
    break;
  }
  case 'file-type':
    value = truncateBytes({
      bytes: textEncoder.encode(getTypeDescription({ type: input.stat.type })),
      precision: token.precision,
    });
    break;
  case 'group-id':
  case 'inode':
  case 'size':
  case 'user-id': {
    const numericValue = (() => {
      switch (token.directive) {
      case 'group-id': return input.stat.gid;
      case 'inode': return input.stat.ino;
      case 'size': return input.stat.size;
      case 'user-id': return input.stat.uid;
      default: {
        const _ex: never = token.directive;
        throw new Error(`Unhandled stat unsigned integer directive: ${_ex}`);
      }
      }
    })();
    value = textEncoder.encode(applyUnsignedIntegerPrecision({
      digits: numericValue.toString(),
      precision: token.precision,
    }));
    supportsZeroPadding = token.precision === undefined;
    break;
  }
  case 'name':
    value = truncateBytes({
      bytes: encodeCommandDataText({ text: input.operand }),
      precision: token.precision,
    });
    break;
  case 'quoted-name': {
    if (!hasStatFormattingModifiers({ token })) {
      let rendered = quoteStatName({
        value: input.operand,
        characterLocaleMode: input.characterLocaleMode,
      });
      if (input.symlinkTarget !== undefined) {
        rendered += ` -> ${quoteStatName({
          value: input.symlinkTarget,
          characterLocaleMode: input.characterLocaleMode,
        })}`;
      }
      value = textEncoder.encode(rendered);
      break;
    }

    const renderRawNameField = ({ rawName }: { rawName: string }): Uint8Array => applyFieldWidth({
      value: truncateBytes({
        bytes: encodeCommandDataText({ text: rawName }),
        precision: token.precision,
      }),
      token,
      supportsZeroPadding: false,
      zeroPaddingPrefixLength: 0,
    });
    const renderNameValue = ({ rawName }: { rawName: string }): Uint8Array => renderRawNameField({
      rawName: quoteModifiedNameDirectives
        ? quoteStatName({
          value: rawName,
          characterLocaleMode: input.characterLocaleMode,
        })
        : rawName,
    });
    const name = renderNameValue({ rawName: input.operand });
    if (input.symlinkTarget === undefined) return name;
    const target = renderNameValue({ rawName: input.symlinkTarget });
    return combineByteArrays({
      parts: [name, textEncoder.encode(' -> '), target],
    });
  }
  case 'birth-time':
    value = truncateBytes({ bytes: textEncoder.encode('-'), precision: token.precision });
    break;
  case 'birth-time-seconds':
    value = textEncoder.encode(applyTimestampSign({
      value: formatEpochSeconds({ milliseconds: 0, precision: token.precision }),
      sign: token.sign,
    }));
    supportsZeroPadding = true;
    zeroPaddingPrefixLength = value[0] === 0x2b || value[0] === 0x2d || value[0] === 0x20 ? 1 : 0;
    break;
  case 'modify-time':
    value = truncateBytes({
      bytes: textEncoder.encode(formatUtcTimestamp({ milliseconds: input.stat.mtime })),
      precision: token.precision,
    });
    break;
  case 'modify-time-seconds':
    value = textEncoder.encode(applyTimestampSign({
      value: formatEpochSeconds({
        milliseconds: input.stat.mtime,
        precision: token.precision,
      }),
      sign: token.sign,
    }));
    supportsZeroPadding = true;
    zeroPaddingPrefixLength = value[0] === 0x2b || value[0] === 0x2d || value[0] === 0x20 ? 1 : 0;
    break;
  case 'unknown':
    // GNU stat treats an unknown conversion as a literal question mark and
    // ignores all conversion flags, width, and precision for that token.
    return textEncoder.encode('?');
  default: {
    const _ex: never = token.directive;
    throw new Error(`Unhandled stat directive: ${_ex}`);
  }
  }

  // GNU accepts the grouping flag for all stat directives. Wesh only exposes
  // C/POSIX-style character locales, where grouping has no visible effect.
  void token.grouping;

  return applyFieldWidth({
    value,
    token,
    supportsZeroPadding,
    zeroPaddingPrefixLength,
  });
}

export function* renderCompiledStatFormatChunks({
  format,
  input,
}: {
  format: CompiledStatFormat,
  input: StatRenderInput,
}): Iterable<Uint8Array> {
  // GNU stat selects quoting for every %N in the format when at least one %N
  // has no field modifiers. Modified %N directives then apply their width and
  // precision to each quoted name component independently.
  const quoteModifiedNameDirectives = format.tokens.some(token => token.kind === 'directive'
    && token.directive === 'quoted-name'
    && !hasStatFormattingModifiers({ token }));

  for (const token of format.tokens) {
    switch (token.kind) {
    case 'literal-text': {
      const bytes = textEncoder.encode(token.value);
      if (bytes.byteLength > 0) yield bytes;
      break;
    }
    case 'literal-bytes':
      if (token.value.byteLength > 0) yield token.value;
      break;
    case 'directive': {
      const bytes = renderDirective({ token, input, quoteModifiedNameDirectives });
      if (bytes.byteLength > 0) yield bytes;
      break;
    }
    default: {
      const _ex: never = token;
      throw new Error(`Unhandled stat format token: ${String(_ex)}`);
    }
    }
  }
}

export function renderDefaultStatOutput({ input }: { input: StatRenderInput }): string {
  const permissions = (input.stat.mode & 0o7777).toString(8).padStart(4, '0');
  const quotedName = input.symlinkTarget === undefined
    ? quoteStatName({ value: input.operand, characterLocaleMode: input.characterLocaleMode })
    : `${quoteStatName({ value: input.operand, characterLocaleMode: input.characterLocaleMode })} -> ${quoteStatName({ value: input.symlinkTarget, characterLocaleMode: input.characterLocaleMode })}`;
  return [
    `  File: ${quotedName}`,
    `  Size: ${input.stat.size}    Type: ${getTypeDescription({ type: input.stat.type })}`,
    `  Mode: (${permissions}/${formatSymbolicMode({ stat: input.stat })})  Uid: ${input.stat.uid}  Gid: ${input.stat.gid}`,
    ` Inode: ${input.stat.ino}`,
    `Modify: ${formatUtcTimestamp({ milliseconds: input.stat.mtime })}`,
  ].join('\n') + '\n';
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
  formatEpochSeconds,
  formatSymbolicMode,
};
