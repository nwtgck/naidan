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
  validateRegistrationIdentity({ id: idToRaw({ id }), peerPublicKey: idToRaw({ id: peerPublicKey }), localPublicKey, revision });
  // Explicit projection also accepts Vue's nested reactive forms. Never pass
  // their proxies to persistence or structuredClone.
  return ExperimentalNaidanRpcRegistrationSchemaDto.parse({
    id: idToRaw({ id }),
    peerPublicKey: idToRaw({ id: peerPublicKey }),
    localPublicKey,
    label: normalizeNaidanRpcLabel({ label }),
    transport: { type, serverUrl, headers: headers.map(({ name, value }) => ({ name, value })) },
    inboundAllowedMethods: [...new Set(inboundAllowedMethods)],
    connectOnStartup,
    revision,
  });
}
export function rpcRegistrationFromDto({ value }: { value: unknown }): NaidanRpcRegistration {
  const { id, peerPublicKey, localPublicKey, label, transport, inboundAllowedMethods, connectOnStartup, revision, ...rest } = ExperimentalNaidanRpcRegistrationSchemaDto.parse(value);
  rest satisfies Record<PropertyKey, never>;
  validateRegistrationIdentity({ id, peerPublicKey, localPublicKey, revision });
  return {
    id: toNaidanRpcRegistrationId({ raw: id }),
    peerPublicKey: toNaidanRpcPeerPublicKey({ raw: peerPublicKey }),
    localPublicKey,
    label: normalizeNaidanRpcLabel({ label }),
    transport: normalizeNaidanRpcTransport({ transport }),
    inboundAllowedMethods: [...new Set(inboundAllowedMethods)],
    connectOnStartup,
    revision,
  };
}
/** These are requirements for using identities and revision arithmetic, not
 * additional promises made by the serialized TypeScript shape. Method names
 * remain untrusted strings until the active contract checks local authority. */
function validateRegistrationIdentity({ id, peerPublicKey, localPublicKey, revision }: {
  id: string; peerPublicKey: string; localPublicKey: string; revision: number;
}): void {
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(id)) throw new Error('Invalid RPC registration identity');
  if (![peerPublicKey, localPublicKey].every(key => /^[A-Za-z0-9_-]{43}$/.test(key))) throw new Error('Invalid RPC public key');
  if (!Number.isSafeInteger(revision) || revision < 0 || revision >= Number.MAX_SAFE_INTEGER) throw new Error('Invalid RPC registration revision');
}
export const TEST_ONLY = {
};
