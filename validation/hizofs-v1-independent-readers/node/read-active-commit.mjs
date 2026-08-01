import { Buffer } from "node:buffer";
import { hkdfSync } from "node:crypto";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";

import { decodeFileSystemCommit } from "./binary-fixtures.mjs";
import {
  decryptAesGcm,
  fixtureFile,
  loadPortableFixture,
  unlockPortableFixture,
} from "./read-empty-container.mjs";
import { openPortableSuperblocks } from "./read-superblocks.mjs";
import { encodeCryptoContext } from "./verify-vectors.mjs";

const SEGMENT_HEADER_BYTES = 64;
const RECORD_HEADER_BYTES = 64;
const METADATA_CLASS = 1;
const COMMIT_KIND = 1;
const KNOWN_RECORD_KINDS = new Set([1, 2, 16, 32, 33, 34, 48]);

function allZero(bytes) { return bytes.every(byte => byte === 0); }
function equalBytes(left, right) { return Buffer.from(left).equals(Buffer.from(right)); }

function authenticateSegmentHeader({ bytes, fileSystemId, physicalSegmentId, rootKey }) {
  if (bytes.length !== SEGMENT_HEADER_BYTES) throw new RangeError("Segment Header must be exactly 64 bytes");
  if (bytes.subarray(0, 8).toString("ascii") !== "HZSEGMNT" || bytes.readUInt16BE(8) !== 1 || bytes.readUInt16BE(10) !== 64) {
    throw new TypeError("Segment Header framing is invalid");
  }
  if (bytes[12] !== METADATA_CLASS || bytes[13] !== 0 || bytes[14] !== 0 || bytes[15] !== 0) throw new TypeError("Segment Header class or reserved bytes are invalid");
  if (!equalBytes(bytes.subarray(16, 32), physicalSegmentId) || !allZero(bytes.subarray(32, 48))) throw new TypeError("Segment Header path binding or reserved bytes are invalid");
  const prefix = bytes.subarray(0, 48);
  const context = encodeCryptoContext({ domain: "HizoFS/v1/segment-header-key", fields: [Buffer.from(fileSystemId, "ascii"), physicalSegmentId, Buffer.of(METADATA_CLASS)] });
  const key = Buffer.from(hkdfSync("sha256", rootKey, Buffer.alloc(0), context, 32));
  const aad = encodeCryptoContext({ domain: "HizoFS/v1/segment-header-aad", fields: [Buffer.from(fileSystemId, "ascii"), prefix] });
  try {
    if (decryptAesGcm({ aad, ciphertextAndTag: bytes.subarray(48), key, nonce: Buffer.alloc(12) }).length !== 0) throw new TypeError("Segment Header plaintext must be empty");
  } finally { key.fill(0); }
}

function decodeRecordHeader(bytes) {
  if (bytes.length !== RECORD_HEADER_BYTES) throw new RangeError("Record Frame Header must be exactly 64 bytes");
  if (bytes.subarray(0, 8).toString("ascii") !== "HZRECORD" || bytes.readUInt16BE(8) !== 1 || bytes.readUInt16BE(10) !== 64) throw new TypeError("Record Frame framing is invalid");
  const recordKind = bytes[12]; const flags = bytes[13]; const codecVersion = bytes.readUInt16BE(14);
  if (!KNOWN_RECORD_KINDS.has(recordKind) || (flags & ~1) !== 0 || codecVersion !== 1) throw new TypeError("Record Frame kind, flags, or codec is invalid");
  if ((recordKind === 48) !== ((flags & 1) !== 0)) throw new TypeError("Record Frame physical-only flag mismatch");
  const homeOffset = bytes.readBigUInt64BE(32); const plaintextLength = bytes.readUInt32BE(40); const sealedLength = bytes.readUInt32BE(44); const frameLength = bytes.readUInt32BE(48);
  if (homeOffset < 64n || homeOffset % 8n !== 0n || sealedLength !== plaintextLength + 16 || frameLength !== Math.ceil((64 + sealedLength) / 8) * 8) throw new RangeError("Record Frame length or home offset is invalid");
  return Object.freeze({ exactBytes: Buffer.from(bytes), flags, frameLength, homeOffset, homeSegmentId: Buffer.from(bytes.subarray(16, 32)), nonce: Buffer.from(bytes.subarray(52, 64)), plaintextLength, recordKind, sealedLength });
}

