import { encodePersistenceControlUtf8, type FileSystemId } from '@/00-storage/service/hizofs/compatibility';
import { encodePersistenceControlCryptoContext } from './crypto-context-codec';
import { NAIDAN_PERSISTENCE_CONTROL_FORMAT_CRYPTO_CONTEXTS } from './crypto-contracts';

function u64Bytes({ value }: { value: number }): Uint8Array {
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError('control sequence must be a positive safe integer');
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigUint64(0, BigInt(value), false);
  return bytes;
}

export function encodePlainControlDigestContext({ canonicalCoreBytes }: { canonicalCoreBytes: Uint8Array }): Uint8Array {
  return encodePersistenceControlCryptoContext({
    domain: NAIDAN_PERSISTENCE_CONTROL_FORMAT_CRYPTO_CONTEXTS.plainControlDigest.domain,
    fields: [Uint8Array.from(canonicalCoreBytes)],
  });
}

export function encodePersistenceControlKeyContext({ authenticationFileSystemId, copy, sequence }: {
  authenticationFileSystemId: FileSystemId;
  copy: 0 | 1;
  sequence: number;
}): Uint8Array {
  return encodePersistenceControlCryptoContext({
    domain: NAIDAN_PERSISTENCE_CONTROL_FORMAT_CRYPTO_CONTEXTS.persistenceControlKey.domain,
    fields: [encodePersistenceControlUtf8({ value: authenticationFileSystemId }), Uint8Array.of(copy), u64Bytes({ value: sequence })],
  });
}

export function encodePersistenceControlAad({ canonicalUnsignedProtectedControlBytes }: {
  canonicalUnsignedProtectedControlBytes: Uint8Array;
}): Uint8Array {
  return encodePersistenceControlCryptoContext({
    domain: NAIDAN_PERSISTENCE_CONTROL_FORMAT_CRYPTO_CONTEXTS.persistenceControlAad.domain,
    fields: [Uint8Array.from(canonicalUnsignedProtectedControlBytes)],
  });
}

export const TEST_ONLY = {
  u64Bytes,
};
