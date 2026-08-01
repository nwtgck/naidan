import assert from "node:assert/strict";
import { Buffer } from "node:buffer";

const FILE_SYSTEM_COMMIT_BYTES = 112;
const COMMON_PAGE_HEADER_BYTES = 4;
const RECORD_REFERENCE_BYTES = 32;
const METADATA_PLAINTEXT_MAXIMUM_BYTES = 65_536;
const FILE_DATA_PLAINTEXT_MAXIMUM_BYTES = 1_048_576;
const UINT64_MAXIMUM = 0xffff_ffff_ffff_ffffn;

const RECORD_KINDS = Object.freeze({
  directoryPage: 32,
  fileData: 34,
  fileExtentPage: 33,
  fileSystemCommit: 1,
  inodeTablePage: 16,
  nestedSubvolumeTablePage: 2,
  relocationIndexPage: 48,
});
const KNOWN_RECORD_KINDS = new Set(Object.values(RECORD_KINDS));

function fromHex({ label, value }) {
  if (typeof value !== "string" || value.length % 2 !== 0 || !/^[0-9a-f]*$/u.test(value)) {
    throw new TypeError(`${label} must be lowercase byte-aligned hex`);
  }
  return Buffer.from(value, "hex");
}

function toHex({ value }) {
  return Buffer.from(value).toString("hex");
}

function isAllZero({ bytes }) {
  return bytes.every(byte => byte === 0);
}

function validateRandomId16({ bytes, label }) {
  if (bytes.length !== 16) throw new RangeError(`${label} must be exactly 16 bytes`);
  if (isAllZero({ bytes })) throw new TypeError(`${label} must not be all-zero`);
}

function validateRecordReference({ reference }) {
  validateRandomId16({ bytes: reference.segmentId, label: "Segment ID" });
  if (reference.byteOffset < 64n || reference.byteOffset % 8n !== 0n) {
    throw new RangeError("Record Reference byte offset must be aligned and after the Segment Header");
  }
  if (!Number.isInteger(reference.frameLength) || reference.frameLength < 88 || reference.frameLength % 8 !== 0) {
    throw new RangeError("Record Reference frame length must be aligned and at least 88 bytes");
  }
  if (reference.byteOffset + BigInt(reference.frameLength) > UINT64_MAXIMUM) {
    throw new RangeError("Record Reference range exceeds u64");
  }
  if (!KNOWN_RECORD_KINDS.has(reference.recordKind)) {
    throw new TypeError("Record Reference kind is unknown");
  }
}

export function decodeRequiredRecordReference({ bytes }) {
  if (!Buffer.isBuffer(bytes) || bytes.length !== RECORD_REFERENCE_BYTES) {
    throw new RangeError("Record Reference must be exactly 32 bytes");
  }
  if (isAllZero({ bytes })) throw new TypeError("required Record Reference must not be all-zero");
  if (bytes[29] !== 0 || bytes[30] !== 0 || bytes[31] !== 0) {
    throw new TypeError("Record Reference flags and reserved bytes must be zero");
  }
  const reference = Object.freeze({
    byteOffset: bytes.readBigUInt64BE(16),
    frameLength: bytes.readUInt32BE(24),
    recordKind: bytes[28],
    segmentId: Buffer.from(bytes.subarray(0, 16)),
  });
  validateRecordReference({ reference });
  return reference;
}

export function decodeOptionalRecordReference({ bytes }) {
  if (!Buffer.isBuffer(bytes) || bytes.length !== RECORD_REFERENCE_BYTES) {
    throw new RangeError("Record Reference must be exactly 32 bytes");
  }
  return isAllZero({ bytes }) ? null : decodeRequiredRecordReference({ bytes });
}

function encodeRecordReference({ reference }) {
  validateRecordReference({ reference });
  const bytes = Buffer.alloc(RECORD_REFERENCE_BYTES);
  Buffer.from(reference.segmentId).copy(bytes, 0);
  bytes.writeBigUInt64BE(reference.byteOffset, 16);
  bytes.writeUInt32BE(reference.frameLength, 24);
  bytes[28] = reference.recordKind;
  return bytes;
}

function encodeOptionalRecordReference({ reference }) {
  return reference === null ? Buffer.alloc(RECORD_REFERENCE_BYTES) : encodeRecordReference({ reference });
}

function assertReferenceKind({ expected, label, reference }) {
  if (reference.recordKind !== expected) throw new TypeError(`${label} has the wrong record kind`);
}

