// Production authority for Naidan Persistence Control V1 crypto contracts.
export const NAIDAN_PERSISTENCE_CONTROL_FORMAT_CRYPTO_CONTEXTS = {
  "persistenceControlAad": {
    "domain": "Naidan/HizoFS-integration/v1/persistence-control-aad",
    "fields": [
      "canonicalUnsignedProtectedControlBytes"
    ]
  },
  "persistenceControlKey": {
    "domain": "Naidan/HizoFS-integration/v1/persistence-control-key",
    "fields": [
      "authenticationFileSystemIdAscii21",
      "copyU8",
      "controlSequenceU64"
    ]
  },
  "plainControlDigest": {
    "domain": "Naidan/HizoFS-integration/v1/plain-control-digest",
    "fields": [
      "canonicalPersistenceControlCoreBytes"
    ]
  }
} as const;

export type NAIDAN_PERSISTENCE_CONTROL_FORMAT_CRYPTO_CONTEXTS = typeof NAIDAN_PERSISTENCE_CONTROL_FORMAT_CRYPTO_CONTEXTS;

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
