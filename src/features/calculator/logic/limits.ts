export const CALCULATOR_LIMITS = {
  maximumInputLength: 4_096,
  maximumTokenCount: 1_024,
  maximumIdentifierLength: 64,
  maximumNumericLiteralLength: 1_120,
  maximumAstItemCount: 1_024,
  maximumSyntaxDepth: 64,
  maximumEvaluationDepth: 64,
  maximumFunctionArgumentCount: 256,
  maximumOperations: 4_096,
  maximumInternalNumericIterations: 8_192,
  maximumCoefficientDigits: 1_024,
  maximumDenominatorDigits: 1_024,
  maximumExponentMagnitude: 100_000,
  maximumAlignmentDigits: 1_024,
  maximumMaterializedIntegerDigits: 2_048,
  maximumCrossMultiplicationDigits: 4_096,
  maximumIntegerPowerExponent: 100_000,
  maximumOutputLength: 4_096,
  workingSignificantDigits: 66,
  maximumResultSignificantDigits: 50,
  defaultToolSignificantDigits: 15,
} as const;

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {};
