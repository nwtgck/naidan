// Production authority for HizoFS V1 persisted constants.
export const HIZOFS_V1_FORMAT_CONSTANTS = {
  "container": {
    "conventionalSuffix": ".hizofs",
    "encryptedFileSuffix": ".enc",
    "segmentClassDirectories": {
      "data": "data",
      "metadata": "metadata"
    },
    "segmentClasses": {
      "data": 2,
      "metadata": 1
    },
    "segmentDirectoryName": "segments",
    "segmentPathBinding": {
      "requireFilenameHeaderIdMatch": true,
      "requireParentClassHeaderClassMatch": true,
      "segmentIdEncoding": "lowercase_hex_16_bytes",
      "shardEncoding": "lowercase_hex_final_segment_id_byte"
    },
    "superblockFiles": [
      "superblock-0.enc",
      "superblock-1.enc"
    ],
    "unlockEnvelopeFiles": [
      "unlock-0.json",
      "unlock-1.json"
    ]
  },
  "crypto": {
    "aead": "AES-256-GCM",
    "contextFields": {
      "HizoFS/v1/passphrase-slot-aad": [
        "formatVersionU16",
        "fileSystemIdAscii21",
        "slotIdAscii21",
        "methodAscii",
        "methodVersionU32",
        "methodParameters"
      ],
      "HizoFS/v1/passphrase-slot-kdf": [
        "fileSystemIdAscii21",
        "slotIdAscii21",
        "salt16"
      ],
      "HizoFS/v1/record-aad": [
        "fileSystemIdAscii21",
        "completeFrameHeader64"
      ],
      "HizoFS/v1/record-key": [
        "fileSystemIdAscii21",
        "homeSegmentId16"
      ],
      "HizoFS/v1/segment-footer-aad": [
        "fileSystemIdAscii21",
        "footerHeader64",
        "footerTrailer32"
      ],
      "HizoFS/v1/segment-footer-key": [
        "fileSystemIdAscii21",
        "physicalSegmentId16"
      ],
      "HizoFS/v1/segment-header-aad": [
        "fileSystemIdAscii21",
        "segmentHeaderPrefix48"
      ],
      "HizoFS/v1/segment-header-key": [
        "fileSystemIdAscii21",
        "physicalSegmentId16",
        "segmentClassU8"
      ],
      "HizoFS/v1/superblock-aad": [
        "exactSuperblockHeader80"
      ],
      "HizoFS/v1/superblock-key": [
        "fileSystemIdAscii21",
        "copyU8",
        "publicationSequenceU64"
      ],
      "HizoFS/v1/unlock-authenticator-aad": [
        "canonicalUnsignedUnlockEnvelopeBytes"
      ],
      "HizoFS/v1/unlock-authenticator-key": [
        "fileSystemIdAscii21",
        "copyU8",
        "unlockSequenceU64"
      ]
    },
    "domains": [
      "HizoFS/v1/passphrase-slot-kdf",
      "HizoFS/v1/passphrase-slot-aad",
      "HizoFS/v1/unlock-authenticator-key",
      "HizoFS/v1/unlock-authenticator-aad",
      "HizoFS/v1/superblock-key",
      "HizoFS/v1/superblock-aad",
      "HizoFS/v1/segment-header-key",
      "HizoFS/v1/segment-header-aad",
      "HizoFS/v1/record-key",
      "HizoFS/v1/record-aad",
      "HizoFS/v1/segment-footer-key",
      "HizoFS/v1/segment-footer-aad"
    ],
    "hash": "SHA-256",
    "nonceBytes": 12,
    "noncePolicy": {
      "passphraseSlotWrap": "fresh_random_96_bit_stored_in_method_parameters",
      "persistenceControl": "fresh_random_96_bit_stored_in_outer_json_when_hizofs_protected",
      "recordFrame": "fresh_random_96_bit_stored_in_header",
      "segmentFooter": "fresh_random_96_bit_stored_in_header",
      "segmentHeader": "zero_nonce_with_unique_segment_derived_key",
      "superblock": "fresh_random_96_bit_stored_in_header",
      "unlockAuthenticator": "fresh_random_96_bit_stored_in_outer_json"
    },
    "tagBytes": 16
  },
  "fixedSizes": {
    "aeadTag": 16,
    "commonPageHeader": 4,
    "directoryBranchChildPrefix": 36,
    "directoryEntryPrefix": 14,
    "directoryInodeBodyPrefix": 3,
    "fileExtentBranchChild": 40,
    "fileExtentLeafEntry": 48,
    "fileInodeBodyPrefix": 9,
    "fileSystemCommitPayload": 112,
    "inodeBranchChild": 40,
    "inodeLeafEntryPrefix": 20,
    "nestedSubvolumeLeafPrefix": 70,
    "randomNonce": 12,
    "recordFrameHeader": 64,
    "recordReference": 32,
    "relocationBranchChild": 56,
    "relocationLeafEntry": 56,
    "segmentFooterHeader": 64,
    "segmentFooterIndexEntry": 48,
    "segmentFooterTrailer": 32,
    "segmentHeader": 64,
    "subvolumeBranchChild": 40,
    "superblockFile": 240,
    "superblockHeader": 80,
    "superblockPlaintext": 144,
    "superblockTag": 16,
    "symlinkInodeBodyPrefix": 2
  },
  "flags": {
    "recordPhysicalOnly": 1,
    "superblockFallbackCommitPresent": 2,
    "superblockRelocationIndexRootPresent": 1
  },
  "formatVersion": 1,
  "limits": {
    "binaryRandomIdBytes": 16,
    "controlJsonNestingDepth": 4,
    "credentialMethodParametersBytes": 4096,
    "credentialMethodVersionMaximum": 4294967295,
    "credentialPbkdf2IterationsDefault": 600000,
    "credentialPbkdf2IterationsMaximum": 10000000,
    "credentialPbkdf2IterationsMinimum": 600000,
    "credentialSlotIdCharacters": 21,
    "credentialSlots": 32,
    "credentialUnlockTotalIterations": 20000000,
    "credentialWrappedRootKeyBytes": 4096,
    "dataFooterPlaintextIndexBytes": 3145680,
    "dataFramesPerSegment": 65535,
    "dataSegmentDataBytes": 33554432,
    "dataSegmentFileMaximumBytes": 36700288,
    "dataSegmentFooterMaximumBytes": 3145792,
    "fileDataPlaintextBytes": 1048576,
    "fileSystemIdCharacters": 21,
    "filenameUtf8Bytes": 255,
    "footerPlaintextIndexBytes": 3145680,
    "framesPerSegment": 65535,
    "inlineDirectoryEncodedBytes": 4096,
    "inlineFileBytes": 4096,
    "metadataFooterPlaintextIndexBytes": 2287776,
    "metadataFramesPerSegment": 47662,
    "metadataPlaintextBytes": 65536,
    "metadataSegmentDataBytes": 4194304,
    "metadataSegmentFileMaximumBytes": 6482256,
    "metadataSegmentFooterMaximumBytes": 2287888,
    "naidanExpandedPathComponents": 1024,
    "naidanExpandedPathUtf8Bytes": 65536,
    "naidanSymlinkFollows": 40,
    "passphraseUtf8Bytes": 1024,
    "randomIdentityGenerationAttempts": 32,
    "segmentFooterMaximumBytes": 3145792,
    "symlinkTargetUtf8Bytes": 4096,
    "timestampMillisecondsMaximum": 8640000000000000,
    "timestampMillisecondsMinimum": -8640000000000000,
    "treeLevel": 255,
    "unlockEnvelopeJsonBytes": 65536
  },
  "magic": {
    "recordFrame": "HZRECORD",
    "segment": "HZSEGMNT",
    "segmentFooter": "HZFOOTER",
    "segmentTrailer": "HZTRAILR",
    "superblock": "HZSBLOCK"
  },
  "pageItemMaximumCounts": {
    "directoryBranch": 1771,
    "directoryLeaf": 4368,
    "fileExtentBranch": 1638,
    "fileExtentLeaf": 1365,
    "inodeBranch": 1638,
    "inodeLeaf": 2849,
    "nestedSubvolumeBranch": 1638,
    "nestedSubvolumeLeaf": 922,
    "relocationBranch": 1170,
    "relocationLeaf": 1170
  },
  "pageItemMinimumBytes": {
    "directoryBranch": 37,
    "directoryLeaf": 15,
    "fileExtentBranch": 40,
    "fileExtentLeaf": 48,
    "inodeBranch": 40,
    "inodeLeaf": 23,
    "nestedSubvolumeBranch": 40,
    "nestedSubvolumeLeaf": 71,
    "relocationBranch": 56,
    "relocationLeaf": 56
  },
  "recordKinds": {
    "directory_page": 32,
    "file_data": 34,
    "file_extent_page": 33,
    "file_system_commit": 1,
    "inode_table_page": 16,
    "nested_subvolume_table_page": 2,
    "relocation_index_page": 48
  },
  "recordSegmentClasses": {
    "directory_page": "metadata",
    "file_data": "data",
    "file_extent_page": "metadata",
    "file_system_commit": "metadata",
    "inode_table_page": "metadata",
    "nested_subvolume_table_page": "metadata",
    "relocation_index_page": "metadata"
  },
  "requiredFeatures": {
    "allocatedBits": {},
    "initialWriterMask": 0,
    "v1ReaderSupportedMask": 0
  },
  "sequenceMinimums": {
    "fileSystemCommit": 1,
    "superblockMinimumUnlock": 1,
    "superblockPublication": 1,
    "unlockEnvelope": 1
  },
  "tags": {
    "directoryTarget": {
      "inode": 1,
      "subvolume": 2
    },
    "inodeContent": {
      "inline": 1,
      "tree": 2
    },
    "inodeKind": {
      "directory": 2,
      "file": 1,
      "symlink": 3
    },
    "subvolumeAccess": {
      "read": 1,
      "readWrite": 2
    }
  },
  "versioning": {
    "credentialMethodVersionPurpose": "credential-method parameter and wrapping semantics",
    "formatVersionPurpose": "top-level framing and persisted semantic generation",
    "magicContainsVersion": false,
    "magicPurpose": "exact 8-byte physical-role discriminator only",
    "recordCodecVersionPurpose": "payload schema version scoped to one record kind",
    "requiredFeatureBitsPurpose": "compatible semantics added within one top-level format version"
  }
} as const;

export type HIZOFS_V1_FORMAT_CONSTANTS = typeof HIZOFS_V1_FORMAT_CONSTANTS;

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
