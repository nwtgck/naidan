import { Secret } from '@/utils/secret';
import type { NaidanRpcRegistration, NaidanRpcTransportSettings } from '@/01-models/naidan-rpc';
import { idToRaw, toNaidanRpcRegistrationId, toNaidanRpcPeerPublicKey } from '@/01-models/ids';
import { ExperimentalNaidanRpcRegistrationDtoSchema } from '@/00-format/00-dto/experimental-naidan-rpc.dto';
import type { ExperimentalNaidanRpcRegistrationDto } from '@/00-format/00-dto/experimental-naidan-rpc.dto';

// The original persisted RPC registry accepts these header values.
const storedRpcBlockedHeaders = new Set(['host', 'origin', 'referer', 'cookie', 'cookie2', 'content-length', 'transfer-encoding', 'connection', 'upgrade', 'te', 'trailer', 'expect', 'accept-encoding', 'access-control-request-method', 'access-control-request-headers']);

function validateStoredRpcHeaders({ headers }: { headers: NaidanRpcTransportSettings['headers'] }): void {
  const names = new Set<string>();
  let size = 0;
  if (headers.length > 32) {
    throw new Error('Invalid RPC transport headers');
  }
  for (const { name, value } of headers) {
    const raw = value.reveal();
    const lowerName = name.toLowerCase();
    size += name.length + raw.length;
    if (name.length > 128 || raw.length > 8192 || size > 16384 ||
        !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) ||
        /[^\t\x20-\x7e\x80-\xff]/.test(raw) ||
        storedRpcBlockedHeaders.has(lowerName) || lowerName.startsWith('sec-') ||
        lowerName.startsWith('proxy-') || names.has(lowerName)) {
      throw new Error('Invalid RPC transport headers');
    }
    names.add(lowerName);
  }
}

export function normalizeNaidanRpcTransport({ transport }: { transport: NaidanRpcTransportSettings }): NaidanRpcTransportSettings {
  const { type, serverUrl, headers, ...rest } = transport;
  rest satisfies Record<PropertyKey, never>;
  switch (type) {
  case 'naidan_piping_duplex': break;
  default: {
    const exhaustive: never = type;
    void exhaustive;
    throw new Error('Unsupported RPC transport');
  }
  }
  let url: URL;
  try {
    url = new URL(serverUrl);
  } catch {
    throw new Error('Use an HTTPS server origin or a loopback HTTP origin');
  }
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/' ||
      (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) {
    throw new Error('Use an HTTPS server origin or a loopback HTTP origin');
  }
  // Validation errors must not carry a raw credential as diagnostic input.
  validateStoredRpcHeaders({ headers });
  return { type, serverUrl: url.origin, headers: headers.map(({ name, value }) => ({ name, value })) };
}

function normalizeNaidanRpcLabel({ label }: { label: string }): string {
  const normalized = label.trim();
  if (!normalized || normalized.length > 100) {
    throw new Error('Invalid RPC registration label');
  }
  return normalized;
}

export function rpcRegistrationToDto({ registration }: { registration: NaidanRpcRegistration }): ExperimentalNaidanRpcRegistrationDto {
  const { id, peerPublicKey, localPublicKey, label, transport, inboundAllowedMethods, connectOnStartup, revision, ...rest } = registration;
  rest satisfies Record<PropertyKey, never>;
  const { type, serverUrl, headers, ...transportRest } = normalizeNaidanRpcTransport({ transport });
  transportRest satisfies Record<PropertyKey, never>;
  validateRegistrationIdentity({ id: idToRaw({ id }), peerPublicKey: idToRaw({ id: peerPublicKey }), localPublicKey, revision });
  // Explicit projection also accepts Vue's nested reactive forms. Never pass
  // their proxies to persistence or structuredClone.
  return ExperimentalNaidanRpcRegistrationDtoSchema.parse({
    id: idToRaw({ id }),
    peerPublicKey: idToRaw({ id: peerPublicKey }),
    localPublicKey,
    label: normalizeNaidanRpcLabel({ label }),
    transport: { type, serverUrl, headers: headers.map(({ name, value }) => ({ name, value: value.reveal() })) },
    inboundAllowedMethods: [...new Set(inboundAllowedMethods)],
    connectOnStartup,
    revision,
  });
}

export function rpcRegistrationFromDto({ value }: { value: unknown }): NaidanRpcRegistration {
  const { id, peerPublicKey, localPublicKey, label, transport, inboundAllowedMethods, connectOnStartup, revision, ...rest } = ExperimentalNaidanRpcRegistrationDtoSchema.parse(value);
  rest satisfies Record<PropertyKey, never>;
  validateRegistrationIdentity({ id, peerPublicKey, localPublicKey, revision });
  return {
    id: toNaidanRpcRegistrationId({ raw: id }),
    peerPublicKey: toNaidanRpcPeerPublicKey({ raw: peerPublicKey }),
    localPublicKey,
    label: normalizeNaidanRpcLabel({ label }),
    transport: normalizeNaidanRpcTransport({ transport: { ...transport, headers: transport.headers.map(({ name, value }) => ({ name, value: Secret.from({ value }) })) } }),
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
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(id)) {
    throw new Error('Invalid RPC registration identity');
  }
  if (![peerPublicKey, localPublicKey].every(key => /^[A-Za-z0-9_-]{43}$/.test(key))) {
    throw new Error('Invalid RPC public key');
  }
  if (!Number.isSafeInteger(revision) || revision < 0 || revision >= Number.MAX_SAFE_INTEGER) {
    throw new Error('Invalid RPC registration revision');
  }
}

export const TEST_ONLY = {
};
