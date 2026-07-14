import type {
  OpfsEncryptedStoreHeaderDto,
  OpfsEncryptionStateDto,
} from '@/00-storage/00-dto/opfs-encryption.dto';
import { decodeBase64UrlWithLength } from './base64-url';
import { validateHizoFSStableId } from '@/00-storage/service/hizofs/id';
import {
  MAX_ENCRYPTION_KEY_SLOTS,
  MAX_PBKDF2_ITERATIONS,
} from './encryption-key-manager';

function assertNonNegativeSafeInteger({
  value,
  fieldName,
}: {
  value: number;
  fieldName: string;
}): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${fieldName} must be a non-negative safe integer`);
  }
}

function assertPositiveSafeInteger({
  value,
  fieldName,
}: {
  value: number;
  fieldName: string;
}): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${fieldName} must be a positive safe integer`);
  }
}

function assertEncryptionOpaqueId({ value, fieldName }: {
  value: string;
  fieldName: string;
}): void {
  validateHizoFSStableId({ value, fieldName });
}

export function assertSafeOpfsPathSegment({
  value,
  fieldName,
}: {
  value: string;
  fieldName: string;
}): void {
  if (
    value.length === 0
    || value === '.'
    || value === '..'
    || value.includes('/')
    || value.includes('\\')
    || value.includes('\0')
  ) {
    throw new Error(`${fieldName} is not a safe OPFS path segment`);
  }
}

export function assertEncryptionStateCanBeUsed({
  state,
}: {
  state: OpfsEncryptionStateDto;
}): void {
  assertNonNegativeSafeInteger({
    value: state.sequence,
    fieldName: 'Encryption state sequence',
  });
  if (state.keySlots.length === 0 || state.keySlots.length > MAX_ENCRYPTION_KEY_SLOTS) {
    throw new Error(
      `Encryption state must contain between 1 and ${MAX_ENCRYPTION_KEY_SLOTS} key slots`,
    );
  }
  const keySlotIds = new Set<string>();
  for (const keySlot of state.keySlots) {
    if (keySlot.id.length === 0 || keySlotIds.has(keySlot.id)) {
      throw new Error(
        `Encryption state contains an invalid or duplicate key slot ID: ${JSON.stringify(keySlot.id)}`,
      );
    }
    keySlotIds.add(keySlot.id);
    switch (keySlot.keyDerivation.type) {
    case 'pbkdf2_hmac_sha256':
      assertPositiveSafeInteger({
        value: keySlot.keyDerivation.iterations,
        fieldName: 'PBKDF2 iteration count',
      });
      if (keySlot.keyDerivation.iterations > MAX_PBKDF2_ITERATIONS) {
        throw new Error(
          `PBKDF2 iteration count must not exceed ${MAX_PBKDF2_ITERATIONS}`,
        );
      }
      decodeBase64UrlWithLength({
        value: keySlot.keyDerivation.salt,
        expectedByteLength: 32,
        fieldName: 'PBKDF2 salt',
      });
      break;
    default: {
      const _ex: never = keySlot.keyDerivation.type;
      throw new Error(`Unhandled key derivation: ${String(_ex)}`);
    }
    }
    decodeBase64UrlWithLength({
      value: keySlot.wrappedStorageUnlockKey.nonce,
      expectedByteLength: 12,
      fieldName: 'Wrapped storage unlock key nonce',
    });
    decodeBase64UrlWithLength({
      value: keySlot.wrappedStorageUnlockKey.ciphertext,
      expectedByteLength: 48,
      fieldName: 'Wrapped storage unlock key ciphertext',
    });
  }

  switch (state.state) {
  case 'encrypted':
    assertSafeOpfsPathSegment({
      value: state.activeEncryptedStoreId,
      fieldName: 'Active encrypted store ID',
    });
    break;
  case 'transitioning': {
    const operation = state.operation;
    switch (operation.type) {
    case 'encrypting':
      assertSafeOpfsPathSegment({
        value: operation.targetEncryptedStoreId,
        fieldName: 'Target encrypted store ID',
      });
      break;
    case 'decrypting':
      assertSafeOpfsPathSegment({
        value: operation.sourceEncryptedStoreId,
        fieldName: 'Source encrypted store ID',
      });
      break;
    case 'reencrypting':
      assertSafeOpfsPathSegment({
        value: operation.sourceEncryptedStoreId,
        fieldName: 'Source encrypted store ID',
      });
      assertSafeOpfsPathSegment({
        value: operation.targetEncryptedStoreId,
        fieldName: 'Target encrypted store ID',
      });
      if (operation.sourceEncryptedStoreId === operation.targetEncryptedStoreId) {
        throw new Error('Re-encryption source and target store IDs must differ');
      }
      break;
    default: {
      const _ex: never = operation;
      throw new Error(`Unhandled encryption operation: ${String(_ex)}`);
    }
    }
    break;
  }
  default: {
    const _ex: never = state;
    throw new Error(`Unhandled encryption state: ${String(_ex)}`);
  }
  }
}

export function assertEncryptedStoreHeaderCanBeUsed({
  header,
}: {
  header: OpfsEncryptedStoreHeaderDto;
}): void {
  assertSafeOpfsPathSegment({
    value: header.encryptedStoreId,
    fieldName: 'Encrypted store ID',
  });
  assertEncryptionOpaqueId({
    value: header.fileSystemId,
    fieldName: 'Encrypted store file system ID',
  });
  decodeBase64UrlWithLength({
    value: header.wrappedFileSystemRootKey.nonce,
    expectedByteLength: 12,
    fieldName: 'Wrapped file system root key nonce',
  });
  decodeBase64UrlWithLength({
    value: header.wrappedFileSystemRootKey.ciphertext,
    expectedByteLength: 48,
    fieldName: 'Wrapped file system root key ciphertext',
  });
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
  assertNonNegativeSafeInteger,
  assertPositiveSafeInteger,
};
