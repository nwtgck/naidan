import type { WeshFileType, WeshStat } from '@/features/wesh/types';
import type { CompiledStatFormat, StatFormatDirectiveToken } from './format-parser';

export interface StatRenderInput {
  operand: string,
  stat: WeshStat,
  symlinkTarget: string | undefined,
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
  return `${iso.slice(0, 10)} ${iso.slice(11, 23)} +0000`;
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

function containsControlCharacter({ value }: { value: string }): boolean {
  for (const char of value) {
    const code = char.codePointAt(0)!;
    if (isControlCodePoint({ codePoint: code })) return true;
  }
  return false;
}

export function quoteStatName({ value }: { value: string }): string {
  if (!containsControlCharacter({ value })) {
    return `'${value.replaceAll("'", "'\\''")}'`;
  }

  let result = "$'";
  for (const char of value) {
    switch (char) {
    case '\\':
      result += '\\\\';
      break;
    case "'":
      result += "\\'";
      break;
    case '\n':
      result += '\\n';
      break;
    case '\r':
      result += '\\r';
      break;
    case '\t':
      result += '\\t';
      break;
    case '\b':
      result += '\\b';
      break;
    case '\f':
      result += '\\f';
      break;
    case '\v':
      result += '\\v';
      break;
    default: {
      const code = char.codePointAt(0)!;
      if (isControlCodePoint({ codePoint: code })) {
        result += `\\x${code.toString(16).padStart(2, '0')}`;
      } else {
        result += char;
      }
      break;
    }
    }
  }
  return `${result}'`;
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

function applyFieldWidth({
  value,
  token,
}: {
  value: string,
  token: StatFormatDirectiveToken,
}): string {
  const width = token.width;
  if (width === undefined || value.length >= width) return value;

  if (token.alignment === 'right' && token.padding === 'zero') {
    let prefixLength = 0;
    if (value.startsWith('-') || value.startsWith('+')) prefixLength = 1;
    if (value.slice(prefixLength).startsWith('0x') || value.slice(prefixLength).startsWith('0X')) {
      prefixLength += 2;
    }
    const prefix = value.slice(0, prefixLength);
    const remainder = value.slice(prefixLength);
    return `${prefix}${'0'.repeat(width - value.length)}${remainder}`;
  }

  const padding = ' '.repeat(width - value.length);
  switch (token.alignment) {
  case 'left':
    return `${value}${padding}`;
  case 'right':
    return `${padding}${value}`;
  default: {
    const _ex: never = token.alignment;
    throw new Error(`Unhandled stat alignment: ${_ex}`);
  }
  }
}

function renderDirective({
  token,
  input,
}: {
  token: StatFormatDirectiveToken,
  input: StatRenderInput,
}): string {
  let value: string;
  switch (token.directive) {
  case 'permissions-octal': {
    const digits = (input.stat.mode & 0o7777).toString(8);
    switch (token.alternateForm) {
    case 'disabled':
      value = digits;
      break;
    case 'enabled':
      value = digits === '0' ? digits : `0${digits}`;
      break;
    default: {
      const _ex: never = token.alternateForm;
      throw new Error(`Unhandled stat alternate form: ${_ex}`);
    }
    }
    break;
  }
  case 'permissions-symbolic':
    value = formatSymbolicMode({ stat: input.stat });
    break;
  case 'raw-mode': {
    const digits = (getTypeBits({ type: input.stat.type }) | (input.stat.mode & 0o7777)).toString(16);
    switch (token.alternateForm) {
    case 'disabled':
      value = digits;
      break;
    case 'enabled':
      value = `0x${digits}`;
      break;
    default: {
      const _ex: never = token.alternateForm;
      throw new Error(`Unhandled stat alternate form: ${_ex}`);
    }
    }
    break;
  }
  case 'file-type':
    value = getTypeDescription({ type: input.stat.type });
    break;
  case 'group-id':
    value = input.stat.gid.toString();
    break;
  case 'inode':
    value = input.stat.ino.toString();
    break;
  case 'name':
    value = input.operand;
    break;
  case 'quoted-name':
    value = quoteStatName({ value: input.operand });
    if (input.symlinkTarget !== undefined) {
      value += ` -> ${quoteStatName({ value: input.symlinkTarget })}`;
    }
    break;
  case 'size':
    value = input.stat.size.toString();
    break;
  case 'user-id':
    value = input.stat.uid.toString();
    break;
  case 'birth-time':
    value = '-';
    break;
  case 'birth-time-seconds':
    value = '0';
    break;
  case 'modify-time':
    value = formatUtcTimestamp({ milliseconds: input.stat.mtime });
    break;
  case 'modify-time-seconds':
    value = formatEpochSeconds({
      milliseconds: input.stat.mtime,
      precision: token.precision,
    });
    break;
  case 'unknown':
    value = '?';
    break;
  default: {
    const _ex: never = token.directive;
    throw new Error(`Unhandled stat directive: ${_ex}`);
  }
  }

  return applyFieldWidth({ value, token });
}

export function* renderCompiledStatFormatChunks({
  format,
  input,
}: {
  format: CompiledStatFormat,
  input: StatRenderInput,
}): Iterable<Uint8Array> {
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
      const bytes = textEncoder.encode(renderDirective({ token, input }));
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
    ? quoteStatName({ value: input.operand })
    : `${quoteStatName({ value: input.operand })} -> ${quoteStatName({ value: input.symlinkTarget })}`;
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
