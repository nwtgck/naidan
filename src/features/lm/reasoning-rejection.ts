import { UnsupportedReasoningError } from '@/01-models/lm-errors';
import { z } from 'zod';

const ErrorEnvelopeSchema = z.object({
  error: z.union([
    z.string(),
    z.object({
      message: z.string(),
      param: z.string().nullish(),
      code: z.string().nullish(),
    }),
  ]),
});

/** Only parameter-validation rejections are safe to retry without thinking off. */
export async function isReasoningRejection({ response, parameter }: {
  response: Response,
  parameter: 'reasoning_effort' | 'think',
}): Promise<boolean> {
  if (response.status !== 400 && response.status !== 422) return false;
  try {
    return isReasoningErrorEnvelope({ value: await response.clone().json(), parameter });
  } catch {
    return false;
  }
}

/** Some endpoints report a validation failure as the first streaming event. */
export function isReasoningErrorEnvelope({ value, parameter }: {
  value: unknown,
  parameter: 'reasoning_effort' | 'think',
}): boolean {
  const parsed = ErrorEnvelopeSchema.safeParse(value);
  if (!parsed.success) return false;
  const error = parsed.data.error;
  const message = typeof error === 'string' ? error : error.message;
  if (typeof error !== 'string' && error.code != null && ![
    'unsupported_parameter', 'unsupported_value', 'invalid_request_error',
    'invalid_value', 'invalid_parameter', 'invalid_enum_value', 'invalid_type', 'invalid_argument',
  ].includes(error.code)) return false;
  if (typeof error !== 'string' && error.param != null) {
    if (error.param !== parameter) return false;
    if (error.code === 'unsupported_parameter' || error.code === 'unsupported_value') return true;
  }
  const namesControl = (() => {
    switch (parameter) {
    case 'think': return /\bthink(?:ing)?\b/i.test(message);
    case 'reasoning_effort': return /\breasoning_effort\b/i.test(message);
    default: { const exhaustive: never = parameter; throw new Error(String(exhaustive)); }
    }
  })();
  return namesControl && /not supported|does not support|do not support|unsupported|unknown (?:parameter|field)|unrecognized (?:parameter|field)|cannot (?:be )?disabled|only supports?/i.test(message);
}

/** Classify only a template-rendering rejection, never an inference failure. */
export function renderThinkingTemplate<T>({ offRequested, render }: {
  offRequested: boolean,
  render: () => T,
}): T {
  try {
    return render();
  } catch (error) {
    // Even a trap whose message mentions thinking is a runtime failure, not a
    // safe parameter rejection. Do not reuse that native runtime for a retry.
    if (error instanceof WebAssembly.RuntimeError) throw error;
    if (offRequested && error instanceof Error
      && /\b(?:enable_thinking|thinking|reasoning_effort)\b/i.test(error.message)
      && /not supported|does not support|unsupported|cannot (?:be )?disable|can(?:not|'t) disable|must be (?:enabled|true)|only supports?/i.test(error.message)) {
      throw new UnsupportedReasoningError({ message: error.message });
    }
    throw error;
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
export const TEST_ONLY = {
};
