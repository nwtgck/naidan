import { z } from 'zod';
import type { DtoLeaf } from '@/utils/dtozod';

/** Structured-clone persistence contains a real CryptoKey, not JSON. Keep the
 * runtime type check at this narrow boundary without exposing dtozod.custom or
 * a generic fromZod/unwrap. Key algorithm, usages and trust policy stay with
 * the identity owner in naidan-rpc-identity.ts, not the persisted DTO. */
const nativeCryptoKeySchema = z.custom<CryptoKey>(
  value => typeof CryptoKey !== 'undefined' && value instanceof CryptoKey,
);

// Derive both input and output from the native signature; widening the input
// to unknown here would silently change z.input<typeof IdentitySchemaDto>.
export const CryptoKeySchemaDto = nativeCryptoKeySchema as unknown as DtoLeaf<typeof nativeCryptoKeySchema>;

export const TEST_ONLY = {
};
