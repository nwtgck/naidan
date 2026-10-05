export { NaidanRpcPeer } from '@/features/naidan-rpc/peer';
export type { NaidanRpcLimits } from '@/features/naidan-rpc/peer';
export { contract, procedure, expose, methodNames } from '@/features/naidan-rpc/contract';
export type { NaidanRpcCall, NaidanRpcClient, NaidanRpcImplementation, NaidanRpcExposure, NaidanRpcMethodName } from '@/features/naidan-rpc/contract';
export { rpc } from '@/features/naidan-rpc/schema';
export type { SendValue, ReceiveValue } from '@/features/naidan-rpc/schema';
export type { NaidanRpcTransport, NaidanRpcDuplex } from '@/features/naidan-rpc/transport';
export { NaidanRpcError } from '@/features/naidan-rpc/primitives';
export type { NaidanRpcErrorCode } from '@/features/naidan-rpc/primitives';

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
