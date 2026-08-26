import {
  HIZOFS_V1_FORMAT_CONSTANTS,
  HIZOFS_V1_PASSPHRASE_CREDENTIAL_METHOD,
  compareFilenameComponentsByUtf8,
  createCommitSequence,
  createHomeRecordReference,
  createPhysicalRecordReference,
  createPublicationSequence,
  createRecordFrameHeader,
  createSegmentFooterHeader,
  createSuperblockHeader,
  createTimestampMilliseconds,
  createUInt64,
  encodeHomeRecordReference,
  encodePhysicalRecordReference,
  encodeOptionalHomeRecordReference,
  encodeOptionalPhysicalRecordReference,
  encodePassphraseSlotAad,
  encodeBase64UrlUnpadded,
  encodeFilenameComponent,
  encodeLowercaseHex,
  encodeSymlinkTarget,
  encodeRecordFrameHeader,
  encodePassphraseSlotKdfContext,
  encodeRecordAad,
  encodeRecordKeyContext,
  encodeSegmentFooterAad,
  encodeSegmentFooterKeyContext,
  encodeSegmentFooterHeader,
  encodeSegmentHeaderAad,
  encodeSegmentHeaderKeyContext,
  encodeSegmentFooterIndexEntry,
  encodeSegmentFooterTrailer,
  encodeSegmentHeader,
  encodeSuperblockAad,
  encodeSuperblockKeyContext,
  encodeSuperblockHeader,
  encodeSuperblockPlaintext,
  encodeUnlockEnvelope,
  encodeUnlockAuthenticatorAad,
  encodeUnlockAuthenticatorKeyContext,
  parseCredentialSlotId,
  parseFileSystemId,
  parseMutationId,
  parsePublicationId,
  parseSegmentId,
  segmentIdToFilename,
  segmentIdToRelativePath,
  segmentIdToShard,
  createUnlockSequence,
  decodeFileDataPayload,
  decodeRequiredHomeRecordReference,
  decodeSegmentFooterHeader,
  decodeSegmentFooterIndexEntry,
  decodeSegmentHeader,
  decodeSuperblockHeader,
  decodeUnlockEnvelope,
  decodeBase64UrlUnpadded,
  decodeFilenameComponent,
  decodeLowercaseHex,
  decodeSymlinkTarget,
  decodePassphraseCredentialParametersV1,
  decodeFileExtentPage,
  decodeFileSystemCommitPayload,
  decodeDirectoryPage,
  decodeInodeBranchPage,
  decodeInodeLeafPage,
  decodeNestedSubvolumeBranchPage,
  decodeNestedSubvolumeLeafPage,
  decodeRelocationIndexPage,
  decodeSuperblockPlaintext,
  encodeFileDataPayload,
  encodePassphraseCredentialParametersV1,
  encodeFileExtentPage,
  encodeFileSystemCommitPayload,
  encodeDirectoryPage,
  encodeInodeBranchPage,
  encodeInodeLeafPage,
  encodeNestedSubvolumeBranchPage,
  encodeNestedSubvolumeLeafPage,
  encodeRelocationIndexPage,
  type UnlockEnvelopeV1,
  writeU16Be,
  writeU32Be,
  writeU64Be,
} from "@/00-storage/service/hizofs/00-format";
import { describe, expect, it } from "vitest";

function fromHex({ value }: { value: string }): Uint8Array {
  return Uint8Array.from(Buffer.from(value, "hex"));
}

