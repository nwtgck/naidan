import type { NaidanRpcRegistration } from '@/01-models/naidan-rpc';
import { normalizeNaidanRpcLabel, normalizeNaidanRpcTransport } from '@/01-models/naidan-rpc';
import { idToRaw, toNaidanRpcRegistrationId, toNaidanRpcPeerPublicKey } from '@/01-models/ids';
import { ExperimentalNaidanRpcRegistrationSchemaDto } from '@/00-storage/00-dto/experimental-naidan-rpc.dto';
import type { ExperimentalNaidanRpcRegistrationDto } from '@/00-storage/00-dto/experimental-naidan-rpc.dto';

export function rpcRegistrationToDto({ registration }: { registration: NaidanRpcRegistration }): ExperimentalNaidanRpcRegistrationDto {
  const { id, peerPublicKey, localPublicKey, label, transport, inboundAllowedMethods, connectOnStartup, revision, ...rest } = registration;
  rest satisfies Record<PropertyKey, never>;
  const { type, serverUrl, headers, ...transportRest } = normalizeNaidanRpcTransport({ transport });
  transportRest satisfies Record<PropertyKey, never>;
  // Explicit projection also accepts Vue's nested reactive forms. Never pass
  // their proxies to persistence or structuredClone.
  return ExperimentalNaidanRpcRegistrationSchemaDto.parse({
    version: 2,
    id: idToRaw({ id }),
    peerPublicKey: idToRaw({ id: peerPublicKey }),
    localPublicKey,
    label: normalizeNaidanRpcLabel({ label }),
    transport: { type, serverUrl, headers: headers.map(({ name, value }) => ({ name, value })) },
    inboundAllowedMethods: [...inboundAllowedMethods],
    connectOnStartup,
    revision,
  });
}
export function rpcRegistrationFromDto({ value }: { value: unknown }): NaidanRpcRegistration {
  const { version: _version, id, peerPublicKey, localPublicKey, label, transport, inboundAllowedMethods, connectOnStartup, revision, ...rest } = ExperimentalNaidanRpcRegistrationSchemaDto.parse(value);
  rest satisfies Record<PropertyKey, never>;
  return {
    id: toNaidanRpcRegistrationId({ raw: id }),
    peerPublicKey: toNaidanRpcPeerPublicKey({ raw: peerPublicKey }),
    localPublicKey,
    label: normalizeNaidanRpcLabel({ label }),
    transport: normalizeNaidanRpcTransport({ transport }),
    inboundAllowedMethods,
    connectOnStartup,
    revision,
  };
}
export const TEST_ONLY = {
};
