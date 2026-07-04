import { failCalculatorInput } from './diagnostics';
import { CALCULATOR_LIMITS } from './limits';
import { serializeDecimal } from './numeric/decimal';
import { numericValueToApproximateDecimal, type CalculatorNumericValue } from './numeric/numeric-value';
import { serializeRational } from './numeric/rational';

export type CalculatorOutputPolicy =
  | { readonly format: 'decimal', readonly significantDigits: number }
  | { readonly format: 'rational' };

export const CALCULATOR_DEFAULT_OUTPUT_POLICY: CalculatorOutputPolicy = {
  format: 'decimal',
  significantDigits: CALCULATOR_LIMITS.maximumResultSignificantDigits,
};

export function presentCalculatorValue({ value, output }: {
  value: CalculatorNumericValue,
  output: CalculatorOutputPolicy,
}): string {
  switch (output.format) {
  case 'decimal':
    if (!Number.isInteger(output.significantDigits)
      || output.significantDigits < 1
      || output.significantDigits > CALCULATOR_LIMITS.maximumResultSignificantDigits) {
      throw new Error(`Invalid calculator output significant digits: ${output.significantDigits}`);
    }
    return serializeDecimal({
      decimal: numericValueToApproximateDecimal({ value, significantDigits: output.significantDigits }),
    });
  case 'rational':
    switch (value.kind) {
    case 'rational': return serializeRational({ rational: value.rational });
    case 'approximate':
      return failCalculatorInput({
        code: 'result_not_rational',
        message: 'The result is approximate and cannot be represented as an exact rational value.',
        span: undefined,
        hint: 'Use decimal output for expressions containing pi, e, tau, or irrational roots.',
      });
    default: {
      const _exhaustive: never = value;
      throw new Error(`Unhandled calculator numeric value: ${String(_exhaustive)}`);
    }
    }
  default: {
    const _exhaustive: never = output;
    throw new Error(`Unhandled calculator output policy: ${String(_exhaustive)}`);
  }
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {};
