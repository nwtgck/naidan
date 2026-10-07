import { expect, it } from 'vitest';
import { isValidRpcPairingCode, normalizeRpcPairingCode, RPC_PAIRING_CODE_MAX_LENGTH } from './pairing-code';

it('allows names, spaces, symbols and Unicode while normalizing surrounding whitespace and NFC', () => {
  expect(normalizeRpcPairingCode({ code: '  cafe\u0301 家 🔌  ' })).toBe('café 家 🔌');
  expect(normalizeRpcPairingCode({ code: 'My PC / 2' })).toBe('My PC / 2');
  expect(normalizeRpcPairingCode({ code: '0' })).toBe('0');
  expect(isValidRpcPairingCode({ code: 'a'.repeat(RPC_PAIRING_CODE_MAX_LENGTH) })).toBe(true);
});

it.each(['', '   ', `\
line
break`, 'a\u0000b', '\ud800', 'a'.repeat(RPC_PAIRING_CODE_MAX_LENGTH + 1)])('rejects invalid meeting input %j before opening a session', code => {
  expect(isValidRpcPairingCode({ code })).toBe(false);
  expect(() => normalizeRpcPairingCode({ code })).toThrow();
});
