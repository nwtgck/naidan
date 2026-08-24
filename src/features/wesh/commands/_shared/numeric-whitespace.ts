const LEADING_C_LOCALE_WHITESPACE_PATTERN = /^[\t\n\v\f\r ]+/u;
const LEADING_C_LOCALE_OR_TRAILING_BLANK_WHITESPACE_PATTERN = /^[\t\n\v\f\r ]+|[\t ]+$/gu;

export function stripLeadingCLocaleWhitespace({
  value,
}: {
  value: string,
}): string {
  return value.replace(LEADING_C_LOCALE_WHITESPACE_PATTERN, '');
}


export function stripLeadingCLocaleAndTrailingBlankWhitespace({
  value,
}: {
  value: string,
}): string {
  return value.replace(LEADING_C_LOCALE_OR_TRAILING_BLANK_WHITESPACE_PATTERN, '');
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
