// Production authority for Naidan Persistence Control V1 persisted constants.
export const NAIDAN_PERSISTENCE_CONTROL_FORMAT_CONSTANTS = {
  "candidateStates": [
    "structurally_invalid",
    "protection_unresolved",
    "proof_invalid",
    "proof_valid"
  ],
  "crypto": {
    "aead": "AES-256-GCM",
    "contextFields": {
      "Naidan/HizoFS-integration/v1/persistence-control-aad": [
        "canonicalUnsignedProtectedControlBytes"
      ],
      "Naidan/HizoFS-integration/v1/persistence-control-key": [
        "authenticationFileSystemIdAscii21",
        "copyU8",
        "controlSequenceU64"
      ],
      "Naidan/HizoFS-integration/v1/plain-control-digest": [
        "canonicalPersistenceControlCoreBytes"
      ]
    },
    "domains": [
      "Naidan/HizoFS-integration/v1/plain-control-digest",
      "Naidan/HizoFS-integration/v1/persistence-control-key",
      "Naidan/HizoFS-integration/v1/persistence-control-aad"
    ],
    "hash": "SHA-256",
    "nonceBytes": 12,
    "tagBytes": 16
  },
  "formatVersion": 1,
  "limits": {
    "binaryRandomIdBytes": 16,
    "controlJsonNestingDepth": 4,
    "persistenceControlJsonBytes": 65536,
    "transitionOperationIdCharacters": 21
  },
  "portableProfiles": {
    "canonicalJson": "HizoFS/v1/canonical-json",
    "fixedNameWholeFileRewrite": "HizoFS/v1/fixed-name-whole-file-rewrite"
  },
  "sequenceMinimum": 1,
  "storage": {
    "collectionDirectoryName": "persistence-control",
    "containerNameEncoding": "fs-_plus_lowercase_hex_of_file_system_id_ascii21_plus_.hizofs",
    "containerNamePrefix": "fs-",
    "controlFiles": [
      "state-0.json",
      "state-1.json"
    ],
    "selection": "highest_proof_valid_sequence"
  }
} as const;

export type NAIDAN_PERSISTENCE_CONTROL_FORMAT_CONSTANTS = typeof NAIDAN_PERSISTENCE_CONTROL_FORMAT_CONSTANTS;

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