export function readAuthenticatedHomeRecord({ expectedKind, fixture, reference, rootKey }) {
  const segmentIdHex = reference.segmentId.toString("hex");
  const path = `segments/metadata/${segmentIdHex.slice(-2)}/${segmentIdHex}.enc`;
  const segment = fixtureFile({ fixture, path });
  if (segment.length < SEGMENT_HEADER_BYTES) throw new RangeError("metadata Segment is shorter than its header");
  authenticateSegmentHeader({
    bytes: segment.subarray(0, SEGMENT_HEADER_BYTES),
    fileSystemId: fixture.fileSystemId,
    physicalSegmentId: reference.segmentId,
    rootKey,
  });
  const start = Number(reference.byteOffset);
  if (!Number.isSafeInteger(start)) throw new RangeError("record offset exceeds the JavaScript safe integer range");
  const end = start + reference.frameLength;
  if (!Number.isSafeInteger(end) || end > segment.length) throw new RangeError("record reference is outside the portable Segment");
  const frame = segment.subarray(start, end);
  if (frame.length < RECORD_HEADER_BYTES) throw new RangeError("Record Frame is shorter than its header");
  const header = decodeRecordHeader(frame.subarray(0, RECORD_HEADER_BYTES));
  const sealedEnd = RECORD_HEADER_BYTES + header.sealedLength;
  if (header.frameLength !== frame.length || sealedEnd > frame.length) throw new RangeError("Record Frame declared length exceeds its reference");
  if (!allZero(frame.subarray(sealedEnd))) throw new TypeError("Record Frame padding must be canonical zero");
  if (
    header.recordKind !== expectedKind
    || header.flags !== 0
    || header.frameLength !== reference.frameLength
    || header.homeOffset !== reference.byteOffset
    || !equalBytes(header.homeSegmentId, reference.segmentId)
  ) {
    throw new TypeError("Record Frame does not match its Home Record Reference");
  }
  const context = encodeCryptoContext({
    domain: "HizoFS/v1/record-key",
    fields: [Buffer.from(fixture.fileSystemId, "ascii"), header.homeSegmentId],
  });
  const key = Buffer.from(hkdfSync("sha256", rootKey, Buffer.alloc(0), context, 32));
  const aad = encodeCryptoContext({
    domain: "HizoFS/v1/record-aad",
    fields: [Buffer.from(fixture.fileSystemId, "ascii"), header.exactBytes],
  });
  let plaintext;
  try {
    plaintext = decryptAesGcm({
      aad,
      ciphertextAndTag: frame.subarray(RECORD_HEADER_BYTES, RECORD_HEADER_BYTES + header.sealedLength),
      key,
      nonce: header.nonce,
    });
  } finally {
    key.fill(0);
  }
  if (plaintext.length !== header.plaintextLength) throw new TypeError("Record Frame plaintext length mismatch");
  return Object.freeze({ plaintext, segmentBytes: segment.length });
}

export function readActiveCommitAuthority({ fixture, rootKey, selected }) {
  const reference = selected.plaintext.activeCommitHomeRef;
  const opened = readAuthenticatedHomeRecord({ expectedKind: COMMIT_KIND, fixture, reference, rootKey });
  const commit = decodeFileSystemCommit({ bytes: opened.plaintext });
  if (
    commit.commitSequence !== selected.header.activeCommitSequence
    || !equalBytes(commit.mutationId, selected.plaintext.activeMutationId)
  ) {
    throw new TypeError("active Commit identity does not match selected Superblock authority");
  }
  return Object.freeze({ commit, segmentBytes: opened.segmentBytes });
}

function readActiveCommit({ fixture, rootKey, selected }) {
  const opened = readActiveCommitAuthority({ fixture, rootKey, selected });
  const commit = opened.commit;
  return Object.freeze({
    activeCommitSequence: commit.commitSequence.toString(),
    nextInodeNumber: commit.nextInodeNumber.toString(),
    nextSubvolumeId: commit.nextSubvolumeId.toString(),
    rootDirectoryInodeNumber: commit.rootDirectoryInodeNumber.toString(),
    rootInodeTableFrameLength: commit.rootInodeTableRootHomeRef.frameLength,
    rootInodeTableOffset: commit.rootInodeTableRootHomeRef.byteOffset.toString(),
    rootInodeTableSegmentId: commit.rootInodeTableRootHomeRef.segmentId.toString("hex"),
    segmentBytes: opened.segmentBytes,
    segmentHeaderAuthenticated: true,
  });
}

export async function verifyPortableActiveCommit({ fixturePath, passphrase }) {
  const fixture = await loadPortableFixture({ fixturePath }); const unlocked = unlockPortableFixture({ fixture, passphrase: passphrase ?? fixture.passphrase });
  try {
    const superblocks = openPortableSuperblocks({ fixture, rootKey: unlocked.rootKey, unlockSequence: unlocked.summary.unlockSequence });
    return readActiveCommit({ fixture, rootKey: unlocked.rootKey, selected: superblocks.selected });
  } finally { unlocked.rootKey.fill(0); }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const fixturePath = process.argv[2] ?? fileURLToPath(new URL("../../../src/00-storage/service/hizofs/authenticated-store/tests/test-fixtures/empty-container-portable-v1.json", import.meta.url));
  process.stdout.write(`${JSON.stringify(await verifyPortableActiveCommit({ fixturePath, passphrase: process.argv[3] }))}\n`);
}
