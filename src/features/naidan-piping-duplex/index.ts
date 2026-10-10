export type { NaidanPipingConnectionEnd, NaidanPipingConnectionEndKind } from '@/features/naidan-piping-duplex/lifetime';
export { HandshakeResponseUnconfirmedError, ResponseUnconfirmedError, RecordExhaustedError, PipingRetirementError } from '@/features/naidan-piping-duplex/lifetime';
export type { NaidanPipingPeerVerifier } from '@/features/naidan-piping-duplex/key-context';
export { NaidanPipingDuplexSession } from '@/features/naidan-piping-duplex/naidan-piping-duplex-session';
export type { NaidanPipingDuplexOptions, PreparedPinnedConnection } from '@/features/naidan-piping-duplex/naidan-piping-duplex-session';
export type { MultiplexedStream as NaidanPipingDuplexStream } from '@/features/naidan-piping-duplex/stream-mux';
export { createNaidanPipingIdentity } from '@/features/naidan-piping-duplex/noise-xx';
export type { NaidanPipingIdentity } from '@/features/naidan-piping-duplex/noise-xx';
export { createNaidanPipingCode } from '@/features/naidan-piping-duplex/rendezvous';
export { establishNaidanPipingKeys } from '@/features/naidan-piping-duplex/key-context';
export type { NaidanPipingKeyContext, NaidanPipingKeyDomain, NaidanPipingHandshakeChannel,
  NaidanPipingDirection } from '@/features/naidan-piping-duplex/key-context';
export type { NaidanPipingRole } from '@/features/naidan-piping-duplex/role';
export type { ConnectionHealth as NaidanPipingConnectionHealth, LivenessOptions as NaidanPipingLivenessOptions } from '@/features/naidan-piping-duplex/ordered-session';

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
