export function isAsciiDecimalDigit({ value }: { value: string | undefined }): boolean {
  if (value === undefined || value.length !== 1) return false;
  const code = value.charCodeAt(0);
  return code >= 0x30 && code <= 0x39;
}

export function isAsciiHexDigit({ value }: { value: string | undefined }): boolean {
  if (value === undefined || value.length !== 1) return false;
  const code = value.charCodeAt(0);
  return (
    (code >= 0x30 && code <= 0x39)
    || (code >= 0x41 && code <= 0x46)
    || (code >= 0x61 && code <= 0x66)
  );
}

export function isAsciiOctalDigit({ value }: { value: string | undefined }): boolean {
  if (value === undefined || value.length !== 1) return false;
  const code = value.charCodeAt(0);
  return code >= 0x30 && code <= 0x37;
}

export function isAsciiShellIdentifierStart({ value }: { value: string | undefined }): boolean {
  if (value === '_') return true;
  if (value === undefined || value.length !== 1) return false;
  const code = value.charCodeAt(0);
  return (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a);
}

export function isAsciiShellIdentifierPart({ value }: { value: string | undefined }): boolean {
  return isAsciiShellIdentifierStart({ value }) || isAsciiDecimalDigit({ value });
}

export function isShellWhitespaceCharacter({
  value,
}: {
  value: string | undefined,
}): boolean {
  return value === ' ' || value === '\t' || value === '\n';
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
