import {
  encodePersistenceControlUtf8,
  type FileSystemId,
} from '@/00-storage/service/hizofs/compatibility';
import type { TransitionOperationId } from '@/00-storage/service/naidan-persistence-control/00-format/canonical-json/persistence-control';
import type { TransitionProgressCopy } from '@/00-storage/service/naidan-persistence-control/00-format/canonical-json/transition-progress';
import { encodeNaidanPersistenceCryptoContext } from '@/00-storage/service/naidan-persistence-control/00-format/crypto-context-codec';
import { NAIDAN_TRANSITION_PROGRESS_FORMAT_CONSTANTS } from '@/00-storage/service/naidan-persistence-control/00-format/transition-progress-format-constants';

function u64Bytes({ value }: { value: number }): Uint8Array {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError('transition-progress sequence is outside UInt64');
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigUint64(0, BigInt(value), false);
  return bytes;
}

export function encodeTransitionProgressKeyContext({ authenticationFileSystemId, copy, operationId, sequence }: {
  authenticationFileSystemId: FileSystemId;
  copy: TransitionProgressCopy;
  operationId: TransitionOperationId;
  sequence: number;
}): Uint8Array {
  return encodeNaidanPersistenceCryptoContext({
    domain: NAIDAN_TRANSITION_PROGRESS_FORMAT_CONSTANTS.crypto.keyDomain,
    expectedFields: 4,
    fields: [
      encodePersistenceControlUtf8({ value: authenticationFileSystemId }),
      Uint8Array.of(copy),
      u64Bytes({ value: sequence }),
      encodePersistenceControlUtf8({ value: operationId }),
    ],
    maximumFieldBytes: NAIDAN_TRANSITION_PROGRESS_FORMAT_CONSTANTS.limits.companionJsonBytes,
  });
}

export function encodeTransitionProgressAad({ canonicalUnsignedEnvelopeBytes }: {
  canonicalUnsignedEnvelopeBytes: Uint8Array;
}): Uint8Array {
  return encodeNaidanPersistenceCryptoContext({
    domain: NAIDAN_TRANSITION_PROGRESS_FORMAT_CONSTANTS.crypto.aadDomain,
    expectedFields: 1,
    fields: [Uint8Array.from(canonicalUnsignedEnvelopeBytes)],
    maximumFieldBytes: NAIDAN_TRANSITION_PROGRESS_FORMAT_CONSTANTS.limits.companionJsonBytes,
  });
}

export const TEST_ONLY = {
  u64Bytes,
};
