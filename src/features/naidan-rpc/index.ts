export { NaidanRpcByteBudget } from '@/features/naidan-rpc/byte-budget';
export { createRpcProtocolAdvertisement, validateRpcProtocolAdvertisement } from './protocol-compatibility';
export { ConnectionMaintenance, ConnectionOpenPermits, maintenanceClock } from '@/features/naidan-rpc/connection-maintenance';
export type { ConnectionLease, ConnectionInitiation } from '@/features/naidan-rpc/connection-maintenance';
export { NaidanRpcCallBudget } from '@/features/naidan-rpc/call-budget';
export { NaidanRpcPeer } from '@/features/naidan-rpc/peer';
export type { NaidanRpcLimits } from '@/features/naidan-rpc/peer';
export { contract, procedure, expose, methodNames } from '@/features/naidan-rpc/contract';
export type { NaidanRpcCall, NaidanRpcClient, NaidanRpcImplementation, NaidanRpcExposure, NaidanRpcMethodName } from '@/features/naidan-rpc/contract';
export { rpc } from '@/features/naidan-rpc/schema';
export type { SendValue, ReceiveValue } from '@/features/naidan-rpc/schema';
export { describeMethods, methodDescriptorSchema } from '@/features/naidan-rpc/description';
export type { MethodDescriptor, ValueDescriptor } from '@/features/naidan-rpc/description';
export type { NaidanRpcTransport, NaidanRpcDuplex } from '@/features/naidan-rpc/transport';
export { NaidanRpcError, NaidanRpcPublicError, NaidanRpcProtocolError, describeNaidanRpcError } from '@/features/naidan-rpc/primitives';
export type { NaidanRpcErrorCode, NaidanRpcPublicErrorDetails } from '@/features/naidan-rpc/primitives';
export { VALUE_BYTES as NAIDAN_RPC_MAX_FINITE_VALUE_BYTES } from '@/features/naidan-rpc/primitives';

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
