const BASE64URL = /^[A-Za-z0-9_-]*$/u;

function toBase64({ bytes }: { bytes: Uint8Array }): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64({ value }: { value: string }): Uint8Array {
  const binary = atob(value);
  const output = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) output[index] = binary.charCodeAt(index);
  return output;
}

export function encodeBase64UrlUnpadded({ bytes }: { bytes: Uint8Array }): string {
  return toBase64({ bytes }).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}

export function decodeBase64UrlUnpadded({
  maximumDecodedBytes,
  value,
}: {
  maximumDecodedBytes: number;
  value: string;
}): Uint8Array {
  if (!Number.isSafeInteger(maximumDecodedBytes) || maximumDecodedBytes < 0) {
    throw new RangeError('maximum decoded byte length must be a non-negative safe integer');
  }
  if (!BASE64URL.test(value) || value.length % 4 === 1) {
    throw new TypeError('value must be canonical unpadded Base64URL');
  }
  const decodedLength = Math.floor(value.length * 3 / 4);
  if (decodedLength > maximumDecodedBytes) {
    throw new RangeError('Base64URL decoded length exceeds the configured maximum');
  }
  const padding = '='.repeat((4 - value.length % 4) % 4);
  let bytes: Uint8Array;
  try {
    bytes = fromBase64({ value: value.replaceAll('-', '+').replaceAll('_', '/') + padding });
  } catch (cause: unknown) {
    throw new TypeError('value is not valid Base64URL', { cause });
  }
  if (bytes.byteLength > maximumDecodedBytes || encodeBase64UrlUnpadded({ bytes }) !== value) {
    throw new TypeError('value is not canonical unpadded Base64URL');
  }
  return bytes;
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
