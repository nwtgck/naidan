import type { NaidanRpcConnectionId, NaidanRpcPeerId } from './ids';

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
  revision: number,
};
export const TEST_ONLY = {
};
