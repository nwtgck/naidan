export type NumericLimitReason =
  | 'coefficient_digits'
  | 'denominator_digits'
  | 'exponent'
  | 'alignment'
  | 'materialized_integer'
  | 'cross_multiplication'
  | 'iterations'
  | 'output_length';

export class NumericLimitError extends Error {
  readonly reason: NumericLimitReason;

  constructor({ reason, message }: {
    reason: NumericLimitReason,
    message: string,
  }) {
    super(message);
    this.name = 'NumericLimitError';
    this.reason = reason;
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {};
