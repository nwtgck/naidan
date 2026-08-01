import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import {
  createDecipheriv,
  createHash,
  hkdfSync,
  pbkdf2Sync,
} from "node:crypto";
import { readFile } from "node:fs/promises";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";
import { TextDecoder } from "node:util";

import { encodeCryptoContext } from "./verify-vectors.mjs";

const METHOD = "passphrase_pbkdf2_hmac_sha256_aes_256_gcm";
const NANO_ID_21 = /^[A-Za-z0-9_-]{21}$/u;
const ROOT_FIELDS = [
  "format",
  "formatVersion",
  "copy",
  "sequence",
  "fileSystemId",
  "credentialSlots",
  "authenticatorNonce",
  "authenticatorTag",
];
const SLOT_FIELDS = [
  "type",
  "slotId",
  "method",
  "methodVersion",
  "methodParameters",
  "wrappedFileSystemRootKey",
];
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

function decodeBase64UrlCanonical({ maximumBytes, value }) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]*$/u.test(value) || value.length % 4 === 1) {
    throw new TypeError("value must be canonical unpadded Base64URL");
  }
  const bytes = Buffer.from(value, "base64url");
  if (bytes.length > maximumBytes || bytes.toString("base64url") !== value) {
    throw new TypeError("value must be canonical unpadded Base64URL");
  }
  return bytes;
}

function exactKeys({ expected, label, value }) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  assert.deepEqual(Object.keys(value), expected, `${label} fields are unknown, missing, or out of canonical order`);
  return value;
}

function canonicalString({ value }) {
  if (typeof value !== "string" || !/^[\x20-\x7e]*$/u.test(value)) {
    throw new TypeError("canonical control string must be printable ASCII");
  }
  return JSON.stringify(value);
}

function encodeSlot({ slot }) {
  return `{${[
    `"type":${canonicalString({ value: slot.type })}`,
    `"slotId":${canonicalString({ value: slot.slotId })}`,
    `"method":${canonicalString({ value: slot.method })}`,
    `"methodVersion":${slot.methodVersion}`,
    `"methodParameters":${canonicalString({ value: slot.methodParameters })}`,
    `"wrappedFileSystemRootKey":${canonicalString({ value: slot.wrappedFileSystemRootKey })}`,
  ].join(",")}}`;
}

function encodeEnvelope({ envelope, includeAuthenticatorTag }) {
  const fields = [
    `"format":${canonicalString({ value: envelope.format })}`,
    `"formatVersion":${envelope.formatVersion}`,
    `"copy":${envelope.copy}`,
    `"sequence":${envelope.sequence}`,
    `"fileSystemId":${canonicalString({ value: envelope.fileSystemId })}`,
    `"credentialSlots":[${envelope.credentialSlots.map(slot => encodeSlot({ slot })).join(",")}]`,
    `"authenticatorNonce":${canonicalString({ value: envelope.authenticatorNonce })}`,
  ];
  if (includeAuthenticatorTag) {
    fields.push(`"authenticatorTag":${canonicalString({ value: envelope.authenticatorTag })}`);
  }
  return Buffer.from(`{${fields.join(",")}}\n`, "ascii");
}

function decodeEnvelope({ bytes, physicalCopy }) {
  const text = utf8Decoder.decode(bytes);
  const parsed = exactKeys({ expected: ROOT_FIELDS, label: "Unlock Envelope", value: JSON.parse(text) });
  if (parsed.format !== "hizofs-unlock" || parsed.formatVersion !== 1) throw new TypeError("unsupported Unlock Envelope");
  if (parsed.copy !== physicalCopy || (parsed.copy !== 0 && parsed.copy !== 1)) throw new TypeError("Unlock Envelope copy mismatch");
  if (!Number.isSafeInteger(parsed.sequence) || parsed.sequence < 1) throw new RangeError("Unlock sequence is invalid");
  if (typeof parsed.fileSystemId !== "string" || !NANO_ID_21.test(parsed.fileSystemId)) throw new TypeError("File System ID is invalid");
  if (!Array.isArray(parsed.credentialSlots) || parsed.credentialSlots.length < 1 || parsed.credentialSlots.length > 32) {
    throw new RangeError("Credential Slot count is invalid");
  }
  let previousSlotId;
  let totalIterations = 0;
  const credentialSlots = parsed.credentialSlots.map(raw => {
    const slot = exactKeys({ expected: SLOT_FIELDS, label: "Credential Slot", value: raw });
    if (slot.type !== "credential" || typeof slot.slotId !== "string" || !NANO_ID_21.test(slot.slotId)) {
      throw new TypeError("Credential Slot identity is invalid");
    }
    if (previousSlotId !== undefined && previousSlotId >= slot.slotId) throw new TypeError("Credential Slots are not strictly ordered");
    previousSlotId = slot.slotId;
    if (slot.method !== METHOD || slot.methodVersion !== 1) throw new TypeError("unsupported Credential Slot method");
    const methodParametersBytes = decodeBase64UrlCanonical({ maximumBytes: 32, value: slot.methodParameters });
    const wrappedRootKeyBytes = decodeBase64UrlCanonical({ maximumBytes: 48, value: slot.wrappedFileSystemRootKey });
    if (methodParametersBytes.length !== 32 || wrappedRootKeyBytes.length !== 48) throw new RangeError("Credential Slot byte length is invalid");
    const iterations = methodParametersBytes.readUInt32BE(16);
    if (iterations < 600_000 || iterations > 10_000_000) throw new RangeError("PBKDF2 iterations are outside V1 bounds");
    totalIterations += iterations;
    if (totalIterations > 20_000_000) throw new RangeError("Credential Slot PBKDF2 work exceeds V1 bound");
    return Object.freeze({ ...slot, iterations, methodParametersBytes, wrappedRootKeyBytes });
  });
  const authenticatorNonceBytes = decodeBase64UrlCanonical({ maximumBytes: 12, value: parsed.authenticatorNonce });
  const authenticatorTagBytes = decodeBase64UrlCanonical({ maximumBytes: 16, value: parsed.authenticatorTag });
  if (authenticatorNonceBytes.length !== 12 || authenticatorTagBytes.length !== 16) throw new RangeError("Unlock Authenticator size is invalid");
  const envelope = Object.freeze({ ...parsed, credentialSlots: Object.freeze(credentialSlots), authenticatorNonceBytes, authenticatorTagBytes });
  if (!encodeEnvelope({ envelope, includeAuthenticatorTag: true }).equals(bytes)) throw new TypeError("Unlock Envelope bytes are not canonical");
  return envelope;
}

