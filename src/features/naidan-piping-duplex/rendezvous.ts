import { requireValue } from '@/features/naidan-piping-duplex/bytes';

const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export function createNaidanPipingCode(): string {
  const random = crypto.getRandomValues(new Uint8Array(8));
  const code = Array.from(random, byte => alphabet[byte & 31]).join('');
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}
export function normalizeRendezvousCode({ code }: { code: string }): string {
  if (/^peer-[0-9a-f]{64}$/.test(code)) return code;
  if (/^[0-9]{4,8}$/.test(code)) return code;
  requireValue({ condition: /^[0-9A-Za-z]{4}-?[0-9A-Za-z]{4}$/.test(code), message: 'Invalid rendezvous code shape' });
  const normalized = code.toUpperCase().replace('-', '');
  requireValue({ condition: [...normalized].every(character => alphabet.includes(character)), message: 'Invalid rendezvous alphabet' });
  return normalized;
}

export const TEST_ONLY = {
};
