import type { NaidanRpcConnectionId, NaidanRpcPeerId } from './ids';
import { restrictedFetchHeadersSchema } from '@/utils/restricted-fetch-headers';

export type NaidanRpcTransportSettings = {
  type: 'naidan_piping_duplex',
  serverUrl: string,
  headers: readonly { name: string, value: string }[],
};
export type NaidanRpcIdentity = { privateKey: CryptoKey, publicKey: string };
/** Stored names are untrusted strings until the peer contract validates them.
 * No credentials or identity keys are included in ordinary settings exports. */
export type NaidanRpcConnection = {
  id: NaidanRpcConnectionId,
  peerId: NaidanRpcPeerId,
  localPublicKey: string,
  label: string,
  transport: NaidanRpcTransportSettings,
  allowedMethods: readonly string[],
  autoConnect: 'disabled' | 'enabled',
  revision: number,
};
export function normalizeNaidanRpcTransport({ transport }: { transport: NaidanRpcTransportSettings }): NaidanRpcTransportSettings {
  const { type, serverUrl, headers, ...rest } = transport;
  rest satisfies Record<PropertyKey, never>;
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
  return { type, serverUrl: url.origin, headers: restrictedFetchHeadersSchema.parse(headers) };
}
export function normalizeNaidanRpcLabel({ label }: { label: string }): string {
  const normalized = label.trim();
  if (!normalized || normalized.length > 100) throw new Error('Invalid RPC connection label');
  return normalized;
}
export const TEST_ONLY = {
};
