import { describe, expect, it } from 'vitest';
import {
  assertEncryptionPassphraseCanBeUsed,
  validateEncryptionPassphrase,
} from './passphrase';

describe('encryption passphrase validation', () => {
  it('preserves boundary whitespace while reporting it', () => {
    expect(validateEncryptionPassphrase({
      passphrase: ' correct horse battery staple ',
    })).toEqual({ type: 'boundary_whitespace' });
    expect(() => assertEncryptionPassphraseCanBeUsed({
      passphrase: ' correct horse battery staple ',
    })).not.toThrow();
  });

  it.each([
    `\
line one
line two`,
    'line one\rline two',
    'line one\u2028line two',
  ])(
    'rejects line breaks in %j',
    (passphrase) => {
      expect(validateEncryptionPassphrase({ passphrase })).toEqual({
        type: 'line_break',
      });
      expect(() => assertEncryptionPassphraseCanBeUsed({ passphrase }))
        .toThrow('must not contain line breaks');
    },
  );
});
