import {
  decodePersistenceControlBase64Url,
  encodePersistenceControlBase64Url,
  type FileSystemId,
} from '@/00-storage/service/hizofs/compatibility';
import {
  encodeTransitionProgressAad,
  encodeTransitionProgressEnvelope,
  encodeTransitionProgressKeyContext,
  encodeTransitionProgressPlaintext,
  encodeUnsignedTransitionProgressEnvelope,
  decodeTransitionProgressPlaintext,
  type NaidanTransitionProgressEnvelopeV1,
  type TransitionOperationId,
  type TransitionProgressCopy,
  type TransitionProgressPayloadV1,
} from '@/00-storage/service/naidan-persistence-control/00-format';
import { NAIDAN_TRANSITION_PROGRESS_FORMAT_CONSTANTS } from '@/00-storage/service/naidan-persistence-control/00-format/transition-progress-format-constants';
import type {
  PersistenceControlRandomSource,
  PersistenceControlRootKeyDerivationCapability,
} from '@/00-storage/service/naidan-persistence-control/crypto/control-protection';

function defaultRandomSource({ bytes }: { bytes: Uint8Array }): void {
  const owned = new Uint8Array(bytes.byteLength);
  globalThis.crypto.getRandomValues(owned);
  bytes.set(owned);
}

function toExactArrayBuffer({ bytes }: { bytes: Uint8Array }): ArrayBuffer {
  const result = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(result).set(bytes);
  return result;
}

function isAeadAuthenticationFailure({ cause }: { cause: unknown }): boolean {
  return typeof cause === 'object' && cause !== null && 'name' in cause && cause.name === 'OperationError';
}

function cryptographicMaterial({ envelope }: { envelope: Omit<NaidanTransitionProgressEnvelopeV1, 'ciphertext'> }): {
  aad: Uint8Array;
  info: Uint8Array;
} {
  return {
    aad: encodeTransitionProgressAad({
      canonicalUnsignedEnvelopeBytes: encodeUnsignedTransitionProgressEnvelope({ envelope }),
    }),
    info: encodeTransitionProgressKeyContext({
      authenticationFileSystemId: envelope.authenticationFileSystemId,
      copy: envelope.copy,
      operationId: envelope.operationId,
      sequence: envelope.sequence,
    }),
  };
}

export async function protectTransitionProgress({ authenticationFileSystemId, copy, operationId, payload, randomSource, rootKey, sequence }: {
  authenticationFileSystemId: FileSystemId;
  copy: TransitionProgressCopy;
  operationId: TransitionOperationId;
  payload: TransitionProgressPayloadV1;
  randomSource: PersistenceControlRandomSource | undefined;
  rootKey: PersistenceControlRootKeyDerivationCapability;
  sequence: number;
}): Promise<NaidanTransitionProgressEnvelopeV1> {
  const nonceBytes = new Uint8Array(NAIDAN_TRANSITION_PROGRESS_FORMAT_CONSTANTS.crypto.nonceBytes);
  (randomSource ?? defaultRandomSource)({ bytes: nonceBytes });
  const unsigned: Omit<NaidanTransitionProgressEnvelopeV1, 'ciphertext'> = {
    authenticationFileSystemId,
    copy,
    format: 'naidan-transition-progress',
    formatVersion: 1,
    nonce: encodePersistenceControlBase64Url({ bytes: nonceBytes }),
    operationId,
    providerKind: 'hizofs',
    sequence,
  };
  const material = cryptographicMaterial({ envelope: unsigned });
  const key = await rootKey.deriveAesGcmKey({ info: material.info });
  const plaintext = encodeTransitionProgressPlaintext({ payload });
  const encrypted = new Uint8Array(await globalThis.crypto.subtle.encrypt(
    {
      additionalData: toExactArrayBuffer({ bytes: material.aad }),
      iv: toExactArrayBuffer({ bytes: nonceBytes }),
      name: 'AES-GCM',
      tagLength: 128,
    },
    key,
    toExactArrayBuffer({ bytes: plaintext }),
  ));
  const envelope: NaidanTransitionProgressEnvelopeV1 = {
    ...unsigned,
    ciphertext: encodePersistenceControlBase64Url({ bytes: encrypted }),
  };
  encodeTransitionProgressEnvelope({ envelope });
  return envelope;
}

export async function openProtectedTransitionProgress({ envelope, rootKey }: {
  envelope: NaidanTransitionProgressEnvelopeV1;
  rootKey: PersistenceControlRootKeyDerivationCapability;
}): Promise<TransitionProgressPayloadV1 | undefined> {
  const { ciphertext, ...unsigned } = envelope;
  const material = cryptographicMaterial({ envelope: unsigned });
  const key = await rootKey.deriveAesGcmKey({ info: material.info });
  try {
    const plaintext = new Uint8Array(await globalThis.crypto.subtle.decrypt(
      {
        additionalData: toExactArrayBuffer({ bytes: material.aad }),
        iv: toExactArrayBuffer({
          bytes: decodePersistenceControlBase64Url({
            maximumDecodedBytes: NAIDAN_TRANSITION_PROGRESS_FORMAT_CONSTANTS.crypto.nonceBytes,
            value: envelope.nonce,
          }),
        }),
        name: 'AES-GCM',
        tagLength: 128,
      },
      key,
      toExactArrayBuffer({
        bytes: decodePersistenceControlBase64Url({
          maximumDecodedBytes: NAIDAN_TRANSITION_PROGRESS_FORMAT_CONSTANTS.limits.plaintextJsonBytes
            + NAIDAN_TRANSITION_PROGRESS_FORMAT_CONSTANTS.crypto.tagBytes,
          value: ciphertext,
        }),
      }),
    ));
    return decodeTransitionProgressPlaintext({ bytes: plaintext });
  } catch (cause: unknown) {
    if (isAeadAuthenticationFailure({ cause })) return undefined;
    throw cause;
  }
}

export const TEST_ONLY = {
  cryptographicMaterial,
  isAeadAuthenticationFailure,
  toExactArrayBuffer,
};
