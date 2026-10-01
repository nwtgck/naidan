// Standalone key-establishment entrypoint; no Piping or stream state dependency.
export { createNaidanPipingIdentity } from '@/features/naidan-piping-duplex/noise-xx';
export type { NaidanPipingIdentity } from '@/features/naidan-piping-duplex/noise-xx';
export { establishNaidanPipingKeys } from '@/features/naidan-piping-duplex/key-context';
export type { NaidanPipingKeyContext, NaidanPipingKeyDomain, NaidanPipingHandshakeChannel, NaidanPipingDirection } from '@/features/naidan-piping-duplex/key-context';
export type { NaidanPipingRole } from '@/features/naidan-piping-duplex/role';

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