export function decodeFileSystemCommit({ bytes }) {
  if (bytes.length !== FILE_SYSTEM_COMMIT_BYTES) {
    throw new RangeError("File System Commit payload must be exactly 112 bytes");
  }
  const payload = Object.freeze({
    commitSequence: bytes.readBigUInt64BE(0),
    mutationId: Buffer.from(bytes.subarray(8, 24)),
    rootDirectoryInodeNumber: bytes.readBigUInt64BE(24),
    rootInodeTableRootHomeRef: decodeRequiredRecordReference({ bytes: bytes.subarray(32, 64) }),
    nestedSubvolumeTableRootHomeRef: decodeOptionalRecordReference({ bytes: bytes.subarray(64, 96) }),
    nextInodeNumber: bytes.readBigUInt64BE(96),
    nextSubvolumeId: bytes.readBigUInt64BE(104),
  });
  validateRandomId16({ bytes: payload.mutationId, label: "Mutation ID" });
  if (payload.commitSequence < 1n) throw new RangeError("Commit Sequence must be at least 1");
  if (payload.rootDirectoryInodeNumber < 1n) throw new RangeError("root directory Inode Number must be at least 1");
  if (payload.nextInodeNumber < 2n) throw new RangeError("next Inode Number must be at least 2");
  if (payload.nextSubvolumeId < 2n) throw new RangeError("next Subvolume ID must be at least 2");
  assertReferenceKind({
    expected: RECORD_KINDS.inodeTablePage,
    label: "root Inode Table reference",
    reference: payload.rootInodeTableRootHomeRef,
  });
  if (payload.nestedSubvolumeTableRootHomeRef !== null) {
    assertReferenceKind({
      expected: RECORD_KINDS.nestedSubvolumeTablePage,
      label: "nested Subvolume Table reference",
      reference: payload.nestedSubvolumeTableRootHomeRef,
    });
  }
  return payload;
}

function encodeFileSystemCommit({ payload }) {
  const bytes = Buffer.alloc(FILE_SYSTEM_COMMIT_BYTES);
  bytes.writeBigUInt64BE(payload.commitSequence, 0);
  Buffer.from(payload.mutationId).copy(bytes, 8);
  bytes.writeBigUInt64BE(payload.rootDirectoryInodeNumber, 24);
  encodeRecordReference({ reference: payload.rootInodeTableRootHomeRef }).copy(bytes, 32);
  encodeOptionalRecordReference({ reference: payload.nestedSubvolumeTableRootHomeRef }).copy(bytes, 64);
  bytes.writeBigUInt64BE(payload.nextInodeNumber, 96);
  bytes.writeBigUInt64BE(payload.nextSubvolumeId, 104);
  return bytes;
}

function decodeCommonPageHeader({ bytes, entryBytes, requireBranch }) {
  if (bytes.length < COMMON_PAGE_HEADER_BYTES) throw new RangeError("page is shorter than the common header");
  if (bytes.length > METADATA_PLAINTEXT_MAXIMUM_BYTES) throw new RangeError("page exceeds the metadata plaintext maximum");
  if (bytes[1] !== 0) throw new TypeError("page flags must be zero");
  const level = bytes[0];
  const itemCount = bytes.readUInt16BE(2);
  if (requireBranch && level < 1) throw new TypeError("branch page must have level at least 1");
  if (!requireBranch && level !== 0) throw new TypeError("leaf page must have level zero");
  if (itemCount === 0 && requireBranch) throw new TypeError("branch page must not be empty");
  const expectedLength = COMMON_PAGE_HEADER_BYTES + itemCount * entryBytes;
  if (bytes.length !== expectedLength) throw new RangeError("page length does not match item count");
  return Object.freeze({ itemCount, level });
}

function encodeCommonPageHeader({ itemCount, level }) {
  const bytes = Buffer.alloc(COMMON_PAGE_HEADER_BYTES);
  bytes[0] = level;
  bytes.writeUInt16BE(itemCount, 2);
  return bytes;
}

function decodeInodeBranchPage({ bytes }) {
  const header = decodeCommonPageHeader({ bytes, entryBytes: 40, requireBranch: true });
  const entries = [];
  let previous;
  for (let index = 0; index < header.itemCount; index += 1) {
    const offset = COMMON_PAGE_HEADER_BYTES + index * 40;
    const upperBound = bytes.readBigUInt64BE(offset);
    if (upperBound < 1n) throw new RangeError("Inode Number must be at least 1");
    if (previous !== undefined && upperBound <= previous) throw new TypeError("page keys must be strictly ascending");
    const childPageHomeRef = decodeRequiredRecordReference({ bytes: bytes.subarray(offset + 8, offset + 40) });
    assertReferenceKind({ expected: RECORD_KINDS.inodeTablePage, label: "branch child reference", reference: childPageHomeRef });
    entries.push(Object.freeze({ childPageHomeRef, upperBound }));
    previous = upperBound;
  }
  return Object.freeze({ entries: Object.freeze(entries), level: header.level });
}

