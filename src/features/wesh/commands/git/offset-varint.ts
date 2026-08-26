export function readOffsetVariableWidth({ bytes, offset, label }: {
  bytes: Uint8Array,
  offset: number,
  label: string,
}): { value: number, offset: number } {
  if (offset >= bytes.byteLength) throw new Error(`truncated ${label}`);
  let byte = bytes[offset]!;
  offset += 1;
  let value = byte & 0x7f;
  while ((byte & 0x80) !== 0) {
    if (offset >= bytes.byteLength) throw new Error(`truncated ${label}`);
    byte = bytes[offset]!;
    offset += 1;
    value = (value + 1) * 128 + (byte & 0x7f);
    if (!Number.isSafeInteger(value)) throw new Error(`${label} exceeds JavaScript safe integer range`);
  }
  return { value, offset };
}

export function writeOffsetVariableWidth({ value, label }: { value: number, label: string }): Uint8Array {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer`);
  }
  const reversed = [value & 0x7f];
  let remaining = Math.floor(value / 128);
  while (remaining > 0) {
    remaining -= 1;
    reversed.push(0x80 | (remaining & 0x7f));
    remaining = Math.floor(remaining / 128);
  }
  reversed.reverse();
  return Uint8Array.from(reversed);
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
