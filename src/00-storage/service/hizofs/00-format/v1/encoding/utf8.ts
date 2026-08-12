import { HIZOFS_V1_FORMAT_CONSTANTS } from '@/00-storage/service/hizofs/00-format/v1/format-constants';

const UTF8_ENCODER = new TextEncoder();
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });

function assertWellFormedUnicode({ label, value }: { label: string; value: string }): void {
  encodedUtf8StrictByteLength({ label, value });
}

function encodedUtf8StrictByteLength({ label, value }: { label: string; value: string }): number {
  let byteLength = 0;
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit <= 0x7f) {
      byteLength += 1;
      continue;
    }
    if (codeUnit <= 0x7ff) {
      byteLength += 2;
      continue;
    }
    if (codeUnit < 0xd800 || codeUnit > 0xdfff) {
      byteLength += 3;
      continue;
    }
    if (codeUnit >= 0xdc00) throw new TypeError(`${label} contains an unpaired low surrogate`);
    if (index + 1 >= value.length) throw new TypeError(`${label} contains an unpaired high surrogate`);
    const next = value.charCodeAt(index + 1);
    if (next < 0xdc00 || next > 0xdfff) {
      throw new TypeError(`${label} contains an unpaired high surrogate`);
    }
    byteLength += 4;
    index += 1;
  }
  return byteLength;
}

function assertEncodedLength({
  bytes,
  label,
  maximum,
  minimum,
}: {
  bytes: Uint8Array;
  label: string;
  maximum: number;
  minimum: number;
}): void {
  assertEncodedByteLength({ byteLength: bytes.byteLength, label, maximum, minimum });
}

function assertEncodedByteLength({
  byteLength,
  label,
  maximum,
  minimum,
}: {
  byteLength: number;
  label: string;
  maximum: number;
  minimum: number;
}): void {
  if (byteLength < minimum || byteLength > maximum) {
    throw new RangeError(`${label} must encode to ${minimum}..${maximum} UTF-8 bytes`);
  }
}

function assertFilenameComponentSyntax({ value }: { value: string }): void {
  if (value === '.' || value === '..') throw new TypeError('filename component must not be dot or dot-dot');
  if (value.includes('/') || value.includes('\0')) {
    throw new TypeError('filename component must not contain slash or NUL');
  }
}

export function encodeUtf8Strict({ label = 'text', value }: { label?: string; value: string }): Uint8Array {
  assertWellFormedUnicode({ label, value });
  return UTF8_ENCODER.encode(value);
}

export function decodeUtf8Strict({ bytes, label = 'text' }: { bytes: Uint8Array; label?: string }): string {
  try {
    return UTF8_DECODER.decode(bytes);
  } catch (cause: unknown) {
    throw new TypeError(`${label} is not well-formed UTF-8`, { cause });
  }
}

export function encodeFilenameComponent({
  maximumBytes = HIZOFS_V1_FORMAT_CONSTANTS.limits.filenameUtf8Bytes,
  value,
}: {
  maximumBytes?: number;
  value: string;
}): Uint8Array {
  assertFilenameComponentSyntax({ value });
  const bytes = encodeUtf8Strict({ label: 'filename component', value });
  assertEncodedLength({ bytes, label: 'filename component', maximum: maximumBytes, minimum: 1 });
  return bytes;
}

export function encodedFilenameComponentByteLength({
  maximumBytes = HIZOFS_V1_FORMAT_CONSTANTS.limits.filenameUtf8Bytes,
  value,
}: {
  maximumBytes?: number;
  value: string;
}): number {
  assertFilenameComponentSyntax({ value });
  const byteLength = encodedUtf8StrictByteLength({ label: 'filename component', value });
  assertEncodedByteLength({ byteLength, label: 'filename component', maximum: maximumBytes, minimum: 1 });
  return byteLength;
}

export function compareFilenameComponentsByUtf8({ left, right }: { left: string; right: string }): number {
  encodedFilenameComponentByteLength({ value: left });
  encodedFilenameComponentByteLength({ value: right });
  let leftIndex = 0;
  let rightIndex = 0;
  while (leftIndex < left.length && rightIndex < right.length) {
    const leftCodePoint = left.codePointAt(leftIndex);
    const rightCodePoint = right.codePointAt(rightIndex);
    if (leftCodePoint === undefined || rightCodePoint === undefined) {
      throw new Error('filename component scalar comparison invariant failed');
    }
    if (leftCodePoint !== rightCodePoint) return leftCodePoint < rightCodePoint ? -1 : 1;
    leftIndex += leftCodePoint > 0xffff ? 2 : 1;
    rightIndex += rightCodePoint > 0xffff ? 2 : 1;
  }
  if (leftIndex === left.length && rightIndex === right.length) return 0;
  return leftIndex === left.length ? -1 : 1;
}

