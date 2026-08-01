// Public HizoFS crypto boundary. Generic Web Crypto primitives, arbitrary AAD,
// and untyped nonce/random-byte helpers are intentionally not exported.
export * from './credential/passphrase-slot';
export * from './credential/unlock-authenticator';
export * from './data-plane/record';
export * from './data-plane/segment';
export * from './data-plane/superblock';
export * from './random/purpose-random';
export {
  FileSystemRootKey,
  withFileSystemRootKeyBytes,
  withFileSystemRootKeyProofDerivationCapability,
  type FileSystemRootKeyProofDerivationCapability,
} from './secret-types';
export * from './types';

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
