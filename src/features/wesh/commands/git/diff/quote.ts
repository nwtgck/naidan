const fileNameEncoder = new TextEncoder();

export function quoteDiffFileName({ value }: { value: string }): string {
  const bytes = fileNameEncoder.encode(value);
  const requiresQuoting = bytes.some((byte) => (
    byte === 0x20
    || byte === 0x22
    || byte === 0x5c
    || byte < 0x20
    || byte >= 0x80
  ));
  if (!requiresQuoting) return value;

  let quoted = '"';
  for (const byte of bytes) {
    switch (byte) {
    case 0x07: quoted += '\\a'; break;
    case 0x08: quoted += '\\b'; break;
    case 0x09: quoted += '\\t'; break;
    case 0x0a: quoted += '\\n'; break;
    case 0x0b: quoted += '\\v'; break;
    case 0x0c: quoted += '\\f'; break;
    case 0x0d: quoted += '\\r'; break;
    case 0x22: quoted += '\\"'; break;
    case 0x5c: quoted += '\\\\'; break;
    default:
      quoted += byte < 0x20 || byte >= 0x80
        ? `\\${byte.toString(8).padStart(3, '0')}`
        : String.fromCharCode(byte);
      break;
    }
  }
  return `${quoted}"`;
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
