export function isValidAliasName({
  name,
  allowLeadingHyphen = false,
}: {
  name: string,
  allowLeadingHyphen?: boolean,
}): boolean {
  return name.length > 0
    && (allowLeadingHyphen || !name.startsWith('-'))
    && !/[\s/$`'"\\&|;()<>]/u.test(name)
    && !name.includes('=');
}

export function formatAliasDefinition({
  name,
  value,
}: {
  name: string,
  value: string,
}): string {
  const optionTerminator = name.startsWith('-') ? '-- ' : '';
  return `alias ${optionTerminator}${name}='${value.replaceAll("'", "'\\''")}'\n`;
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
