import { Secret } from '@/utils/secret';
import type { NaidanRpcRegistrationId, NaidanRpcPeerPublicKey } from './ids';
import { restrictedFetchHeadersSchema } from '@/utils/restricted-fetch-headers';

export type NaidanRpcTransportSettings = {
  type: 'naidan_piping_duplex',
  serverUrl: string,
  headers: readonly { name: string, value: Secret<string> }[],
};
export type NaidanRpcIdentity = { privateKey: CryptoKey, publicKey: string };
/** Stored names are untrusted strings until the peer contract validates them.
 * No credentials or identity keys are included in ordinary settings exports. */
export type NaidanRpcRegistration = {
  id: NaidanRpcRegistrationId,
  peerPublicKey: NaidanRpcPeerPublicKey,
  localPublicKey: string,
  label: string,
  transport: NaidanRpcTransportSettings,
  inboundAllowedMethods: readonly string[],
  connectOnStartup: 'disabled' | 'enabled',
  revision: number,
};

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
  const parsed = restrictedFetchHeadersSchema.safeParse(headers.map(({ name, value }) => ({ name, value: value.reveal() })));
  if (!parsed.success) {
    throw new Error('Invalid RPC transport headers');
  }
  return { type, serverUrl: url.origin, headers: parsed.data.map(({ name, value }) => ({ name, value: Secret.from({ value }) })) };
}

export function normalizeNaidanRpcLabel({ label }: { label: string }): string {
  const normalized = label.trim();
  if (!normalized || normalized.length > 100) {
    throw new Error('Invalid RPC registration label');
  }
  return normalized;
}

export function areNaidanRpcTransportsEqual({ left, right }: { left: NaidanRpcTransportSettings, right: NaidanRpcTransportSettings }): boolean {
  const { type: leftType, serverUrl: leftUrl, headers: leftHeaders, ...leftRest } = left;
  const { type: rightType, serverUrl: rightUrl, headers: rightHeaders, ...rightRest } = right;
  leftRest satisfies Record<PropertyKey, never>;
  rightRest satisfies Record<PropertyKey, never>;
  return leftType === rightType && leftUrl === rightUrl && leftHeaders.length === rightHeaders.length
    && leftHeaders.every((leftHeader, index) => {
      const rightHeader = rightHeaders[index];
      if (rightHeader === undefined) {
        return false;
      }
      const { name: leftName, value: leftValue, ...leftHeaderRest } = leftHeader;
      const { name: rightName, value: rightValue, ...rightHeaderRest } = rightHeader;
      leftHeaderRest satisfies Record<PropertyKey, never>;
      rightHeaderRest satisfies Record<PropertyKey, never>;
      return leftName === rightName && Secret.equals(leftValue, rightValue);
    });
}

export function areNaidanRpcRegistrationsEqual({ left, right }: { left: NaidanRpcRegistration, right: NaidanRpcRegistration }): boolean {
  const { id: leftId, peerPublicKey: leftPeer, localPublicKey: leftLocal, label: leftLabel, transport: leftTransport, inboundAllowedMethods: leftMethods, connectOnStartup: leftStartup, revision: leftRevision, ...leftRest } = left;
  const { id: rightId, peerPublicKey: rightPeer, localPublicKey: rightLocal, label: rightLabel, transport: rightTransport, inboundAllowedMethods: rightMethods, connectOnStartup: rightStartup, revision: rightRevision, ...rightRest } = right;
  leftRest satisfies Record<PropertyKey, never>;
  rightRest satisfies Record<PropertyKey, never>;
  return leftId === rightId && leftPeer === rightPeer && leftLocal === rightLocal && leftLabel === rightLabel
    && leftStartup === rightStartup && leftRevision === rightRevision
    && areNaidanRpcTransportsEqual({ left: leftTransport, right: rightTransport })
    && leftMethods.length === rightMethods.length && leftMethods.every((method, index) => method === rightMethods[index]);
}

export const TEST_ONLY = {
};