export function writeFilenameComponent({
  bytes,
  maximumBytes = HIZOFS_V1_FORMAT_CONSTANTS.limits.filenameUtf8Bytes,
  offset,
  value,
}: {
  bytes: Uint8Array;
  maximumBytes?: number;
  offset: number;
  value: string;
}): number {
  const byteLength = encodedFilenameComponentByteLength({ maximumBytes, value });
  if (!Number.isSafeInteger(offset) || offset < 0 || offset + byteLength > bytes.byteLength) {
    throw new RangeError('filename component destination is too small');
  }
  const result = UTF8_ENCODER.encodeInto(value, bytes.subarray(offset, offset + byteLength));
  if (result.read !== value.length || result.written !== byteLength) {
    throw new Error('filename component destination encoding invariant failed');
  }
  return byteLength;
}

export function decodeFilenameComponent({
  bytes,
  maximumBytes = HIZOFS_V1_FORMAT_CONSTANTS.limits.filenameUtf8Bytes,
}: {
  bytes: Uint8Array;
  maximumBytes?: number;
}): string {
  assertEncodedLength({ bytes, label: 'filename component', maximum: maximumBytes, minimum: 1 });
  const value = decodeUtf8Strict({ bytes, label: 'filename component' });
  // WHY: fatal UTF-8 decoding already proves the resulting string is valid
  // Unicode, and byte length was checked above. Re-encoding here only to
  // repeat filename semantics creates hot-path allocation without adding a
  // stronger format proof. Keep the remaining semantic checks explicit.
  assertFilenameComponentSyntax({ value });
  return value;
}

export function encodeSymlinkTarget({
  maximumBytes = HIZOFS_V1_FORMAT_CONSTANTS.limits.symlinkTargetUtf8Bytes,
  value,
}: {
  maximumBytes?: number;
  value: string;
}): Uint8Array {
  if (value.includes('\0')) throw new TypeError('symlink target must not contain NUL');
  const bytes = encodeUtf8Strict({ label: 'symlink target', value });
  assertEncodedLength({ bytes, label: 'symlink target', maximum: maximumBytes, minimum: 1 });
  return bytes;
}

export function encodedSymlinkTargetByteLength({
  maximumBytes = HIZOFS_V1_FORMAT_CONSTANTS.limits.symlinkTargetUtf8Bytes,
  value,
}: {
  maximumBytes?: number;
  value: string;
}): number {
  if (value.includes('\0')) throw new TypeError('symlink target must not contain NUL');
  const byteLength = encodedUtf8StrictByteLength({ label: 'symlink target', value });
  assertEncodedByteLength({ byteLength, label: 'symlink target', maximum: maximumBytes, minimum: 1 });
  return byteLength;
}

export function decodeSymlinkTarget({
  bytes,
  maximumBytes = HIZOFS_V1_FORMAT_CONSTANTS.limits.symlinkTargetUtf8Bytes,
}: {
  bytes: Uint8Array;
  maximumBytes?: number;
}): string {
  assertEncodedLength({ bytes, label: 'symlink target', maximum: maximumBytes, minimum: 1 });
  const value = decodeUtf8Strict({ bytes, label: 'symlink target' });
  encodeSymlinkTarget({ maximumBytes, value });
  return value;
}

const FORBIDDEN_PASSPHRASE_LINE_CHARACTERS = /[\r\n\u0085\u2028\u2029]/u;

export function encodePassphraseUtf8({
  maximumBytes = HIZOFS_V1_FORMAT_CONSTANTS.limits.passphraseUtf8Bytes,
  value,
}: {
  maximumBytes?: number;
  value: string;
}): Uint8Array {
  if (FORBIDDEN_PASSPHRASE_LINE_CHARACTERS.test(value)) {
    throw new TypeError('passphrase contains a forbidden line separator');
  }
  const bytes = encodeUtf8Strict({ label: 'passphrase', value });
  assertEncodedLength({ bytes, label: 'passphrase', maximum: maximumBytes, minimum: 1 });
  return bytes;
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
