export const CALCULATOR_LIMITS = {
  maximumInputLength: 4_096,
  maximumTokenCount: 1_024,
  maximumIdentifierLength: 64,
  maximumNumericLiteralLength: 128,
  maximumAstItemCount: 1_024,
  maximumSyntaxDepth: 64,
  maximumEvaluationDepth: 64,
  maximumFunctionArgumentCount: 256,
  maximumOperations: 4_096,
} as const;

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {};
