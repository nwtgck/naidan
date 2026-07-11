export function encodeBase64Url({ bytes }: { bytes: Uint8Array }): string {
  let binary = '';
  const chunkSize = 0x8000;

  for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
    const chunk = bytes.subarray(offset, Math.min(offset + chunkSize, bytes.byteLength));
    binary += String.fromCharCode(...chunk);
  }

  return btoa(binary)
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/u, '');
}

export function decodeBase64Url({ value }: { value: string }): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/u.test(value)) {
    throw new Error('Invalid Base64URL value');
  }

  const remainder = value.length % 4;
  if (remainder === 1) {
    throw new Error('Invalid Base64URL length');
  }

  const padded = value
    .replaceAll('-', '+')
    .replaceAll('_', '/')
    .padEnd(value.length + ((4 - remainder) % 4), '=');
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index++) {
    bytes[index] = binary.charCodeAt(index);
  }

  return bytes;
}

export function decodeBase64UrlWithLength({
  value,
  expectedByteLength,
  fieldName,
}: {
  value: string,
  expectedByteLength: number,
  fieldName: string,
}): Uint8Array {
  const bytes = decodeBase64Url({ value });
  if (bytes.byteLength !== expectedByteLength) {
    throw new Error(`${fieldName} must contain exactly ${expectedByteLength} bytes`);
  }
  return bytes;
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
