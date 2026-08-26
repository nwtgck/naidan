export const JQ_MAX_MATERIALIZED_VALUE_LENGTH = 1_000_000;
export const JQ_MAX_STRING_INTERPOLATION_NESTING = 128;
export const JQ_MAX_PARSER_STRUCTURAL_NESTING = 256;
export const JQ_MAX_PARSER_PREFIX_NESTING = 128;

export const JQ_MAX_USER_DEFINITION_CALL_DEPTH = 96;

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
  JQ_MAX_MATERIALIZED_VALUE_LENGTH,
  JQ_MAX_STRING_INTERPOLATION_NESTING,
  JQ_MAX_PARSER_STRUCTURAL_NESTING,
  JQ_MAX_PARSER_PREFIX_NESTING,
  JQ_MAX_USER_DEFINITION_CALL_DEPTH,
};
