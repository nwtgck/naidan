import { CalculatorInputFailure, formatCalculatorDiagnostic, failCalculatorInput } from './diagnostics';
import type { CalculatorDiagnostic } from './diagnostics';
import { evaluateCalculatorExpression } from './evaluate';
import { formatCalculatorNumber } from './format-number';
import { resolveCalculatorHelp } from './help';
import { CALCULATOR_LIMITS } from './limits';
import { parseCalculatorTokens } from './parse';
import { tokenizeCalculatorInput } from './tokenize';

export const CALCULATOR_MAX_INPUT_LENGTH = CALCULATOR_LIMITS.maximumInputLength;

export type CalculatorRunResult =
  | {
      readonly status: 'success',
      readonly output:
        | {
            readonly kind: 'value',
            readonly value: number,
            readonly text: string,
          }
        | {
            readonly kind: 'help',
            readonly topic: string,
            readonly text: string,
          },
    }
  | {
      readonly status: 'error',
      readonly diagnostic: CalculatorDiagnostic,
      readonly text: string,
    };

function ensureCalculatorInputAllowed({ input }: { input: string }): void {
  if (input.trim().length === 0) {
    failCalculatorInput({
      code: 'empty_input',
      message: 'The calculator input is empty.',
      span: undefined,
      hint: 'Enter an expression or evaluate `help`.',
    });
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

export function runCalculator({ input }: { input: string }): CalculatorRunResult {
  try {
    ensureCalculatorInputAllowed({ input });
    const helpResolution = resolveCalculatorHelp({ input });
    switch (helpResolution.status) {
    case 'not_help':
      break;
    case 'success':
      return {
        status: 'success',
        output: {
          kind: 'help',
          topic: helpResolution.topic,
          text: helpResolution.text,
        },
      };
    default: {
      const _exhaustive: never = helpResolution;
      throw new Error(`Unhandled calculator help result: ${String(_exhaustive)}`);
    }
    }

    const tokens = tokenizeCalculatorInput({ input });
    const expression = parseCalculatorTokens({ tokens });
    const value = evaluateCalculatorExpression({ expression });
    return {
      status: 'success',
      output: {
        kind: 'value',
        value,
        text: formatCalculatorNumber({ value }),
      },
    };
  } catch (error) {
    if (!(error instanceof CalculatorInputFailure)) throw error;
    return {
      status: 'error',
      diagnostic: error.diagnostic,
      text: formatCalculatorDiagnostic({
        source: input,
        diagnostic: error.diagnostic,
      }),
    };
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = { ensureCalculatorInputAllowed };
