// Production authority for HizoFS V1 crypto domains and persisted fields.
export const HIZOFS_V1_FORMAT_CRYPTO_CONTEXTS = {
  "passphraseSlotAad": {
    "domain": "HizoFS/v1/passphrase-slot-aad",
    "fields": [
      "formatVersionU16",
      "fileSystemIdAscii21",
      "slotIdAscii21",
      "methodAscii",
      "methodVersionU32",
      "methodParameters"
    ]
  },
  "passphraseSlotKdf": {
    "domain": "HizoFS/v1/passphrase-slot-kdf",
    "fields": [
      "fileSystemIdAscii21",
      "slotIdAscii21",
      "salt16"
    ]
  },
  "recordAad": {
    "domain": "HizoFS/v1/record-aad",
    "fields": [
      "fileSystemIdAscii21",
      "completeFrameHeader64"
    ]
  },
  "recordKey": {
    "domain": "HizoFS/v1/record-key",
    "fields": [
      "fileSystemIdAscii21",
      "homeSegmentId16"
    ]
  },
  "segmentFooterAad": {
    "domain": "HizoFS/v1/segment-footer-aad",
    "fields": [
      "fileSystemIdAscii21",
      "footerHeader64",
      "footerTrailer32"
    ]
  },
  "segmentFooterKey": {
    "domain": "HizoFS/v1/segment-footer-key",
    "fields": [
      "fileSystemIdAscii21",
      "physicalSegmentId16"
    ]
  },
  "segmentHeaderAad": {
    "domain": "HizoFS/v1/segment-header-aad",
    "fields": [
      "fileSystemIdAscii21",
      "segmentHeaderPrefix48"
    ]
  },
  "segmentHeaderKey": {
    "domain": "HizoFS/v1/segment-header-key",
    "fields": [
      "fileSystemIdAscii21",
      "physicalSegmentId16",
      "segmentClassU8"
    ]
  },
  "superblockAad": {
    "domain": "HizoFS/v1/superblock-aad",
    "fields": [
      "exactSuperblockHeader80"
    ]
  },
  "superblockKey": {
    "domain": "HizoFS/v1/superblock-key",
    "fields": [
      "fileSystemIdAscii21",
      "copyU8",
      "publicationSequenceU64"
    ]
  },
  "unlockAuthenticatorAad": {
    "domain": "HizoFS/v1/unlock-authenticator-aad",
    "fields": [
      "canonicalUnsignedUnlockEnvelopeBytes"
    ]
  },
  "unlockAuthenticatorKey": {
    "domain": "HizoFS/v1/unlock-authenticator-key",
    "fields": [
      "fileSystemIdAscii21",
      "copyU8",
      "unlockSequenceU64"
    ]
  }
} as const;

export type HIZOFS_V1_FORMAT_CRYPTO_CONTEXTS = typeof HIZOFS_V1_FORMAT_CRYPTO_CONTEXTS;

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
