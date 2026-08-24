export function getGzipSuffixDiagnostic({
  suffix,
}: {
  suffix: string,
}): string | undefined {
  const byteLength = new TextEncoder().encode(suffix).byteLength;
  if (byteLength === 0 || byteLength > 30) {
    return `gzip: invalid suffix '${suffix}'\n`;
  }
  return undefined;
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
