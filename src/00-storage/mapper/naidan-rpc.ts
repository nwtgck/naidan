import type { NaidanRpcConnection } from '@/01-models/naidan-rpc';
import { idToRaw, toNaidanRpcConnectionId, toNaidanRpcPeerId } from '@/01-models/ids';
import { rpcConnectionSchema } from '@/00-storage/00-dto/naidan-rpc.dto';
import type { RpcConnectionDto } from '@/00-storage/00-dto/naidan-rpc.dto';

export function rpcConnectionToDto({ connection }: { connection: NaidanRpcConnection }): RpcConnectionDto {
  const { id, peerId, localPublicKey, label, transport, allowedMethods, revision, ...rest } = connection;
  rest satisfies Record<PropertyKey, never>;
  const { type, serverUrl, headers, ...transportRest } = transport;
  transportRest satisfies Record<PropertyKey, never>;
  // Explicit projection also accepts Vue's nested reactive forms. Never pass
  // their proxies to IndexedDB or structuredClone.
  return rpcConnectionSchema.parse({ version: 1, id: idToRaw({ id }), peerId: idToRaw({ id: peerId }), localPublicKey,
    label, transport: { type, serverUrl, headers: headers.map(({ name, value }) => ({ name, value })) },
    allowedMethods: [...allowedMethods], revision });
}
export function rpcConnectionFromDto({ value }: { value: unknown }): NaidanRpcConnection {
  const { version: _version, id, peerId, localPublicKey, label, transport, allowedMethods, revision, ...rest } = rpcConnectionSchema.parse(value);
  rest satisfies Record<PropertyKey, never>;
  return { id: toNaidanRpcConnectionId({ raw: id }), peerId: toNaidanRpcPeerId({ raw: peerId }), localPublicKey,
    label, transport, allowedMethods, revision };
}
export const TEST_ONLY = {
};
