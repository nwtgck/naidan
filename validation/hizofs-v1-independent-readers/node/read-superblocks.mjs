import { Buffer } from "node:buffer";
import { hkdfSync } from "node:crypto";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";
import { TextDecoder } from "node:util";

import {
  decodeOptionalRecordReference,
  decodeRequiredRecordReference,
} from "./binary-fixtures.mjs";
import {
  decryptAesGcm,
  fixtureFile,
  loadPortableFixture,
  u64Be,
  unlockPortableFixture,
} from "./read-empty-container.mjs";
import { encodeCryptoContext } from "./verify-vectors.mjs";

const HEADER_BYTES = 80;
const PLAINTEXT_BYTES = 144;
const FILE_BYTES = 240;
const KNOWN_FLAGS = 3;
const COMMIT_KIND = 1;
const RELOCATION_KIND = 48;
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

function allZero(bytes) {
  return bytes.every(byte => byte === 0);
}

function decodeHeader({ bytes, fileSystemId, physicalCopy }) {
  if (bytes.length !== HEADER_BYTES) throw new RangeError("Superblock Header must be exactly 80 bytes");
  if (bytes.subarray(0, 8).toString("ascii") !== "HZSBLOCK") throw new TypeError("Superblock magic is invalid");
  if (bytes.readUInt16BE(8) !== 1 || bytes.readUInt16BE(10) !== HEADER_BYTES) throw new TypeError("Superblock version or header length is invalid");
  if (bytes[12] !== physicalCopy || (physicalCopy !== 0 && physicalCopy !== 1)) throw new TypeError("Superblock copy mismatch");
  const flags = bytes[13];
  if ((flags & ~KNOWN_FLAGS) !== 0 || bytes[14] !== 0 || bytes[15] !== 0) throw new TypeError("Superblock flags or reserved bytes are invalid");
  const publicationSequence = bytes.readBigUInt64BE(16);
  const activeCommitSequence = bytes.readBigUInt64BE(24);
  if (publicationSequence < 1n || activeCommitSequence < 1n) throw new RangeError("Superblock sequence must be nonzero");
  if (bytes.readUInt32BE(32) !== PLAINTEXT_BYTES || bytes[36] !== 21) throw new TypeError("Superblock plaintext or File System ID length is invalid");
  const observedFileSystemId = utf8Decoder.decode(bytes.subarray(37, 58));
  if (observedFileSystemId !== fileSystemId) throw new TypeError("Superblock File System ID mismatch");
  if (!allZero(bytes.subarray(70, 80))) throw new TypeError("Superblock reserved bytes must be zero");
  return Object.freeze({
    activeCommitSequence,
    copy: physicalCopy,
    exactBytes: Buffer.from(bytes),
    flags,
    nonce: Buffer.from(bytes.subarray(58, 70)),
    publicationSequence,
  });
}

function decodePlaintext({ bytes, flags }) {
  if (bytes.length !== PLAINTEXT_BYTES) throw new RangeError("Superblock plaintext must be exactly 144 bytes");
  const activeCommitHomeRef = decodeRequiredRecordReference({ bytes: bytes.subarray(0, 32) });
  const fallbackCommitHomeRef = decodeOptionalRecordReference({ bytes: bytes.subarray(32, 64) });
  const relocationIndexRootPhysicalRef = decodeOptionalRecordReference({ bytes: bytes.subarray(64, 96) });
  if (activeCommitHomeRef.recordKind !== COMMIT_KIND
    || (fallbackCommitHomeRef !== null && fallbackCommitHomeRef.recordKind !== COMMIT_KIND)) {
    throw new TypeError("Superblock Commit reference kind is invalid");
  }
  if (relocationIndexRootPhysicalRef !== null && relocationIndexRootPhysicalRef.recordKind !== RELOCATION_KIND) {
    throw new TypeError("Superblock relocation reference kind is invalid");
  }
  if ((fallbackCommitHomeRef !== null) !== ((flags & 2) !== 0)) throw new TypeError("Superblock fallback flag mismatch");
  if ((relocationIndexRootPhysicalRef !== null) !== ((flags & 1) !== 0)) throw new TypeError("Superblock relocation flag mismatch");
  const activeMutationId = Buffer.from(bytes.subarray(96, 112));
  const publicationId = Buffer.from(bytes.subarray(112, 128));
  if (allZero(activeMutationId) || allZero(publicationId)) throw new TypeError("Superblock identity must not be all-zero");
  const minimumUnlockSequence = bytes.readBigUInt64BE(128);
  const requiredFeatureBits = bytes.readBigUInt64BE(136);
  if (minimumUnlockSequence < 1n) throw new RangeError("Superblock minimum Unlock Sequence must be nonzero");
  return Object.freeze({
    activeCommitHomeRef,
    activeMutationId,
    exactBytes: Buffer.from(bytes),
    fallbackCommitHomeRef,
    minimumUnlockSequence,
    publicationId,
    relocationIndexRootPhysicalRef,
    requiredFeatureBits,
  });
}

