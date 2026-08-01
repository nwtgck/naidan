const LOWERCASE_HEX = /^[0-9a-f]*$/u;

export function encodeLowercaseHex({ bytes }: { bytes: Uint8Array }): string {
  let output = '';
  for (const byte of bytes) output += byte.toString(16).padStart(2, '0');
  return output;
}

export function decodeLowercaseHex({ expectedBytes, value }: { expectedBytes?: number; value: string }): Uint8Array {
  if (value.length % 2 !== 0 || !LOWERCASE_HEX.test(value)) {
    throw new TypeError('hex value must be even-length lowercase hexadecimal');
  }
  const byteLength = value.length / 2;
  if (expectedBytes !== undefined && byteLength !== expectedBytes) {
    throw new RangeError(`hex value must decode to exactly ${expectedBytes} bytes`);
  }
  const output = new Uint8Array(byteLength);
  for (let index = 0; index < byteLength; index += 1) {
    output[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return output;
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
