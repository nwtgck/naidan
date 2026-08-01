export function writeFixedAscii({ bytes, offset, value }: { bytes: Uint8Array; offset: number; value: string }): void {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code < 0x20 || code > 0x7e) throw new TypeError('fixed ASCII value contains a non-printable character');
  }
  const encoded = new TextEncoder().encode(value);
  if (offset < 0 || offset + encoded.byteLength > bytes.byteLength) throw new RangeError('fixed ASCII range is out of bounds');
  bytes.set(encoded, offset);
}

export function assertFixedAscii({ bytes, offset, value }: { bytes: Uint8Array; offset: number; value: string }): void {
  const encoded = new TextEncoder().encode(value);
  if (offset < 0 || offset + encoded.byteLength > bytes.byteLength) throw new RangeError('fixed ASCII range is out of bounds');
  for (let index = 0; index < encoded.byteLength; index += 1) {
    if (bytes[offset + index] !== encoded[index]) throw new TypeError(`binary magic must be ${value}`);
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
