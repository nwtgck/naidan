import { HIZOFS_V1_FORMAT_CONSTANTS } from '@/00-storage/service/hizofs/00-format/v1/format-constants';

const UTF8_ENCODER = new TextEncoder();
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });

function assertWellFormedUnicode({ label, value }: { label: string; value: string }): void {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit < 0xd800 || codeUnit > 0xdfff) continue;
    if (codeUnit >= 0xdc00) throw new TypeError(`${label} contains an unpaired low surrogate`);
    if (index + 1 >= value.length) throw new TypeError(`${label} contains an unpaired high surrogate`);
    const next = value.charCodeAt(index + 1);
    if (next < 0xdc00 || next > 0xdfff) {
      throw new TypeError(`${label} contains an unpaired high surrogate`);
    }
    index += 1;
  }
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
  if (bytes.byteLength < minimum || bytes.byteLength > maximum) {
    throw new RangeError(`${label} must encode to ${minimum}..${maximum} UTF-8 bytes`);
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
  if (value === '.' || value === '..') throw new TypeError('filename component must not be dot or dot-dot');
  if (value.includes('/') || value.includes('\0')) {
    throw new TypeError('filename component must not contain slash or NUL');
  }
  const bytes = encodeUtf8Strict({ label: 'filename component', value });
  assertEncodedLength({ bytes, label: 'filename component', maximum: maximumBytes, minimum: 1 });
  return bytes;
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
  encodeFilenameComponent({ maximumBytes, value });
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