function decryptCopy({ bytes, fileSystemId, physicalCopy, rootKey }) {
  if (bytes.length !== FILE_BYTES) throw new RangeError("Superblock file must be exactly 240 bytes");
  const header = decodeHeader({ bytes: bytes.subarray(0, HEADER_BYTES), fileSystemId, physicalCopy });
  const keyContext = encodeCryptoContext({
    domain: "HizoFS/v1/superblock-key",
    fields: [Buffer.from(fileSystemId, "ascii"), Buffer.of(physicalCopy), u64Be(header.publicationSequence)],
  });
  const key = Buffer.from(hkdfSync("sha256", rootKey, Buffer.alloc(0), keyContext, 32));
  const aad = encodeCryptoContext({ domain: "HizoFS/v1/superblock-aad", fields: [header.exactBytes] });
  try {
    const plaintextBytes = decryptAesGcm({ aad, ciphertextAndTag: bytes.subarray(HEADER_BYTES), key, nonce: header.nonce });
    return Object.freeze({ header, physicalCopy, plaintext: decodePlaintext({ bytes: plaintextBytes, flags: header.flags }) });
  } finally {
    key.fill(0);
  }
}

function logicalStateKey(copy) {
  return `${copy.header.activeCommitSequence}:${copy.plaintext.exactBytes.subarray(0, 112).toString("hex")}:${copy.plaintext.exactBytes.subarray(128).toString("hex")}`;
}

export function openPortableSuperblocks({ fixture, rootKey, unlockSequence }) {
  const copies = [0, 1].map(physicalCopy => decryptCopy({
    bytes: fixtureFile({ fixture, path: `superblock-${physicalCopy}.enc` }),
    fileSystemId: fixture.fileSystemId,
    physicalCopy,
    rootKey,
  })).sort((left, right) => left.header.publicationSequence === right.header.publicationSequence
    ? 0
    : left.header.publicationSequence > right.header.publicationSequence ? -1 : 1);
  if (copies[1] !== undefined && copies[0].header.publicationSequence === copies[1].header.publicationSequence) {
    throw new Error("two authenticated Superblock copies reuse one Publication Sequence");
  }
  const selected = copies[0];
  if (selected.plaintext.requiredFeatureBits !== 0n) throw new Error("selected Superblock requires unsupported feature semantics");
  if (BigInt(unlockSequence) < selected.plaintext.minimumUnlockSequence) throw new Error("Unlock authority is older than the Superblock minimum");
  const sibling = copies[1];
  const summary = Object.freeze({
    authenticatedSuperblockCopies: copies.length,
    activeCommitFrameLength: selected.plaintext.activeCommitHomeRef.frameLength,
    activeCommitOffset: selected.plaintext.activeCommitHomeRef.byteOffset.toString(),
    activeCommitSegmentId: selected.plaintext.activeCommitHomeRef.segmentId.toString("hex"),
    activeCommitSequence: selected.header.activeCommitSequence.toString(),
    copyState: sibling !== undefined && logicalStateKey(selected) === logicalStateKey(sibling) ? "normal" : "superblock_redundancy_degraded",
    fallbackCommitPresent: selected.plaintext.fallbackCommitHomeRef !== null,
    minimumUnlockSequence: selected.plaintext.minimumUnlockSequence.toString(),
    relocationIndexPresent: selected.plaintext.relocationIndexRootPhysicalRef !== null,
    requiredFeatureBits: selected.plaintext.requiredFeatureBits.toString(),
    selectedPublicationSequence: selected.header.publicationSequence.toString(),
    selectedSuperblockCopy: selected.physicalCopy,
  });
  return Object.freeze({ copies: Object.freeze(copies), selected, summary });
}

export function readPortableSuperblocks(input) {
  return openPortableSuperblocks(input).summary;
}

export async function verifyPortableSuperblocks({ fixturePath, passphrase }) {
  const fixture = await loadPortableFixture({ fixturePath });
  const unlocked = unlockPortableFixture({ fixture, passphrase: passphrase ?? fixture.passphrase });
  try {
    return readPortableSuperblocks({ fixture, rootKey: unlocked.rootKey, unlockSequence: unlocked.summary.unlockSequence });
  } finally {
    unlocked.rootKey.fill(0);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const fixturePath = process.argv[2] ?? fileURLToPath(new URL(
    "../../../src/00-storage/service/hizofs/authenticated-store/tests/test-fixtures/empty-container-portable-v1.json",
    import.meta.url,
  ));
  const result = await verifyPortableSuperblocks({ fixturePath, passphrase: process.argv[3] });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
