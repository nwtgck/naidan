import { CalculatorInputFailure, formatCalculatorDiagnostic, failCalculatorInput } from './diagnostics';
import type { CalculatorDiagnostic } from './diagnostics';
import { evaluateCalculatorExpression } from './evaluate';
import { resolveCalculatorHelp } from './help';
import { CALCULATOR_LIMITS } from './limits';
import { NumericLimitError } from './numeric/numeric-limit-error';
import { parseCalculatorTokens } from './parse';
import { CALCULATOR_DEFAULT_OUTPUT_POLICY, presentCalculatorValue, type CalculatorOutputPolicy } from './result-presentation';
import { tokenizeCalculatorInput } from './tokenize';

export const CALCULATOR_MAX_INPUT_LENGTH = CALCULATOR_LIMITS.maximumInputLength;
export const CALCULATOR_MAX_RESULT_SIGNIFICANT_DIGITS = CALCULATOR_LIMITS.maximumResultSignificantDigits;
export const CALCULATOR_DEFAULT_RESULT_SIGNIFICANT_DIGITS = CALCULATOR_LIMITS.defaultToolSignificantDigits;

export type CalculatorRunResult =
  | {
      readonly status: 'success',
      readonly output:
        | { readonly kind: 'value', readonly exactness: 'rational' | 'approximate', readonly text: string }
        | { readonly kind: 'help', readonly topic: string, readonly text: string },
    }
  | { readonly status: 'error', readonly diagnostic: CalculatorDiagnostic, readonly text: string };

function ensureCalculatorInputAllowed({ input }: { input: string }): void {
  if (input.trim().length === 0) {
    failCalculatorInput({ code: 'empty_input', message: 'The calculator input is empty.', span: undefined, hint: 'Enter an expression or evaluate `help`.' });
  }
  if (input.length > CALCULATOR_LIMITS.maximumInputLength) {
    failCalculatorInput({
      code: 'input_too_long',
      message: `The calculator input exceeds the maximum length of ${CALCULATOR_LIMITS.maximumInputLength}.`,
      span: { start: CALCULATOR_LIMITS.maximumInputLength, end: input.length },
      hint: 'Split the calculation into smaller expressions.',
    });
  }
}

export function runCalculator({ input, output = CALCULATOR_DEFAULT_OUTPUT_POLICY }: {
  input: string,
  output?: CalculatorOutputPolicy,
}): CalculatorRunResult {
  try {
    ensureCalculatorInputAllowed({ input });
    const helpResolution = resolveCalculatorHelp({ input });
    switch (helpResolution.status) {
    case 'success':
      return { status: 'success', output: { kind: 'help', topic: helpResolution.topic, text: helpResolution.text } };
    case 'not_help':
      break;
    default: {
      const _exhaustive: never = helpResolution;
      throw new Error(`Unhandled calculator help resolution: ${String(_exhaustive)}`);
    }
    }
    const tokens = tokenizeCalculatorInput({ input });
    const expression = parseCalculatorTokens({ tokens });
    const value = evaluateCalculatorExpression({ expression });
    return {
      status: 'success',
      output: { kind: 'value', exactness: value.kind, text: presentCalculatorValue({ value, output }) },
    };
  } catch (error) {
    if (error instanceof NumericLimitError) {
      const diagnostic: CalculatorDiagnostic = {
        code: 'limit_exceeded', message: error.message, span: undefined, hint: 'Use smaller values or a simpler expression.',
      };
      return { status: 'error', diagnostic, text: formatCalculatorDiagnostic({ source: input, diagnostic }) };
    }
    if (!(error instanceof CalculatorInputFailure)) throw error;
    return {
      status: 'error',
      diagnostic: error.diagnostic,
      text: formatCalculatorDiagnostic({ source: input, diagnostic: error.diagnostic }),
    };
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = { ensureCalculatorInputAllowed };