function toHex({ bytes }: { bytes: Uint8Array }): string {
  return [...bytes].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

describe("HizoFS V1 exact format anchors", () => {
  it("requires an explicit review classification for every top-level V1 format authority field", () => {
    const {
      container: _container,
      crypto,
      fixedSizes: _fixedSizes,
      flags: _flags,
      formatVersion: _formatVersion,
      limits: _limits,
      magic: _magic,
      pageItemMaximumCounts: _pageItemMaximumCounts,
      pageItemMinimumBytes: _pageItemMinimumBytes,
      recordKinds: _recordKinds,
      recordSegmentClasses: _recordSegmentClasses,
      requiredFeatures: _requiredFeatures,
      sequenceMinimums: _sequenceMinimums,
      tags: _tags,
      versioning: _versioning,
      ...unhandledTopLevel
    } = HIZOFS_V1_FORMAT_CONSTANTS;
    unhandledTopLevel satisfies Record<PropertyKey, never>;

    const {
      aead: _aead,
      contextFields: _contextFields,
      domains: _domains,
      hash: _hash,
      nonceBytes: _nonceBytes,
      noncePolicy: _noncePolicy,
      tagBytes: _tagBytes,
      ...unhandledCrypto
    } = crypto;
    unhandledCrypto satisfies Record<PropertyKey, never>;
  });
  it("freezes the top-level format identity and physical role names", () => {
    expect(HIZOFS_V1_FORMAT_CONSTANTS.formatVersion).toBe(1);
    expect(HIZOFS_V1_FORMAT_CONSTANTS.magic).toEqual({
      recordFrame: "HZRECORD",
      segment: "HZSEGMNT",
      segmentFooter: "HZFOOTER",
      segmentTrailer: "HZTRAILR",
      superblock: "HZSBLOCK",
    });
    expect(HIZOFS_V1_FORMAT_CONSTANTS.container).toEqual({
      conventionalSuffix: ".hizofs",
      encryptedFileSuffix: ".enc",
      segmentClassDirectories: { data: "data", metadata: "metadata" },
      segmentClasses: { data: 2, metadata: 1 },
      segmentDirectoryName: "segments",
      segmentPathBinding: {
        requireFilenameHeaderIdMatch: true,
        requireParentClassHeaderClassMatch: true,
        segmentIdEncoding: "lowercase_hex_16_bytes",
        shardEncoding: "lowercase_hex_final_segment_id_byte",
      },
      superblockFiles: ["superblock-0.enc", "superblock-1.enc"],
      unlockEnvelopeFiles: ["unlock-0.json", "unlock-1.json"],
    });
  });

  it("freezes every persisted record kind numeric value", () => {
    expect(HIZOFS_V1_FORMAT_CONSTANTS.recordKinds).toEqual({
      directory_page: 32,
      file_data: 34,
      file_extent_page: 33,
      file_system_commit: 1,
      inode_table_page: 16,
      nested_subvolume_table_page: 2,
      relocation_index_page: 48,
    });
  });

  it("freezes persisted flags and semantic tag values", () => {
    expect(HIZOFS_V1_FORMAT_CONSTANTS.flags).toEqual({
      recordPhysicalOnly: 1,
      superblockFallbackCommitPresent: 2,
      superblockRelocationIndexRootPresent: 1,
    });
    expect(HIZOFS_V1_FORMAT_CONSTANTS.tags).toEqual({
      directoryTarget: { inode: 1, subvolume: 2 },
      inodeContent: { inline: 1, tree: 2 },
      inodeKind: { directory: 2, file: 1, symlink: 3 },
      subvolumeAccess: { read: 1, readWrite: 2 },
    });
    expect(HIZOFS_V1_FORMAT_CONSTANTS.requiredFeatures).toEqual({
      allocatedBits: {},
      initialWriterMask: 0,
      v1ReaderSupportedMask: 0,
    });
  });

  it("freezes persisted identifier lexical forms and rejects non-canonical IDs", () => {
    expect(parseFileSystemId({ value: "Abcdefghij_klmnopq-12" })).toBe("Abcdefghij_klmnopq-12");
    expect(parseCredentialSlotId({ value: "Zbcdefghij_klmnopq-12" })).toBe("Zbcdefghij_klmnopq-12");
    for (const invalid of [
      "short",
      "abcdefghijklmnopqrstuv",
      "abcdefghijklmnopqr.tu",
      "abcdefghijklmnopqr tu",
    ]) {
      expect(() => parseFileSystemId({ value: invalid })).toThrow();
      expect(() => parseCredentialSlotId({ value: invalid })).toThrow();
    }

    const validBinaryId = Uint8Array.from({ length: 16 }, (_, index) => index + 1);
    expect(toHex({ bytes: parseSegmentId({ bytes: validBinaryId }) })).toBe("0102030405060708090a0b0c0d0e0f10");
    expect(toHex({ bytes: parseMutationId({ bytes: validBinaryId }) })).toBe("0102030405060708090a0b0c0d0e0f10");
    expect(toHex({ bytes: parsePublicationId({ bytes: validBinaryId }) })).toBe("0102030405060708090a0b0c0d0e0f10");
    for (const invalid of [new Uint8Array(15), new Uint8Array(16), new Uint8Array(17)]) {
      expect(() => parseSegmentId({ bytes: invalid })).toThrow();
      expect(() => parseMutationId({ bytes: invalid })).toThrow();
      expect(() => parsePublicationId({ bytes: invalid })).toThrow();
    }
  });

  it("freezes the exact Segment ID filename, shard, and relative-path mapping", () => {
    const id = parseSegmentId({ bytes: fromHex({ value: "00112233445566778899aabbccddeeff" }) });
    expect(segmentIdToShard({ id })).toBe("ff");
    expect(segmentIdToFilename({ id })).toBe("00112233445566778899aabbccddeeff.enc");
    expect(segmentIdToRelativePath({ id, segmentClass: "metadata" })).toBe(
      "segments/metadata/ff/00112233445566778899aabbccddeeff.enc",
    );
    expect(segmentIdToRelativePath({ id, segmentClass: "data" })).toBe(
      "segments/data/ff/00112233445566778899aabbccddeeff.enc",
    );
  });

  it("freezes the binary frame sizes that delimit independently persisted structures", () => {
    expect(HIZOFS_V1_FORMAT_CONSTANTS.fixedSizes).toEqual({
      aeadTag: 16,
      commonPageHeader: 4,
      directoryBranchChildPrefix: 36,
      directoryEntryPrefix: 14,
      directoryInodeBodyPrefix: 3,
      fileExtentBranchChild: 40,
      fileExtentLeafEntry: 48,
      fileInodeBodyPrefix: 9,
      fileSystemCommitPayload: 112,
      inodeBranchChild: 40,
      inodeLeafEntryPrefix: 20,
      nestedSubvolumeLeafPrefix: 70,
      randomNonce: 12,
      recordFrameHeader: 64,
      recordReference: 32,
      relocationBranchChild: 56,
      relocationLeafEntry: 56,
      segmentFooterHeader: 64,
      segmentFooterIndexEntry: 48,
      segmentFooterTrailer: 32,
      segmentHeader: 64,
      subvolumeBranchChild: 40,
      superblockFile: 240,
      superblockHeader: 80,
      superblockPlaintext: 144,
      superblockTag: 16,
      symlinkInodeBodyPrefix: 2,
    });
  });

  it("freezes the persisted cryptographic suite and domain identities", () => {
    expect(HIZOFS_V1_FORMAT_CONSTANTS.crypto.aead).toBe("AES-256-GCM");
    expect(HIZOFS_V1_FORMAT_CONSTANTS.crypto.hash).toBe("SHA-256");
    expect(HIZOFS_V1_FORMAT_CONSTANTS.crypto.nonceBytes).toBe(12);
    expect(HIZOFS_V1_FORMAT_CONSTANTS.crypto.noncePolicy).toEqual({
      passphraseSlotWrap: "fresh_random_96_bit_stored_in_method_parameters",
      persistenceControl: "fresh_random_96_bit_stored_in_outer_json_when_hizofs_protected",
      recordFrame: "fresh_random_96_bit_stored_in_header",
      segmentFooter: "fresh_random_96_bit_stored_in_header",
      segmentHeader: "zero_nonce_with_unique_segment_derived_key",
      superblock: "fresh_random_96_bit_stored_in_header",
      unlockAuthenticator: "fresh_random_96_bit_stored_in_outer_json",
    });
    expect(HIZOFS_V1_FORMAT_CONSTANTS.crypto.tagBytes).toBe(16);
    expect(HIZOFS_V1_FORMAT_CONSTANTS.crypto.contextFields).toEqual({
      "HizoFS/v1/passphrase-slot-aad": ["formatVersionU16", "fileSystemIdAscii21", "slotIdAscii21", "methodAscii", "methodVersionU32", "methodParameters"],
      "HizoFS/v1/passphrase-slot-kdf": ["fileSystemIdAscii21", "slotIdAscii21", "salt16"],
      "HizoFS/v1/record-aad": ["fileSystemIdAscii21", "completeFrameHeader64"],
      "HizoFS/v1/record-key": ["fileSystemIdAscii21", "homeSegmentId16"],
      "HizoFS/v1/segment-footer-aad": ["fileSystemIdAscii21", "footerHeader64", "footerTrailer32"],
      "HizoFS/v1/segment-footer-key": ["fileSystemIdAscii21", "physicalSegmentId16"],
      "HizoFS/v1/segment-header-aad": ["fileSystemIdAscii21", "segmentHeaderPrefix48"],
      "HizoFS/v1/segment-header-key": ["fileSystemIdAscii21", "physicalSegmentId16", "segmentClassU8"],
      "HizoFS/v1/superblock-aad": ["exactSuperblockHeader80"],
      "HizoFS/v1/superblock-key": ["fileSystemIdAscii21", "copyU8", "publicationSequenceU64"],
      "HizoFS/v1/unlock-authenticator-aad": ["canonicalUnsignedUnlockEnvelopeBytes"],
      "HizoFS/v1/unlock-authenticator-key": ["fileSystemIdAscii21", "copyU8", "unlockSequenceU64"],
    });
    expect(HIZOFS_V1_FORMAT_CONSTANTS.crypto.domains).toEqual([
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
      "HizoFS/v1/segment-footer-aad",
    ]);
  });

  it("freezes page validity, record placement, sequence floors, and versioning semantics", () => {
    expect(HIZOFS_V1_FORMAT_CONSTANTS.pageItemMaximumCounts).toEqual({
      directoryBranch: 1771, directoryLeaf: 4368, fileExtentBranch: 1638, fileExtentLeaf: 1365, inodeBranch: 1638,
      inodeLeaf: 2849, nestedSubvolumeBranch: 1638, nestedSubvolumeLeaf: 922, relocationBranch: 1170, relocationLeaf: 1170,
    });
    expect(HIZOFS_V1_FORMAT_CONSTANTS.pageItemMinimumBytes).toEqual({
      directoryBranch: 37, directoryLeaf: 15, fileExtentBranch: 40, fileExtentLeaf: 48, inodeBranch: 40, inodeLeaf: 23,
      nestedSubvolumeBranch: 40, nestedSubvolumeLeaf: 71, relocationBranch: 56, relocationLeaf: 56,
    });
    expect(HIZOFS_V1_FORMAT_CONSTANTS.recordSegmentClasses).toEqual({
      directory_page: "metadata", file_data: "data", file_extent_page: "metadata", file_system_commit: "metadata",
      inode_table_page: "metadata", nested_subvolume_table_page: "metadata", relocation_index_page: "metadata",
    });
    expect(HIZOFS_V1_FORMAT_CONSTANTS.sequenceMinimums).toEqual({
      fileSystemCommit: 1, superblockMinimumUnlock: 1, superblockPublication: 1, unlockEnvelope: 1,
    });
    expect(HIZOFS_V1_FORMAT_CONSTANTS.versioning).toEqual({
      credentialMethodVersionPurpose: "credential-method parameter and wrapping semantics",
      formatVersionPurpose: "top-level framing and persisted semantic generation",
      magicContainsVersion: false,
      magicPurpose: "exact 8-byte physical-role discriminator only",
      recordCodecVersionPurpose: "payload schema version scoped to one record kind",
      requiredFeatureBitsPurpose: "compatible semantics added within one top-level format version",
    });
  });

  it("freezes compatibility-affecting V1 bounds while leaving writer/runtime policy tunables unfrozen", () => {
    const {
      binaryRandomIdBytes, controlJsonNestingDepth, credentialMethodParametersBytes, credentialMethodVersionMaximum,
      credentialPbkdf2IterationsDefault: _credentialPbkdf2IterationsDefault, credentialPbkdf2IterationsMaximum,
      credentialPbkdf2IterationsMinimum, credentialSlotIdCharacters, credentialSlots, credentialUnlockTotalIterations,
      credentialWrappedRootKeyBytes, dataFooterPlaintextIndexBytes, dataFramesPerSegment, dataSegmentDataBytes,
      dataSegmentFileMaximumBytes, dataSegmentFooterMaximumBytes, fileDataPlaintextBytes, fileSystemIdCharacters,
      filenameUtf8Bytes, footerPlaintextIndexBytes, framesPerSegment, inlineDirectoryEncodedBytes, inlineFileBytes,
      metadataFooterPlaintextIndexBytes, metadataFramesPerSegment, metadataPlaintextBytes, metadataSegmentDataBytes,
      metadataSegmentFileMaximumBytes, metadataSegmentFooterMaximumBytes,
      naidanExpandedPathComponents: _naidanExpandedPathComponents, naidanExpandedPathUtf8Bytes: _naidanExpandedPathUtf8Bytes,
      naidanSymlinkFollows: _naidanSymlinkFollows, passphraseUtf8Bytes,
      randomIdentityGenerationAttempts: _randomIdentityGenerationAttempts, segmentFooterMaximumBytes, symlinkTargetUtf8Bytes,
      timestampMillisecondsMaximum, timestampMillisecondsMinimum, treeLevel, unlockEnvelopeJsonBytes,
      ...unhandledLimits
    } = HIZOFS_V1_FORMAT_CONSTANTS.limits;
    unhandledLimits satisfies Record<PropertyKey, never>;
    expect({
      binaryRandomIdBytes, controlJsonNestingDepth, credentialMethodParametersBytes, credentialMethodVersionMaximum,
      credentialPbkdf2IterationsMaximum, credentialPbkdf2IterationsMinimum, credentialSlotIdCharacters, credentialSlots,
      credentialUnlockTotalIterations, credentialWrappedRootKeyBytes, dataFooterPlaintextIndexBytes, dataFramesPerSegment,
      dataSegmentDataBytes, dataSegmentFileMaximumBytes, dataSegmentFooterMaximumBytes, fileDataPlaintextBytes,
      fileSystemIdCharacters, filenameUtf8Bytes, footerPlaintextIndexBytes, framesPerSegment, inlineDirectoryEncodedBytes,
      inlineFileBytes, metadataFooterPlaintextIndexBytes, metadataFramesPerSegment, metadataPlaintextBytes,
      metadataSegmentDataBytes, metadataSegmentFileMaximumBytes, metadataSegmentFooterMaximumBytes, passphraseUtf8Bytes,
      segmentFooterMaximumBytes, symlinkTargetUtf8Bytes, timestampMillisecondsMaximum, timestampMillisecondsMinimum,
      treeLevel, unlockEnvelopeJsonBytes,
    }).toEqual({
      binaryRandomIdBytes: 16, controlJsonNestingDepth: 4, credentialMethodParametersBytes: 4096,
      credentialMethodVersionMaximum: 4294967295, credentialPbkdf2IterationsMaximum: 10000000,
      credentialPbkdf2IterationsMinimum: 600000, credentialSlotIdCharacters: 21, credentialSlots: 32,
      credentialUnlockTotalIterations: 20000000, credentialWrappedRootKeyBytes: 4096, dataFooterPlaintextIndexBytes: 3145680,
      dataFramesPerSegment: 65535, dataSegmentDataBytes: 33554432, dataSegmentFileMaximumBytes: 36700288,
      dataSegmentFooterMaximumBytes: 3145792, fileDataPlaintextBytes: 1048576, fileSystemIdCharacters: 21, filenameUtf8Bytes: 255,
      footerPlaintextIndexBytes: 3145680, framesPerSegment: 65535, inlineDirectoryEncodedBytes: 4096, inlineFileBytes: 4096,
      metadataFooterPlaintextIndexBytes: 2287776, metadataFramesPerSegment: 47662, metadataPlaintextBytes: 65536,
      metadataSegmentDataBytes: 4194304, metadataSegmentFileMaximumBytes: 6482256, metadataSegmentFooterMaximumBytes: 2287888,
      passphraseUtf8Bytes: 1024, segmentFooterMaximumBytes: 3145792, symlinkTargetUtf8Bytes: 4096,
      timestampMillisecondsMaximum: 8640000000000000, timestampMillisecondsMinimum: -8640000000000000, treeLevel: 255,
      unlockEnvelopeJsonBytes: 65536,
    });
  });

  it("enforces V1 scalar ranges and positive persisted sequence minima", () => {
    expect(createUInt64({ value: 0xffff_ffff_ffff_ffffn })).toBe(0xffff_ffff_ffff_ffffn);
    expect(() => createUInt64({ value: -1n })).toThrow();
    expect(() => createUInt64({ value: 0x1_0000_0000_0000_0000n })).toThrow();

    expect(createTimestampMilliseconds({ value: -8_640_000_000_000_000n })).toBe(-8_640_000_000_000_000n);
    expect(createTimestampMilliseconds({ value: 8_640_000_000_000_000n })).toBe(8_640_000_000_000_000n);
    expect(() => createTimestampMilliseconds({ value: -8_640_000_000_000_001n })).toThrow();
    expect(() => createTimestampMilliseconds({ value: 8_640_000_000_000_001n })).toThrow();

    expect(createCommitSequence({ value: 1n })).toBe(1n);
    expect(createPublicationSequence({ value: 1n })).toBe(1n);
    expect(createUnlockSequence({ value: 1n })).toBe(1n);
    expect(() => createCommitSequence({ value: 0n })).toThrow();
    expect(() => createPublicationSequence({ value: 0n })).toThrow();
    expect(() => createUnlockSequence({ value: 0n })).toThrow();
  });

  it("freezes big-endian scalar serialization independently from current readers", () => {
    const bytes = new Uint8Array(14);
    writeU16Be({ bytes, offset: 0, value: 0x1234 });
    writeU32Be({ bytes, offset: 2, value: 0x56789abc });
    writeU64Be({ bytes, offset: 6, value: createUInt64({ value: 0xdef0123456789abcn }) });
    expect(toHex({ bytes })).toBe("123456789abcdef0123456789abc");
  });

  it("freezes the exact 32-byte Record Reference field order and reserved bytes", () => {
    const reference = createHomeRecordReference({ fields: {
      byteOffset: createUInt64({ value: 64n }),
      frameLength: 88,
      recordKind: 1,
      segmentId: parseSegmentId({
        bytes: Uint8Array.from({ length: 16 }, (_, index) => index + 1),
      }),
    } });
    expect(toHex({ bytes: encodeHomeRecordReference({ reference }) })).toBe(
      "0102030405060708090a0b0c0d0e0f1000000000000000400000005801000000",
    );
  });
  it("freezes persisted text and binary lexical encodings", () => {
    const arbitraryBytes = fromHex({ value: "00fbff1020" });
    expect(encodeBase64UrlUnpadded({ bytes: arbitraryBytes })).toBe("APv_ECA");
    expect(toHex({ bytes: decodeBase64UrlUnpadded({ maximumDecodedBytes: 5, value: "APv_ECA" }) })).toBe("00fbff1020");
    expect(encodeLowercaseHex({ bytes: arbitraryBytes })).toBe("00fbff1020");
    expect(toHex({ bytes: decodeLowercaseHex({ expectedBytes: 5, value: "00fbff1020" }) })).toBe("00fbff1020");

    const filename = "資料-é-😀.txt";
    const filenameBytes = encodeFilenameComponent({ value: filename });
    expect(toHex({ bytes: filenameBytes })).toBe("e8b387e696992dc3a92df09f98802e747874");
    expect(decodeFilenameComponent({ bytes: filenameBytes })).toBe(filename);

    const symlinkTarget = "../資料/😀.bin";
    const symlinkBytes = encodeSymlinkTarget({ value: symlinkTarget });
    expect(toHex({ bytes: symlinkBytes })).toBe("2e2e2fe8b387e696992ff09f98802e62696e");
    expect(decodeSymlinkTarget({ bytes: symlinkBytes })).toBe(symlinkTarget);
  });

  it("freezes canonical filename ordering as unsigned UTF-8 bytes without Unicode normalization", () => {
    expect(Math.sign(compareFilenameComponentsByUtf8({ left: "e\u0301.txt", right: "é.txt" }))).toBe(-1);
    expect(Math.sign(compareFilenameComponentsByUtf8({ left: "é.txt", right: "e\u0301.txt" }))).toBe(1);
    expect(compareFilenameComponentsByUtf8({ left: "same", right: "same" })).toBe(0);
  });

  it("rejects non-canonical persisted lexical forms instead of widening V1 reader acceptance", () => {
    expect(() => decodeBase64UrlUnpadded({ maximumDecodedBytes: 5, value: "APv_ECA=" })).toThrow();
    expect(() => decodeLowercaseHex({ expectedBytes: 5, value: "00FBFF1020" })).toThrow();
    expect(() => decodeFilenameComponent({ bytes: Uint8Array.of(0xc0, 0xaf) })).toThrow();
    expect(() => decodeFilenameComponent({ bytes: new TextEncoder().encode(".") })).toThrow();
    expect(() => decodeFilenameComponent({ bytes: new TextEncoder().encode("..") })).toThrow();
    expect(() => decodeFilenameComponent({ bytes: new TextEncoder().encode("contains/slash") })).toThrow();
    expect(() => decodeSymlinkTarget({ bytes: new TextEncoder().encode("contains\0nul") })).toThrow();
  });

  it("freezes required and optional Record Reference wire forms", () => {
    const fields = {
      byteOffset: createUInt64({ value: 64n }),
      frameLength: 88,
      recordKind: 1,
      segmentId: parseSegmentId({
        bytes: Uint8Array.from({ length: 16 }, (_, index) => index + 1),
      }),
    };
    const expected = "0102030405060708090a0b0c0d0e0f1000000000000000400000005801000000";
    expect(toHex({ bytes: encodeHomeRecordReference({ reference: createHomeRecordReference({ fields }) }) })).toBe(expected);
    expect(toHex({ bytes: encodePhysicalRecordReference({ reference: createPhysicalRecordReference({ fields }) }) })).toBe(expected);
    expect(toHex({ bytes: encodeOptionalHomeRecordReference({ reference: null }) })).toBe("00".repeat(32));
    expect(toHex({ bytes: encodeOptionalPhysicalRecordReference({ reference: null }) })).toBe("00".repeat(32));
  });

  it("freezes purpose-specific crypto context framing independently from current crypto execution", () => {
    const fileSystemId = parseFileSystemId({ value: "abcdefghijklmnopqrstu" });
    const slotId = parseCredentialSlotId({ value: "ABCDEFGHIJKLMNOPQRSTU" });
    const homeSegmentId = parseSegmentId({ bytes: fromHex({ value: "0102030405060708090a0b0c0d0e0f10" }) });
    const salt = fromHex({ value: "000102030405060708090a0b0c0d0e0f" });
    const methodParameters = new Uint8Array(32);
    methodParameters.set(salt, 0);
    new DataView(methodParameters.buffer).setUint32(16, 600_000, false);
    methodParameters.set(fromHex({ value: "15161718191a1b1c1d1e1f20" }), 20);

    expect(toHex({ bytes: encodeRecordKeyContext({ fileSystemId, homeSegmentId }) })).toBe(
      "01001448697a6f46532f76312f7265636f72642d6b6579000200000000000000156162636465666768696a6b6c6d6e6f70717273747500000000000000100102030405060708090a0b0c0d0e0f10",
    );
    expect(toHex({ bytes: encodeRecordAad({
      completeFrameHeader: fromHex({ value: "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f" }),
      fileSystemId,
    }) })).toBe(
      "01001448697a6f46532f76312f7265636f72642d616164000200000000000000156162636465666768696a6b6c6d6e6f7071727374750000000000000040000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f",
    );
    expect(toHex({ bytes: encodePassphraseSlotKdfContext({ fileSystemId, salt, slotId }) })).toBe(
      "01001d48697a6f46532f76312f706173737068726173652d736c6f742d6b6466000300000000000000156162636465666768696a6b6c6d6e6f70717273747500000000000000154142434445464748494a4b4c4d4e4f5051525354550000000000000010000102030405060708090a0b0c0d0e0f",
    );
    expect(toHex({ bytes: encodePassphraseSlotAad({
      fileSystemId,
      formatVersion: 1,
      method: HIZOFS_V1_PASSPHRASE_CREDENTIAL_METHOD.id,
      methodParameters,
      methodVersion: 1,
      slotId,
    }) })).toBe(
      "01001d48697a6f46532f76312f706173737068726173652d736c6f742d61616400060000000000000002000100000000000000156162636465666768696a6b6c6d6e6f70717273747500000000000000154142434445464748494a4b4c4d4e4f5051525354550000000000000029706173737068726173655f70626b6466325f686d61635f7368613235365f6165735f3235365f67636d0000000000000004000000010000000000000020000102030405060708090a0b0c0d0e0f000927c015161718191a1b1c1d1e1f20",
    );
    expect(toHex({ bytes: encodeSuperblockAad({
      exactHeader: fromHex({ value: "000306090c0f1215181b1e2124272a2d303336393c3f4245484b4e5154575a5d606366696c6f7275787b7e8184878a8d909396999c9fa2a5a8abaeb1b4b7babdc0c3c6c9cccfd2d5d8dbdee1e4e7eaed" }),
    }) })).toBe(
      "01001848697a6f46532f76312f7375706572626c6f636b2d61616400010000000000000050000306090c0f1215181b1e2124272a2d303336393c3f4245484b4e5154575a5d606366696c6f7275787b7e8184878a8d909396999c9fa2a5a8abaeb1b4b7babdc0c3c6c9cccfd2d5d8dbdee1e4e7eaed",
    );
    expect(toHex({ bytes: encodeSuperblockKeyContext({
      copy: 1,
      fileSystemId,
      publicationSequence: createPublicationSequence({ value: 7n }),
    }) })).toBe(
      "01001848697a6f46532f76312f7375706572626c6f636b2d6b6579000300000000000000156162636465666768696a6b6c6d6e6f70717273747500000000000000010100000000000000080000000000000007",
    );
    expect(toHex({ bytes: encodeSegmentHeaderKeyContext({
      fileSystemId,
      physicalSegmentId: homeSegmentId,
      segmentClass: 1,
    }) })).toBe(
      "01001c48697a6f46532f76312f7365676d656e742d6865616465722d6b6579000300000000000000156162636465666768696a6b6c6d6e6f70717273747500000000000000100102030405060708090a0b0c0d0e0f10000000000000000101",
    );
    expect(toHex({ bytes: encodeSegmentHeaderAad({
      fileSystemId,
      segmentHeaderPrefix: Uint8Array.from({ length: 48 }, (_, index) => index * 3),
    }) })).toBe(
      "01001c48697a6f46532f76312f7365676d656e742d6865616465722d616164000200000000000000156162636465666768696a6b6c6d6e6f7071727374750000000000000030000306090c0f1215181b1e2124272a2d303336393c3f4245484b4e5154575a5d606366696c6f7275787b7e8184878a8d",
    );
    expect(toHex({ bytes: encodeSegmentFooterKeyContext({
      fileSystemId,
      physicalSegmentId: homeSegmentId,
    }) })).toBe(
      "01001c48697a6f46532f76312f7365676d656e742d666f6f7465722d6b6579000200000000000000156162636465666768696a6b6c6d6e6f70717273747500000000000000100102030405060708090a0b0c0d0e0f10",
    );
    expect(toHex({ bytes: encodeSegmentFooterAad({
      fileSystemId,
      footerHeader: fromHex({ value: "00050a0f14191e23282d32373c41464b50555a5f64696e73787d82878c91969ba0a5aaafb4b9bec3c8cdd2d7dce1e6ebf0f5faff04090e13181d22272c31363b" }),
      footerTrailer: fromHex({ value: "00070e151c232a31383f464d545b626970777e858c939aa1a8afb6bdc4cbd2d9" }),
    }) })).toBe(
      "01001c48697a6f46532f76312f7365676d656e742d666f6f7465722d616164000300000000000000156162636465666768696a6b6c6d6e6f707172737475000000000000004000050a0f14191e23282d32373c41464b50555a5f64696e73787d82878c91969ba0a5aaafb4b9bec3c8cdd2d7dce1e6ebf0f5faff04090e13181d22272c31363b000000000000002000070e151c232a31383f464d545b626970777e858c939aa1a8afb6bdc4cbd2d9",
    );
    expect(toHex({ bytes: encodeUnlockAuthenticatorAad({
      canonicalUnsignedEnvelopeBytes: fromHex({ value: "7b22666f726d6174223a2268697a6f66732d756e6c6f636b227d0a" }),
    }) })).toBe(
      "01002248697a6f46532f76312f756e6c6f636b2d61757468656e74696361746f722d6161640001000000000000001b7b22666f726d6174223a2268697a6f66732d756e6c6f636b227d0a",
    );
    expect(toHex({ bytes: encodeUnlockAuthenticatorKeyContext({
      copy: 0,
      fileSystemId,
      unlockSequence: createUnlockSequence({ value: 1n }),
    }) })).toBe(
      "01002248697a6f46532f76312f756e6c6f636b2d61757468656e74696361746f722d6b6579000300000000000000156162636465666768696a6b6c6d6e6f70717273747500000000000000010000000000000000080000000000000001",
    );
  });

  it("freezes exact Segment Footer header, index-entry, and trailer bytes", () => {
    const segmentId = parseSegmentId({ bytes: Uint8Array.from({ length: 16 }, (_, index) => index + 1) });
    const footerHeader = createSegmentFooterHeader({
      entryCount: 1,
      nonce: Uint8Array.from({ length: 12 }, (_, index) => index + 20),
      physicalSegmentId: segmentId,
      segmentClass: "metadata",
      segmentDataLength: createUInt64({ value: 128n }),
    });
    expect(toHex({ bytes: encodeSegmentFooterHeader({ header: footerHeader }) })).toBe(
      "485a464f4f54455200010040010000000102030405060708090a0b0c0d0e0f10000000000000008000000001000000301415161718191a1b1c1d1e1f00000000",
    );
    expect(toHex({ bytes: encodeSegmentFooterIndexEntry({ entry: {
      flags: 0,
      frameLength: 88,
      homeOffset: createUInt64({ value: 64n }),
      homeSegmentId: segmentId,
      physicalOffset: createUInt64({ value: 64n }),
      plaintextLength: 1,
      recordCodecVersion: 1,
      recordKind: 34,
    } }) })).toBe(
      "00000000000000400000005800000001220000010102030405060708090a0b0c0d0e0f10000000000000004000000000",
    );
    expect(toHex({ bytes: encodeSegmentFooterTrailer({ trailer: {
      footerTotalLength: 160,
      physicalSegmentId: segmentId,
    } }) })).toBe(
      "485a545241494c5200010020000000a00102030405060708090a0b0c0d0e0f10",
    );
  });

  it("freezes exact Segment, Record Frame, and Superblock header bytes", () => {
    const segmentId = parseSegmentId({ bytes: Uint8Array.from({ length: 16 }, (_, index) => index + 1) });
    expect(toHex({ bytes: encodeSegmentHeader({ header: {
      authenticationTag: Uint8Array.from({ length: 16 }, (_, index) => 0xa0 + index),
      physicalSegmentId: segmentId,
      segmentClass: "metadata",
    } }) })).toBe(
      "485a5345474d4e5400010040010000000102030405060708090a0b0c0d0e0f1000000000000000000000000000000000a0a1a2a3a4a5a6a7a8a9aaabacadaeaf",
    );

    const recordHeader = createRecordFrameHeader({
      flags: 0,
      homeOffset: createUInt64({ value: 64n }),
      homeSegmentId: segmentId,
      nonce: Uint8Array.from({ length: 12 }, (_, index) => index + 20),
      plaintextLength: 1,
      recordKind: 1,
    });
    expect(toHex({ bytes: encodeRecordFrameHeader({ header: recordHeader }) })).toBe(
      "485a5245434f524400010040010000010102030405060708090a0b0c0d0e0f1000000000000000400000000100000011000000581415161718191a1b1c1d1e1f",
    );

    const superblockHeader = createSuperblockHeader({
      activeCommitSequence: createCommitSequence({ value: 1n }),
      copy: 0,
      fileSystemId: parseFileSystemId({ value: "0123456789_ABCDEFGHIJ" }),
      flags: 0,
      nonce: Uint8Array.from({ length: 12 }, (_, index) => index),
      publicationSequence: createPublicationSequence({ value: 1n }),
    });
    expect(toHex({ bytes: encodeSuperblockHeader({ header: superblockHeader }) })).toBe(
      "485a53424c4f434b0001005000000000000000000000000100000000000000010000009015303132333435363738395f4142434445464748494a000102030405060708090a0b00000000000000000000",
    );
  });

  it("rejects hardcoded V1 framing variants that violate reserved-byte and required-reference rules", () => {
    const segmentHeader = fromHex({
      value: "485a5345474d4e5400010040010000000102030405060708090a0b0c0d0e0f1000000000000000000000000000000000a0a1a2a3a4a5a6a7a8a9aaabacadaeaf",
    });
    for (const offset of [13, 14, 15, ...Array.from({ length: 16 }, (_, index) => index + 32)]) {
      const damaged = Uint8Array.from(segmentHeader);
      damaged[offset] = 1;
      expect(() => decodeSegmentHeader({ bytes: damaged })).toThrow();
    }

    const footerHeader = fromHex({
      value: "485a464f4f54455200010040010000000102030405060708090a0b0c0d0e0f10000000000000008000000001000000301415161718191a1b1c1d1e1f00000000",
    });
    for (const offset of [13, 14, 15, 60, 61, 62, 63]) {
      const damaged = Uint8Array.from(footerHeader);
      damaged[offset] = 1;
      expect(() => decodeSegmentFooterHeader({ bytes: damaged })).toThrow();
    }

    const footerIndexEntry = fromHex({
      value: "00000000000000400000005800000001220000010102030405060708090a0b0c0d0e0f10000000000000004000000000",
    });
    for (const offset of [44, 45, 46, 47]) {
      const damaged = Uint8Array.from(footerIndexEntry);
      damaged[offset] = 1;
      expect(() => decodeSegmentFooterIndexEntry({ bytes: damaged })).toThrow();
    }

    const superblockHeader = fromHex({
      value: "485a53424c4f434b0001005000000000000000000000000100000000000000010000009015303132333435363738395f4142434445464748494a000102030405060708090a0b00000000000000000000",
    });
    for (const offset of [14, 15, ...Array.from({ length: 10 }, (_, index) => index + 70)]) {
      const damaged = Uint8Array.from(superblockHeader);
      damaged[offset] = 1;
      expect(() => decodeSuperblockHeader({ bytes: damaged })).toThrow();
    }

    const requiredReference = fromHex({
      value: "0102030405060708090a0b0c0d0e0f1000000000000000400000005801000000",
    });
    expect(() => decodeRequiredHomeRecordReference({ bytes: new Uint8Array(32) })).toThrow();
    const reservedReference = Uint8Array.from(requiredReference);
    reservedReference[29] = 1;
    expect(() => decodeRequiredHomeRecordReference({ bytes: reservedReference })).toThrow();
    const unknownKindReference = Uint8Array.from(requiredReference);
    unknownKindReference[28] = 0xff;
    expect(() => decodeRequiredHomeRecordReference({ bytes: unknownKindReference })).toThrow();
  });

  it("freezes exact Superblock plaintext and passphrase Credential parameter layouts", () => {
    const superblockPlaintextHex =
      "0102030405060708090a0b0c0d0e0f1000000000000000400000006001000000"
      + "0000000000000000000000000000000000000000000000000000000000000000"
      + "0000000000000000000000000000000000000000000000000000000000000000"
      + "2122232425262728292a2b2c2d2e2f30"
      + "3132333435363738393a3b3c3d3e3f40"
      + "0000000000000003"
      + "0000000000000000";
    const superblockPlaintextBytes = fromHex({ value: superblockPlaintextHex });
    expect(toHex({ bytes: encodeSuperblockPlaintext({
      flags: 0,
      plaintext: decodeSuperblockPlaintext({ bytes: superblockPlaintextBytes, flags: 0 }),
    }) })).toBe(superblockPlaintextHex);

    const passphraseParametersHex = "000102030405060708090a0b0c0d0e0f000927c015161718191a1b1c1d1e1f20";
    const passphraseParametersBytes = fromHex({ value: passphraseParametersHex });
    expect(toHex({ bytes: encodePassphraseCredentialParametersV1({
      parameters: decodePassphraseCredentialParametersV1({ bytes: passphraseParametersBytes }),
    }) })).toBe(passphraseParametersHex);
    expect(() => decodePassphraseCredentialParametersV1({ bytes: new Uint8Array(31) })).toThrow();
    expect(() => decodePassphraseCredentialParametersV1({ bytes: new Uint8Array(33) })).toThrow();
  });

  it("requires the exact 48-byte wrapped Root Key size for the V1 passphrase Credential method", () => {
    const zeroBase64Url = ({ byteLength }: { byteLength: number }): string =>
      "A".repeat(Math.ceil((byteLength * 8) / 6));
    const envelopeJson = ({ wrappedFileSystemRootKey }: { wrappedFileSystemRootKey: string }): string =>
      `{"format":"hizofs-unlock","formatVersion":1,"copy":0,"sequence":1,"fileSystemId":"Zbcdefghij_klmnopq-12","credentialSlots":[{"type":"credential","slotId":"Abcdefghij_klmnopq-12","method":"passphrase_pbkdf2_hmac_sha256_aes_256_gcm","methodVersion":1,"methodParameters":"AQIDBAUGBwgJCgsMDQ4PEAAJJ8AVFhcYGRobHB0eHyA","wrappedFileSystemRootKey":"${wrappedFileSystemRootKey}"}],"authenticatorNonce":"AQIDBAUGBwgJCgsM","authenticatorTag":"8PHy8_T19vf4-fr7_P3-_w"}\n`;
    const decode = ({ wrappedRootKeyBytes }: { wrappedRootKeyBytes: number }) =>
      decodeUnlockEnvelope({ bytes: new TextEncoder().encode(envelopeJson({
        wrappedFileSystemRootKey: zeroBase64Url({ byteLength: wrappedRootKeyBytes }),
      })) });

    expect(decode({ wrappedRootKeyBytes: 48 }).credentialSlots).toHaveLength(1);
    expect(() => decode({ wrappedRootKeyBytes: 47 })).toThrow();
    expect(() => decode({ wrappedRootKeyBytes: 49 })).toThrow();
  });

  it("freezes the exact canonical Unlock Envelope JSON field order and lexical form", () => {
    const envelope = {
      authenticatorNonce: "AQIDBAUGBwgJCgsM",
      authenticatorTag: "8PHy8_T19vf4-fr7_P3-_w",
      copy: 0,
      credentialSlots: [{
        method: "passphrase_pbkdf2_hmac_sha256_aes_256_gcm",
        methodParameters: "AQIDBAUGBwgJCgsMDQ4PEAAJJ8AVFhcYGRobHB0eHyA",
        methodVersion: 1,
        slotId: parseCredentialSlotId({ value: "Abcdefghij_klmnopq-12" }),
        type: "credential",
        wrappedFileSystemRootKey: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8gISIjJCUmJygpKissLS4v",
      }],
      fileSystemId: parseFileSystemId({ value: "Zbcdefghij_klmnopq-12" }),
      format: "hizofs-unlock",
      formatVersion: 1,
      sequence: 1,
    } satisfies UnlockEnvelopeV1;
    expect(new TextDecoder().decode(encodeUnlockEnvelope({ envelope }))).toBe(`\
{"format":"hizofs-unlock","formatVersion":1,"copy":0,"sequence":1,"fileSystemId":"Zbcdefghij_klmnopq-12","credentialSlots":[{"type":"credential","slotId":"Abcdefghij_klmnopq-12","method":"passphrase_pbkdf2_hmac_sha256_aes_256_gcm","methodVersion":1,"methodParameters":"AQIDBAUGBwgJCgsMDQ4PEAAJJ8AVFhcYGRobHB0eHyA","wrappedFileSystemRootKey":"AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8gISIjJCUmJygpKissLS4v"}],"authenticatorNonce":"AQIDBAUGBwgJCgsM","authenticatorTag":"8PHy8_T19vf4-fr7_P3-_w"}
`);
  });

  it("preserves a bounded unknown Credential method as canonical opaque V1 data", () => {
    const envelope = {
      authenticatorNonce: "AQIDBAUGBwgJCgsM",
      authenticatorTag: "8PHy8_T19vf4-fr7_P3-_w",
      copy: 0,
      credentialSlots: [{
        method: "future_method",
        methodParameters: "AQID",
        methodVersion: 2,
        slotId: parseCredentialSlotId({ value: "Abcdefghij_klmnopq-12" }),
        type: "credential",
        wrappedFileSystemRootKey: "BAU",
      }],
      fileSystemId: parseFileSystemId({ value: "Zbcdefghij_klmnopq-12" }),
      format: "hizofs-unlock",
      formatVersion: 1,
      sequence: 1,
    } satisfies UnlockEnvelopeV1;
    const expected = `\
{"format":"hizofs-unlock","formatVersion":1,"copy":0,"sequence":1,"fileSystemId":"Zbcdefghij_klmnopq-12","credentialSlots":[{"type":"credential","slotId":"Abcdefghij_klmnopq-12","method":"future_method","methodVersion":2,"methodParameters":"AQID","wrappedFileSystemRootKey":"BAU"}],"authenticatorNonce":"AQIDBAUGBwgJCgsM","authenticatorTag":"8PHy8_T19vf4-fr7_P3-_w"}
`;
    const encoded = encodeUnlockEnvelope({ envelope });
    expect(new TextDecoder().decode(encoded)).toBe(expected);
    expect(decodeUnlockEnvelope({ bytes: new TextEncoder().encode(expected) })).toEqual(envelope);
  });

  it("accepts opaque unknown-Credential fields at the V1 byte limit and rejects one byte beyond it", () => {
    const zeroBase64Url = ({ byteLength }: { byteLength: number }): string =>
      "A".repeat(Math.ceil((byteLength * 8) / 6));
    const envelopeJson = ({ methodParameters, wrappedFileSystemRootKey }: {
      methodParameters: string;
      wrappedFileSystemRootKey: string;
    }): string => `{"format":"hizofs-unlock","formatVersion":1,"copy":0,"sequence":1,"fileSystemId":"Zbcdefghij_klmnopq-12","credentialSlots":[{"type":"credential","slotId":"Abcdefghij_klmnopq-12","method":"future_method","methodVersion":2,"methodParameters":"${methodParameters}","wrappedFileSystemRootKey":"${wrappedFileSystemRootKey}"}],"authenticatorNonce":"AQIDBAUGBwgJCgsM","authenticatorTag":"8PHy8_T19vf4-fr7_P3-_w"}\n`;
    const decode = ({ methodParametersBytes, wrappedRootKeyBytes }: {
      methodParametersBytes: number;
      wrappedRootKeyBytes: number;
    }) => decodeUnlockEnvelope({ bytes: new TextEncoder().encode(envelopeJson({
      methodParameters: zeroBase64Url({ byteLength: methodParametersBytes }),
      wrappedFileSystemRootKey: zeroBase64Url({ byteLength: wrappedRootKeyBytes }),
    })) });

    const maximum = 4096;
    expect(decode({ methodParametersBytes: maximum, wrappedRootKeyBytes: maximum }).credentialSlots).toHaveLength(1);
    expect(() => decode({ methodParametersBytes: maximum + 1, wrappedRootKeyBytes: maximum })).toThrow();
    expect(() => decode({ methodParametersBytes: maximum, wrappedRootKeyBytes: maximum + 1 })).toThrow();
  });

  it("accepts the maximum opaque Credential method version and rejects one beyond V1 u32", () => {
    const envelopeJson = ({ methodVersion }: { methodVersion: string }): string =>
      `{"format":"hizofs-unlock","formatVersion":1,"copy":0,"sequence":1,"fileSystemId":"Zbcdefghij_klmnopq-12","credentialSlots":[{"type":"credential","slotId":"Abcdefghij_klmnopq-12","method":"future_method","methodVersion":${methodVersion},"methodParameters":"AQID","wrappedFileSystemRootKey":"BAU"}],"authenticatorNonce":"AQIDBAUGBwgJCgsM","authenticatorTag":"8PHy8_T19vf4-fr7_P3-_w"}\n`;
    const decode = ({ methodVersion }: { methodVersion: string }) =>
      decodeUnlockEnvelope({ bytes: new TextEncoder().encode(envelopeJson({ methodVersion })) });

    expect(decode({ methodVersion: "4294967295" }).credentialSlots[0]?.methodVersion).toBe(4294967295);
    expect(() => decode({ methodVersion: "4294967296" })).toThrow();
    expect(() => decode({ methodVersion: "-1" })).toThrow();
  });

  it("accepts exactly 32 bounded Credential Slots and rejects a 33rd canonical Slot", () => {
    const prefixes = [..."0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ"].slice(0, 33);
    const slot = ({ prefix }: { prefix: string }) => ({
      method: "future_method",
      methodParameters: "AQID",
      methodVersion: 2,
      slotId: parseCredentialSlotId({ value: `${prefix}bcdefghij_klmnopq-12` }),
      type: "credential" as const,
      wrappedFileSystemRootKey: "BAU",
    });
    const acceptedSlots = prefixes.slice(0, 32).map(prefix => slot({ prefix }));
    const envelope = {
      authenticatorNonce: "AQIDBAUGBwgJCgsM",
      authenticatorTag: "8PHy8_T19vf4-fr7_P3-_w",
      copy: 0,
      credentialSlots: acceptedSlots,
      fileSystemId: parseFileSystemId({ value: "Zbcdefghij_klmnopq-12" }),
      format: "hizofs-unlock",
      formatVersion: 1,
      sequence: 1,
    } satisfies UnlockEnvelopeV1;
    const encoded = encodeUnlockEnvelope({ envelope });
    expect(decodeUnlockEnvelope({ bytes: encoded }).credentialSlots).toHaveLength(32);

    const extra = slot({ prefix: prefixes[32]! });
    const extraJson = `{"type":"credential","slotId":"${extra.slotId}","method":"${extra.method}","methodVersion":${extra.methodVersion},"methodParameters":"${extra.methodParameters}","wrappedFileSystemRootKey":"${extra.wrappedFileSystemRootKey}"}`;
    const overLimit = new TextDecoder().decode(encoded).replace(
      `],"authenticatorNonce"`,
      `,${extraJson}],"authenticatorNonce"`,
    );
    expect(() => decodeUnlockEnvelope({ bytes: new TextEncoder().encode(overLimit) })).toThrow();
  });

  it("enforces hardcoded V1 passphrase work bounds independently from writer defaults", () => {
    const wrappedRootKey = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8gISIjJCUmJygpKissLS4v";
    const slotJson = ({ methodParameters, slotId }: { methodParameters: string; slotId: string }): string =>
      `{"type":"credential","slotId":"${slotId}","method":"passphrase_pbkdf2_hmac_sha256_aes_256_gcm","methodVersion":1,"methodParameters":"${methodParameters}","wrappedFileSystemRootKey":"${wrappedRootKey}"}`;
    const envelopeJson = ({ slots }: { slots: readonly string[] }): string => `{"format":"hizofs-unlock","formatVersion":1,"copy":0,"sequence":1,"fileSystemId":"Zbcdefghij_klmnopq-12","credentialSlots":[${slots.join(",")}],"authenticatorNonce":"AQIDBAUGBwgJCgsM","authenticatorTag":"8PHy8_T19vf4-fr7_P3-_w"}\n`;
    const decode = ({ slots }: { slots: readonly string[] }) => decodeUnlockEnvelope({ bytes: new TextEncoder().encode(envelopeJson({ slots })) });

    const minimum = "AAECAwQFBgcICQoLDA0ODwAJJ8AVFhcYGRobHB0eHyA";
    const belowMinimum = "AAECAwQFBgcICQoLDA0ODwAJJ78VFhcYGRobHB0eHyA";
    const maximum = "AAECAwQFBgcICQoLDA0ODwCYloAVFhcYGRobHB0eHyA";
    const aboveMaximum = "AAECAwQFBgcICQoLDA0ODwCYloEVFhcYGRobHB0eHyA";

    expect(decode({ slots: [slotJson({ methodParameters: minimum, slotId: "Abcdefghij_klmnopq-12" })] }).credentialSlots).toHaveLength(1);
    expect(decode({ slots: [slotJson({ methodParameters: maximum, slotId: "Abcdefghij_klmnopq-12" })] }).credentialSlots).toHaveLength(1);
    expect(() => decode({ slots: [slotJson({ methodParameters: belowMinimum, slotId: "Abcdefghij_klmnopq-12" })] })).toThrow();
    expect(() => decode({ slots: [slotJson({ methodParameters: aboveMaximum, slotId: "Abcdefghij_klmnopq-12" })] })).toThrow();

    const twoMaximumSlots = [
      slotJson({ methodParameters: maximum, slotId: "Abcdefghij_klmnopq-12" }),
      slotJson({ methodParameters: maximum, slotId: "Bbcdefghij_klmnopq-12" }),
    ];
    expect(decode({ slots: twoMaximumSlots }).credentialSlots).toHaveLength(2);
    expect(() => decode({ slots: [
      ...twoMaximumSlots,
      slotJson({ methodParameters: maximum, slotId: "Cbcdefghij_klmnopq-12" }),
    ] })).toThrow();
  });

  it("rejects duplicate or non-canonically ordered Credential Slots instead of normalizing them", () => {
    const slotJson = ({ slotId }: { slotId: string }): string =>
      `{"type":"credential","slotId":"${slotId}","method":"future_method","methodVersion":2,"methodParameters":"AQID","wrappedFileSystemRootKey":"BAU"}`;
    const envelopeJson = ({ slots }: { slots: readonly string[] }): string =>
      `{"format":"hizofs-unlock","formatVersion":1,"copy":0,"sequence":1,"fileSystemId":"Zbcdefghij_klmnopq-12","credentialSlots":[${slots.join(",")}],"authenticatorNonce":"AQIDBAUGBwgJCgsM","authenticatorTag":"8PHy8_T19vf4-fr7_P3-_w"}\n`;
    const first = slotJson({ slotId: "Abcdefghij_klmnopq-12" });
    const second = slotJson({ slotId: "Bbcdefghij_klmnopq-12" });
    const decode = ({ slots }: { slots: readonly string[] }) =>
      decodeUnlockEnvelope({ bytes: new TextEncoder().encode(envelopeJson({ slots })) });

    expect(decode({ slots: [first, second] }).credentialSlots).toHaveLength(2);
    expect(() => decode({ slots: [second, first] })).toThrow();
    expect(() => decode({ slots: [first, first] })).toThrow();
  });

  it("rejects semantically equivalent Unlock Envelope JSON that is not canonical V1 bytes", () => {
    const canonical = `\
{"format":"hizofs-unlock","formatVersion":1,"copy":0,"sequence":1,"fileSystemId":"Zbcdefghij_klmnopq-12","credentialSlots":[{"type":"credential","slotId":"Abcdefghij_klmnopq-12","method":"passphrase_pbkdf2_hmac_sha256_aes_256_gcm","methodVersion":1,"methodParameters":"AQIDBAUGBwgJCgsMDQ4PEAAJJ8AVFhcYGRobHB0eHyA","wrappedFileSystemRootKey":"AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8gISIjJCUmJygpKissLS4v"}],"authenticatorNonce":"AQIDBAUGBwgJCgsM","authenticatorTag":"8PHy8_T19vf4-fr7_P3-_w"}
`;
    const reordered = canonical.replace(
      `"format":"hizofs-unlock","formatVersion":1`,
      `"formatVersion":1,"format":"hizofs-unlock"`,
    );
    const spaced = canonical.replace(`"copy":0`, `"copy": 0`);
    const missingTerminalLf = canonical.slice(0, -1);
    const nonCanonicalInteger = canonical.replace(`"sequence":1`, `"sequence":1.0`);

    expect(() => decodeUnlockEnvelope({ bytes: new TextEncoder().encode(reordered) })).toThrow();
    expect(() => decodeUnlockEnvelope({ bytes: new TextEncoder().encode(spaced) })).toThrow();
    expect(() => decodeUnlockEnvelope({ bytes: new TextEncoder().encode(missingTerminalLf) })).toThrow();
    expect(() => decodeUnlockEnvelope({ bytes: new TextEncoder().encode(nonCanonicalInteger) })).toThrow();
  });

  it("freezes exact representative record payload bytes across decode and encode", () => {
    const fileDataHex = "0001027f80feff";
    const fileData = decodeFileDataPayload({ bytes: fromHex({ value: fileDataHex }) });
    const { bytes: fileDataBytes, ...unhandledFileData } = fileData;
    unhandledFileData satisfies Record<PropertyKey, never>;
    expect(toHex({ bytes: encodeFileDataPayload({ payload: { bytes: fileDataBytes } }) })).toBe(fileDataHex);

    const fileSystemCommitHex = "00000000000000050102030405060708090a0b0c0d0e0f1000000000000000011111111111111111111111111111111100000000000000400000005810000000000000000000000000000000000000000000000000000000000000000000000000000000000000020000000000000002";
    const fileSystemCommit = fromHex({ value: fileSystemCommitHex });
    expect(toHex({ bytes: encodeFileSystemCommitPayload({ payload: decodeFileSystemCommitPayload({ bytes: fileSystemCommit }) }) })).toBe(fileSystemCommitHex);

    const inodeBranchHex = "0100000100000000000000092222222222222222222222222222222200000000000000400000005810000000";
    const inodeBranch = fromHex({ value: inodeBranchHex });
    expect(toHex({ bytes: encodeInodeBranchPage({
      isRoot: true,
      page: decodeInodeBranchPage({ bytes: inodeBranch, isRoot: true }),
    }) })).toBe(inodeBranchHex);

    const fileExtentLeafHex = "00000001000000000000000000000004000000003333333333333333333333333333333300000000000000400000005822000000";
    const fileExtentLeaf = fromHex({ value: fileExtentLeafHex });
    expect(toHex({ bytes: encodeFileExtentPage({
      isRoot: true,
      page: decodeFileExtentPage({ bytes: fileExtentLeaf, isRoot: true }),
    }) })).toBe(fileExtentLeafHex);

    const inodeLeafHex = "000000040050020000000000000000010000000000000001010003001701010009000000000000000268656c6c6f2e7478740011010200030000000000000003737562001101030003000000000000000473796d0035010300000000000000020000000000000003fffffffffffffff60000000000000014000000000000000601000668656c6c6f0a0017020000000000000000030000000000000001010000002a030200000000000000040000000000000002000000000000001e000c2e2e2f68656c6c6f2e747874";
    const inodeLeaf = decodeInodeLeafPage({ bytes: fromHex({ value: inodeLeafHex }), isRoot: true });
    const { entries, level, type, ...unhandledInodeLeaf } = inodeLeaf;
    unhandledInodeLeaf satisfies Record<PropertyKey, never>;
    expect(level).toBe(0);
    expect(type).toBe("leaf");
    expect(toHex({ bytes: encodeInodeLeafPage({ entries, isRoot: true }) })).toBe(inodeLeafHex);
  });

  it("rejects a hardcoded Directory leaf whose entries are not in canonical UTF-8 order", () => {
    const swappedDirectoryLeafHex = "000000020011020000030000000000000002737562000f01010001000000000000000561";
    expect(() => decodeDirectoryPage({
      bytes: fromHex({ value: swappedDirectoryLeafHex }),
      isRoot: true,
    })).toThrow();
  });

  it("freezes exact V1 page bytes for nested Subvolume, Directory, and Relocation Index layouts", () => {
    const nestedBranchHex = "0100000100000000000000070102030405060708090a0b0c0d0e0f1000000000000000400000006002000000";
    const nestedBranch = fromHex({ value: nestedBranchHex });
    expect(toHex({ bytes: encodeNestedSubvolumeBranchPage({
      isRoot: true,
      page: decodeNestedSubvolumeBranchPage({ bytes: nestedBranch, isRoot: true }),
    }) })).toBe(nestedBranchHex);

    const nestedLeafHex = "00000001004902000000000000000002000000000000000102030405060708090a0b0c0d0e0f101100000000000000400000006010000000000000000000000100000000000000030003737562";
    const nestedLeaf = fromHex({ value: nestedLeafHex });
    const nestedLeafPage = decodeNestedSubvolumeLeafPage({ bytes: nestedLeaf, isRoot: true });
    const { entries: nestedLeafEntries, level: nestedLeafLevel, type: nestedLeafType, ...unhandledNestedLeaf } = nestedLeafPage;
    unhandledNestedLeaf satisfies Record<PropertyKey, never>;
    expect(nestedLeafLevel).toBe(0);
    expect(nestedLeafType).toBe("leaf");
    expect(toHex({ bytes: encodeNestedSubvolumeLeafPage({ entries: nestedLeafEntries, isRoot: true }) })).toBe(nestedLeafHex);

    const directoryLeafHex = "00000002000f010100010000000000000005610011020000030000000000000002737562";
    const directoryLeaf = fromHex({ value: directoryLeafHex });
    expect(toHex({ bytes: encodeDirectoryPage({
      isRoot: true,
      page: decodeDirectoryPage({ bytes: directoryLeaf, isRoot: true }),
    }) })).toBe(directoryLeafHex);

    const directoryBranchHex = "0100000100250001030405060708090a0b0c0d0e0f101112000000000000004000000060200000006d";
    const directoryBranch = fromHex({ value: directoryBranchHex });
    expect(toHex({ bytes: encodeDirectoryPage({
      isRoot: true,
      page: decodeDirectoryPage({ bytes: directoryBranch, isRoot: true }),
    }) })).toBe(directoryBranchHex);

    const relocationLeafHex = "000000010405060708090a0b0c0d0e0f10111213000000000000004005060708090a0b0c0d0e0f101112131400000000000000400000006022000000";
    const relocationLeaf = fromHex({ value: relocationLeafHex });
    expect(toHex({ bytes: encodeRelocationIndexPage({
      isRoot: true,
      page: decodeRelocationIndexPage({ bytes: relocationLeaf, isRoot: true }),
    }) })).toBe(relocationLeafHex);

    const relocationBranchHex = "01000001060708090a0b0c0d0e0f10111213141500000000000000400708090a0b0c0d0e0f1011121314151600000000000000400000006030000000";
    const relocationBranch = fromHex({ value: relocationBranchHex });
    expect(toHex({ bytes: encodeRelocationIndexPage({
      isRoot: true,
      page: decodeRelocationIndexPage({ bytes: relocationBranch, isRoot: true }),
    }) })).toBe(relocationBranchHex);
  });

});
