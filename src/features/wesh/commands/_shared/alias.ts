export function isValidAliasName({
  name,
}: {
  name: string,
}): boolean {
  return name.length > 0
    && !name.startsWith('-')
    && !name.includes('/')
    && !/\s/u.test(name)
    && !name.includes('=');
}

export function formatAliasDefinition({
  name,
  value,
}: {
  name: string,
  value: string,
}): string {
  return `alias ${name}='${value.replaceAll("'", "'\\''")}'\n`;
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {};
