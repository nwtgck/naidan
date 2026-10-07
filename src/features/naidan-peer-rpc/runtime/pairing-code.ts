export const RPC_PAIRING_CODE_MAX_LENGTH = 128;

export function normalizeRpcPairingCode({ code }: { code: string }): string {
  if (code.length > RPC_PAIRING_CODE_MAX_LENGTH) throw new Error('Pairing code is too long');
  const normalized = code.trim().normalize('NFC');
  if (!normalized || /[\p{Cc}\p{Cs}]/u.test(normalized)) throw new Error('Enter a pairing code without control characters');
  return normalized;
}
export function isValidRpcPairingCode({ code }: { code: string }): boolean {
  try {
    normalizeRpcPairingCode({ code });
    return true;
  } catch {
    return false;
  }
}
export const TEST_ONLY = {
};
