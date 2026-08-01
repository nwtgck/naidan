const ROOT_KEY_BYTES = 32;
const SECRET_BYTES = new WeakMap<FileSystemRootKey, Uint8Array>();

export class FileSystemRootKey {
  #destroyed = false;

  private constructor({ bytes }: { bytes: Uint8Array }) {
    SECRET_BYTES.set(this, Uint8Array.from(bytes));
  }

  public static create({ bytes }: { bytes: Uint8Array }): FileSystemRootKey {
    if (bytes.byteLength !== ROOT_KEY_BYTES) throw new RangeError('File System Root Key must be exactly 32 bytes');
    return new FileSystemRootKey({ bytes });
  }

  public destroy(): void {
    const bytes = SECRET_BYTES.get(this);
    if (bytes !== undefined) bytes.fill(0);
    SECRET_BYTES.delete(this);
    this.#destroyed = true;
  }

  public isDestroyed(): boolean {
    return this.#destroyed;
  }
}

/**
 * Lends a copied Root Key only for one callback and zeroes the copy afterward.
 * Exact composition roots use this bridge when an opaque cross-realm grant
 * must carry the Root Key without publishing it through feature-layer DTOs.
 */
export async function withFileSystemRootKeyBytes<T>({ rootKey, useBytes }: {
  rootKey: FileSystemRootKey;
  useBytes: ({ bytes }: { bytes: Uint8Array }) => Promise<T> | T;
}): Promise<T> {
  const secret = SECRET_BYTES.get(rootKey);
  if (secret === undefined || rootKey.isDestroyed()) throw new TypeError('File System Root Key has been destroyed');
  const copiedSecret = Uint8Array.from(secret);
  try {
    return await useBytes({ bytes: copiedSecret });
  } finally {
    copiedSecret.fill(0);
  }
}

export async function deriveRootKeyAesGcmKey({ info, rootKey }: {
  info: Uint8Array;
  rootKey: FileSystemRootKey;
}): Promise<CryptoKey> {
  const secret = SECRET_BYTES.get(rootKey);
  if (secret === undefined || rootKey.isDestroyed()) throw new TypeError('File System Root Key has been destroyed');
  const copiedSecret = Uint8Array.from(secret);
  try {
    const baseKey = await globalThis.crypto.subtle.importKey('raw', copiedSecret, 'HKDF', false, ['deriveKey']);
    return await globalThis.crypto.subtle.deriveKey(
      { hash: 'SHA-256', info: Uint8Array.from(info), name: 'HKDF', salt: new Uint8Array() },
      baseKey,
      { length: 256, name: 'AES-GCM' },
      false,
      ['decrypt', 'encrypt'],
    );
  } finally {
    copiedSecret.fill(0);
  }
}


export interface FileSystemRootKeyProofDerivationCapability {
  deriveAesGcmKey({ info }: { info: Uint8Array }): Promise<CryptoKey>;
}

/**
 * Lends a non-extractable proof-key derivation capability only for one callback.
 *
 * The caller can verify an external authenticator without receiving root-key
 * bytes or retaining a secret-bearing capability after authority verification.
 */
export async function withFileSystemRootKeyProofDerivationCapability<T>({
  rootKey,
  useCapability,
}: {
  rootKey: FileSystemRootKey;
  useCapability: ({ capability }: {
    capability: FileSystemRootKeyProofDerivationCapability;
  }) => Promise<T>;
}): Promise<T> {
  let active = true;
  const capability: FileSystemRootKeyProofDerivationCapability = Object.freeze({
    async deriveAesGcmKey({ info }: { info: Uint8Array }) {
      if (!active) throw new TypeError('File System Root Key proof capability has expired');
      return await deriveRootKeyAesGcmKey({ info, rootKey });
    },
  });
  try {
    return await useCapability({ capability });
  } finally {
    active = false;
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
  rootKeyBytes: ROOT_KEY_BYTES,
};
