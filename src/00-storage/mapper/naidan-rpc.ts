import type { NaidanRpcConnection } from '@/01-models/naidan-rpc';
import { normalizeNaidanRpcLabel, normalizeNaidanRpcTransport } from '@/01-models/naidan-rpc';
import { idToRaw, toNaidanRpcConnectionId, toNaidanRpcPeerId } from '@/01-models/ids';
import { ExperimentalNaidanRpcConnectionSchemaDto } from '@/00-storage/00-dto/experimental-naidan-rpc.dto';
import type { ExperimentalNaidanRpcConnectionDto } from '@/00-storage/00-dto/experimental-naidan-rpc.dto';

export function rpcConnectionToDto({ connection }: { connection: NaidanRpcConnection }): ExperimentalNaidanRpcConnectionDto {
  const { id, peerId, localPublicKey, label, transport, allowedMethods, autoConnect, revision, ...rest } = connection;
  rest satisfies Record<PropertyKey, never>;
  const { type, serverUrl, headers, ...transportRest } = normalizeNaidanRpcTransport({ transport });
  transportRest satisfies Record<PropertyKey, never>;
  // Explicit projection also accepts Vue's nested reactive forms. Never pass
  // their proxies to persistence or structuredClone.
  return ExperimentalNaidanRpcConnectionSchemaDto.parse({ version: 1, id: idToRaw({ id }), peerId: idToRaw({ id: peerId }), localPublicKey,
    label: normalizeNaidanRpcLabel({ label }), transport: { type, serverUrl, headers: headers.map(({ name, value }) => ({ name, value })) },
    allowedMethods: [...allowedMethods], autoConnect, revision });
}
export function rpcConnectionFromDto({ value }: { value: unknown }): NaidanRpcConnection {
  const { version: _version, id, peerId, localPublicKey, label, transport, allowedMethods, autoConnect, revision, ...rest } = ExperimentalNaidanRpcConnectionSchemaDto.parse(value);
  rest satisfies Record<PropertyKey, never>;
  return { id: toNaidanRpcConnectionId({ raw: id }), peerId: toNaidanRpcPeerId({ raw: peerId }), localPublicKey,
    label: normalizeNaidanRpcLabel({ label }), transport: normalizeNaidanRpcTransport({ transport }), allowedMethods, autoConnect, revision };
}
export const TEST_ONLY = {
};
