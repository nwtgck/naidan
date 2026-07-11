import type { PassphraseValidationResult } from './types';

const LINE_BREAK_PATTERN = /[\r\n\u0085\u2028\u2029]/u;
const BOUNDARY_WHITESPACE_PATTERN = /^\s|\s$/u;

export function validateEncryptionPassphrase({
  passphrase,
}: {
  passphrase: string,
}): PassphraseValidationResult {
  if (LINE_BREAK_PATTERN.test(passphrase)) {
    return { type: 'line_break' };
  }
  if (BOUNDARY_WHITESPACE_PATTERN.test(passphrase)) {
    return { type: 'boundary_whitespace' };
  }
  return { type: 'valid' };
}

export function assertEncryptionPassphraseCanBeUsed({
  passphrase,
}: {
  passphrase: string,
}): void {
  const result = validateEncryptionPassphrase({ passphrase });
  switch (result.type) {
  case 'valid':
  case 'boundary_whitespace':
    return;
  case 'line_break':
    throw new Error('Encryption passphrase must not contain line breaks');
  default: {
    const _ex: never = result;
    throw new Error(`Unhandled passphrase validation result: ${String(_ex)}`);
  }
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
  BOUNDARY_WHITESPACE_PATTERN,
  LINE_BREAK_PATTERN,
};