export function decryptAesGcm({ aad, ciphertextAndTag, key, nonce }) {
  if (ciphertextAndTag.length < 16) throw new RangeError("AES-GCM ciphertext is shorter than its tag");
  const ciphertext = ciphertextAndTag.subarray(0, -16);
  const tag = ciphertextAndTag.subarray(-16);
  const decipher = createDecipheriv("aes-256-gcm", key, nonce, { authTagLength: 16 });
  decipher.setAAD(aad);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

function u16Be(value) {
  const bytes = Buffer.alloc(2); bytes.writeUInt16BE(value); return bytes;
}
function u32Be(value) {
  const bytes = Buffer.alloc(4); bytes.writeUInt32BE(value); return bytes;
}
export function u64Be(value) {
  const bytes = Buffer.alloc(8); bytes.writeBigUInt64BE(BigInt(value)); return bytes;
}

function unwrapSlot({ envelope, passphrase, slot }) {
  const salt = slot.methodParametersBytes.subarray(0, 16);
  const nonce = slot.methodParametersBytes.subarray(20, 32);
  const kdfContext = encodeCryptoContext({
    domain: "HizoFS/v1/passphrase-slot-kdf",
    fields: [Buffer.from(envelope.fileSystemId, "ascii"), Buffer.from(slot.slotId, "ascii"), salt],
  });
  const passphraseBytes = Buffer.from(passphrase, "utf8");
  const key = pbkdf2Sync(passphraseBytes, kdfContext, slot.iterations, 32, "sha256");
  passphraseBytes.fill(0);
  const aad = encodeCryptoContext({
    domain: "HizoFS/v1/passphrase-slot-aad",
    fields: [u16Be(1), Buffer.from(envelope.fileSystemId, "ascii"), Buffer.from(slot.slotId, "ascii"), Buffer.from(METHOD, "ascii"), u32Be(1), slot.methodParametersBytes],
  });
  try {
    const rootKey = decryptAesGcm({ aad, ciphertextAndTag: slot.wrappedRootKeyBytes, key, nonce });
    if (rootKey.length !== 32) throw new TypeError("File System Root Key must be 32 bytes");
    return rootKey;
  } finally {
    key.fill(0);
  }
}

function verifyEnvelopeAuthenticator({ envelope, rootKey }) {
  const keyContext = encodeCryptoContext({
    domain: "HizoFS/v1/unlock-authenticator-key",
    fields: [Buffer.from(envelope.fileSystemId, "ascii"), Buffer.of(envelope.copy), u64Be(envelope.sequence)],
  });
  const key = Buffer.from(hkdfSync("sha256", rootKey, Buffer.alloc(0), keyContext, 32));
  const aad = encodeCryptoContext({
    domain: "HizoFS/v1/unlock-authenticator-aad",
    fields: [encodeEnvelope({ envelope, includeAuthenticatorTag: false })],
  });
  try {
    return decryptAesGcm({ aad, ciphertextAndTag: envelope.authenticatorTagBytes, key, nonce: envelope.authenticatorNonceBytes }).length === 0;
  } finally {
    key.fill(0);
  }
}

function sameSemanticEnvelope({ left, right }) {
  return left.format === right.format
    && left.formatVersion === right.formatVersion
    && left.sequence === right.sequence
    && left.fileSystemId === right.fileSystemId
    && JSON.stringify(left.credentialSlots.map(slot => ({
      type: slot.type,
      slotId: slot.slotId,
      method: slot.method,
      methodVersion: slot.methodVersion,
      methodParameters: slot.methodParameters,
      wrappedFileSystemRootKey: slot.wrappedFileSystemRootKey,
    }))) === JSON.stringify(right.credentialSlots.map(slot => ({
      type: slot.type,
      slotId: slot.slotId,
      method: slot.method,
      methodVersion: slot.methodVersion,
      methodParameters: slot.methodParameters,
      wrappedFileSystemRootKey: slot.wrappedFileSystemRootKey,
    })));
}

export function fixtureFile({ fixture, path }) {
  const entry = fixture.files.find(candidate => candidate.path === path);
  if (entry === undefined) throw new Error(`fixture file is missing: ${path}`);
  const bytes = Buffer.from(entry.hex, "hex");
  if (bytes.length !== entry.byteLength || createHash("sha256").update(bytes).digest("hex") !== entry.sha256) {
    throw new TypeError(`fixture file integrity failed: ${path}`);
  }
  return bytes;
}

export async function loadPortableFixture({ fixturePath }) {
  const fixture = JSON.parse(await readFile(fixturePath, "utf8"));
  const supportedSchema = fixture?.schema === "hizofs-v1-empty-container-fixture"
    || fixture?.schema === "hizofs-v1-nonempty-container-fixture";
  if (!supportedSchema || fixture?.schemaVersion !== 1 || !Array.isArray(fixture.files)) {
    throw new TypeError("unsupported portable container fixture");
  }
  return fixture;
}

export function unlockPortableFixture({ fixture, passphrase }) {
  const structuralCopies = [0, 1].map(copy => decodeEnvelope({
    bytes: fixtureFile({ fixture, path: `unlock-${copy}.json` }),
    physicalCopy: copy,
  }));
  const attempts = [];
  const seen = new Set();
  for (const envelope of [...structuralCopies].sort((left, right) => right.sequence - left.sequence)) {
    for (const slot of envelope.credentialSlots) {
      const key = [envelope.fileSystemId, slot.slotId, slot.method, slot.methodVersion, slot.methodParameters, slot.wrappedFileSystemRootKey].join("\0");
      if (!seen.has(key)) { seen.add(key); attempts.push({ envelope, slot }); }
    }
  }
  let rootKey;
  for (const attempt of attempts) {
    let candidate;
    try {
      candidate = unwrapSlot({ ...attempt, passphrase });
      if (verifyEnvelopeAuthenticator({ envelope: attempt.envelope, rootKey: candidate })) {
        rootKey = candidate;
        candidate = undefined;
        break;
      }
    } catch {
      // A rejected passphrase or damaged slot is not authority.
    } finally {
      candidate?.fill(0);
    }
  }
  if (rootKey === undefined) throw new Error("passphrase did not authenticate an Unlock Envelope");
  const authenticated = structuralCopies.filter(envelope => {
    try { return verifyEnvelopeAuthenticator({ envelope, rootKey }); } catch { return false; }
  });
  const maximumSequence = Math.max(...authenticated.map(envelope => envelope.sequence));
  const selectedGroup = authenticated.filter(envelope => envelope.sequence === maximumSequence);
  if (selectedGroup.length === 0 || selectedGroup.some(envelope => !sameSemanticEnvelope({ left: selectedGroup[0], right: envelope }))) {
    rootKey.fill(0);
    throw new Error("authenticated Unlock Envelope authority is ambiguous");
  }
  const selected = selectedGroup[0];
  return Object.freeze({
    rootKey,
    summary: Object.freeze({
      authenticatedUnlockCopies: authenticated.length,
      credentialSlotCount: selected.credentialSlots.length,
      fileSystemId: selected.fileSystemId,
      rootKeyBytes: rootKey.length,
      schemaVersion: fixture.schemaVersion,
      selectedUnlockCopy: selected.copy,
      unlockSequence: selected.sequence,
    }),
  });
}

export async function verifyPortableUnlock({ fixturePath, passphrase }) {
  const fixture = await loadPortableFixture({ fixturePath });
  const opened = unlockPortableFixture({ fixture, passphrase: passphrase ?? fixture.passphrase });
  try { return opened.summary; } finally { opened.rootKey.fill(0); }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const fixturePath = process.argv[2] ?? fileURLToPath(new URL(
    "../../../src/00-storage/service/hizofs/authenticated-store/tests/test-fixtures/empty-container-portable-v1.json",
    import.meta.url,
  ));
  const fixture = await loadPortableFixture({ fixturePath });
  const result = await verifyPortableUnlock({ fixturePath, passphrase: process.argv[3] ?? fixture.passphrase });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