function encodeInodeBranchPage({ page }) {
  const bytes = Buffer.alloc(COMMON_PAGE_HEADER_BYTES + page.entries.length * 40);
  encodeCommonPageHeader({ itemCount: page.entries.length, level: page.level }).copy(bytes, 0);
  let previous;
  page.entries.forEach((entry, index) => {
    if (entry.upperBound < 1n) throw new RangeError("Inode Number must be at least 1");
    if (previous !== undefined && entry.upperBound <= previous) throw new TypeError("page keys must be strictly ascending");
    assertReferenceKind({ expected: RECORD_KINDS.inodeTablePage, label: "branch child reference", reference: entry.childPageHomeRef });
    const offset = COMMON_PAGE_HEADER_BYTES + index * 40;
    bytes.writeBigUInt64BE(entry.upperBound, offset);
    encodeRecordReference({ reference: entry.childPageHomeRef }).copy(bytes, offset + 8);
    previous = entry.upperBound;
  });
  return bytes;
}

function decodeFileExtentLeafPage({ bytes }) {
  const header = decodeCommonPageHeader({ bytes, entryBytes: 48, requireBranch: false });
  const entries = [];
  let previousEnd;
  for (let index = 0; index < header.itemCount; index += 1) {
    const offset = COMMON_PAGE_HEADER_BYTES + index * 48;
    const fileOffset = bytes.readBigUInt64BE(offset);
    const byteLength = bytes.readUInt32BE(offset + 8);
    const dataOffset = bytes.readUInt32BE(offset + 12);
    if (byteLength < 1 || byteLength > FILE_DATA_PLAINTEXT_MAXIMUM_BYTES) {
      throw new RangeError("extent byte length is outside the File Data plaintext bound");
    }
    if (dataOffset + byteLength > FILE_DATA_PLAINTEXT_MAXIMUM_BYTES) {
      throw new RangeError("extent data range exceeds the File Data payload maximum");
    }
    if (fileOffset + BigInt(byteLength) > UINT64_MAXIMUM) throw new RangeError("extent file range exceeds u64");
    if (previousEnd !== undefined && fileOffset < previousEnd) {
      throw new TypeError("extent entries overlap or are not strictly ordered");
    }
    const fileDataHomeRef = decodeRequiredRecordReference({ bytes: bytes.subarray(offset + 16, offset + 48) });
    assertReferenceKind({ expected: RECORD_KINDS.fileData, label: "extent File Data reference", reference: fileDataHomeRef });
    entries.push(Object.freeze({ byteLength, dataOffset, fileDataHomeRef, fileOffset }));
    previousEnd = fileOffset + BigInt(byteLength);
  }
  return Object.freeze({ entries: Object.freeze(entries), level: 0, type: "leaf" });
}

function encodeFileExtentLeafPage({ page }) {
  const bytes = Buffer.alloc(COMMON_PAGE_HEADER_BYTES + page.entries.length * 48);
  encodeCommonPageHeader({ itemCount: page.entries.length, level: 0 }).copy(bytes, 0);
  let previousEnd;
  page.entries.forEach((entry, index) => {
    if (entry.byteLength < 1 || entry.byteLength > FILE_DATA_PLAINTEXT_MAXIMUM_BYTES) {
      throw new RangeError("extent byte length is outside the File Data plaintext bound");
    }
    if (entry.dataOffset + entry.byteLength > FILE_DATA_PLAINTEXT_MAXIMUM_BYTES) {
      throw new RangeError("extent data range exceeds the File Data payload maximum");
    }
    if (entry.fileOffset + BigInt(entry.byteLength) > UINT64_MAXIMUM) throw new RangeError("extent file range exceeds u64");
    if (previousEnd !== undefined && entry.fileOffset < previousEnd) {
      throw new TypeError("extent entries overlap or are not strictly ordered");
    }
    assertReferenceKind({ expected: RECORD_KINDS.fileData, label: "extent File Data reference", reference: entry.fileDataHomeRef });
    const offset = COMMON_PAGE_HEADER_BYTES + index * 48;
    bytes.writeBigUInt64BE(entry.fileOffset, offset);
    bytes.writeUInt32BE(entry.byteLength, offset + 8);
    bytes.writeUInt32BE(entry.dataOffset, offset + 12);
    encodeRecordReference({ reference: entry.fileDataHomeRef }).copy(bytes, offset + 16);
    previousEnd = entry.fileOffset + BigInt(entry.byteLength);
  });
  return bytes;
}

function expectRoundTrip({ decode, encode, hex, label }) {
  const source = fromHex({ label, value: hex });
  const decoded = decode({ bytes: source });
  assert.equal(toHex({ value: encode(decoded) }), hex, `${label} roundtrip`);
}

export function verifyBinaryFixtureRoundTrips({ expected }) {
  expectRoundTrip({
    decode: decodeFileSystemCommit,
    encode: payload => encodeFileSystemCommit({ payload }),
    hex: expected.fileSystemCommitHex,
    label: "File System Commit",
  });
  expectRoundTrip({
    decode: decodeInodeBranchPage,
    encode: page => encodeInodeBranchPage({ page }),
    hex: expected.inodeBranchPageHex,
    label: "Inode branch page",
  });
  expectRoundTrip({
    decode: decodeFileExtentLeafPage,
    encode: page => encodeFileExtentLeafPage({ page }),
    hex: expected.fileExtentLeafPageHex,
    label: "File Extent leaf page",
  });
  return 3;
}
