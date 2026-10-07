import { createNaidanPipingIdentity } from '@/features/naidan-piping-duplex';
import type { NaidanPipingIdentity } from '@/features/naidan-piping-duplex';
import type { NaidanRpcIdentity } from '@/01-models/naidan-rpc';
import { promiseAllKeyed } from '@/utils/promise';

export function encodePeerKey({ bytes }: { bytes: Uint8Array }): string {
  if (bytes.length !== 32) throw new Error('Invalid peer identity length');
  return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}
export function decodePeerKey({ value }: { value: string }): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(value)) throw new Error('Invalid peer identity');
  const bytes = Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/') + '='), char => char.charCodeAt(0));
  if (encodePeerKey({ bytes }) !== value || bytes.every(byte => byte === 0)) throw new Error('Invalid peer identity');
  return bytes;
}
/** Validate the public/private binding rather than trusting a stored label or
 * export. The long-lived private key stays nonextractable. */
export async function restoreRpcIdentity({ identity }: { identity: NaidanRpcIdentity }): Promise<NaidanPipingIdentity> {
  const bytes = decodePeerKey({ value: identity.publicKey });
  const challenge = await crypto.subtle.generateKey({ name: 'X25519' }, false, ['deriveBits']);
  const publicKey = await crypto.subtle.importKey('raw', bytes, { name: 'X25519' }, false, []);
  const { local, remote } = await promiseAllKeyed({
    local: crypto.subtle.deriveBits({ name: 'X25519', public: challenge.publicKey }, identity.privateKey, 256),
    remote: crypto.subtle.deriveBits({ name: 'X25519', public: publicKey }, challenge.privateKey, 256),
  });
  const left = new Uint8Array(local), right = new Uint8Array(remote);
  let difference = 0;
  for (let i = 0; i < left.length; i++) difference |= left[i]! ^ right[i]!;
  left.fill(0); right.fill(0);
  if (difference !== 0) throw new Error('Stored RPC identity does not match its public key');
  return { privateKey: identity.privateKey, publicKey: bytes };
}
export function createRpcIdentityLoader({ read }: { read(): Promise<NaidanRpcIdentity | undefined> }) {
  let loading: Promise<NaidanPipingIdentity> | undefined;
  return {
    load(): Promise<NaidanPipingIdentity> {
    // Invoked by an explicit connection command only, never by component mount.
      if (!loading) {
        const attempt = Promise.resolve().then(async () => {
          const stored = await read();
          return stored ? restoreRpcIdentity({ identity: stored }) : createNaidanPipingIdentity();
        });
        loading = attempt;
        // A failed read/validation is not absence of a saved identity. Do not
        // generate a replacement or retry automatically. Only the next explicit
        // connection command may retry; a successful identity stays pinned.
        void attempt.catch(() => {
          if (loading === attempt) loading = undefined;
        });
      }
      return loading;
    },
  };
}
export const TEST_ONLY = {
};
