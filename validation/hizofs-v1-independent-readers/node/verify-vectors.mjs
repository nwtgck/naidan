import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  pbkdf2Sync,
} from "node:crypto";
import { readFile } from "node:fs/promises";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";
import { TextEncoder } from "node:util";

import { verifyBinaryFixtureRoundTrips } from "./binary-fixtures.mjs";

const AES_GCM_TAG_BYTES = 16;
const CONTEXT_ENCODING_VERSION = 1;
const PASSPHRASE_METHOD = "passphrase_pbkdf2_hmac_sha256_aes_256_gcm";
const textEncoder = new TextEncoder();

function fromHex({ value }) {
  if (typeof value !== "string" || value.length % 2 !== 0 || !/^[0-9a-f]*$/u.test(value)) {
    throw new TypeError("fixture hex must be lowercase and byte-aligned");
  }
  return Buffer.from(value, "hex");
}

function toHex({ value }) {
  return Buffer.from(value).toString("hex");
}

function u16Be({ value }) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffff) {
    throw new RangeError("u16 value is out of range");
  }
  const bytes = Buffer.alloc(2);
  bytes.writeUInt16BE(value);
  return bytes;
}

function u32Be({ value }) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw new RangeError("u32 value is out of range");
  }
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32BE(value);
  return bytes;
}

function u64Be({ value }) {
  if (typeof value !== "bigint" || value < 0n || value > 0xffff_ffff_ffff_ffffn) {
    throw new RangeError("u64 value is out of range");
  }
  const bytes = Buffer.alloc(8);
  bytes.writeBigUInt64BE(value);
  return bytes;
}

export function encodeCryptoContext({ domain, fields }) {
  if (typeof domain !== "string" || !/^[\x20-\x7e]+$/u.test(domain)) {
    throw new TypeError("crypto domain must be non-empty printable ASCII");
  }
  if (!Array.isArray(fields) || fields.length > 0xffff) {
    throw new RangeError("crypto context field count is outside u16");
  }
  const domainBytes = Buffer.from(textEncoder.encode(domain));
  if (domainBytes.length > 0xffff) throw new RangeError("crypto domain is too long");
  const encodedFields = fields.map(field => {
    const bytes = Buffer.from(field);
    return Buffer.concat([u64Be({ value: BigInt(bytes.length) }), bytes]);
  });
  return Buffer.concat([
    Buffer.of(CONTEXT_ENCODING_VERSION),
    u16Be({ value: domainBytes.length }),
    domainBytes,
    u16Be({ value: fields.length }),
    ...encodedFields,
  ]);
}

function aesGcmEncrypt({ aad, key, nonce, plaintext }) {
  const cipher = createCipheriv("aes-256-gcm", key, nonce, { authTagLength: AES_GCM_TAG_BYTES });
  cipher.setAAD(aad);
  return Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
}

function aesGcmDecrypt({ aad, ciphertextAndTag, key, nonce }) {
  if (ciphertextAndTag.length < AES_GCM_TAG_BYTES) {
    throw new RangeError("AES-GCM ciphertext is shorter than its tag");
  }
  const ciphertext = ciphertextAndTag.subarray(0, -AES_GCM_TAG_BYTES);
  const tag = ciphertextAndTag.subarray(-AES_GCM_TAG_BYTES);
  const decipher = createDecipheriv("aes-256-gcm", key, nonce, { authTagLength: AES_GCM_TAG_BYTES });
  decipher.setAAD(aad);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

function expectHex({ actual, expected, label }) {
  assert.equal(toHex({ value: actual }), expected, label);
}

function contextVectors({ inputs }) {
  const fileSystemId = Buffer.from(String(inputs.fileSystemIdAscii), "utf8");
  const slotId = Buffer.from(String(inputs.credentialSlotIdAscii), "utf8");
  const salt = fromHex({ value: String(inputs.saltHex) });
  const wrapNonce = fromHex({ value: String(inputs.credentialWrapNonceHex) });
  const methodParameters = Buffer.concat([
    salt,
    u32Be({ value: Number(inputs.iterations) }),
    wrapNonce,
  ]);
  return {
    passphraseSlotAad: encodeCryptoContext({
      domain: "HizoFS/v1/passphrase-slot-aad",
      fields: [
        u16Be({ value: 1 }),
        fileSystemId,
        slotId,
        Buffer.from(PASSPHRASE_METHOD, "ascii"),
        u32Be({ value: 1 }),
        methodParameters,
      ],
    }),
    passphraseSlotKdf: encodeCryptoContext({
      domain: "HizoFS/v1/passphrase-slot-kdf",
      fields: [fileSystemId, slotId, salt],
    }),
    recordAad: encodeCryptoContext({
      domain: "HizoFS/v1/record-aad",
      fields: [fileSystemId, fromHex({ value: String(inputs.recordFrameHeaderHex) })],
    }),
    recordKey: encodeCryptoContext({
      domain: "HizoFS/v1/record-key",
      fields: [fileSystemId, fromHex({ value: String(inputs.homeSegmentIdHex) })],
    }),
    segmentFooterAad: encodeCryptoContext({
      domain: "HizoFS/v1/segment-footer-aad",
      fields: [
        fileSystemId,
        fromHex({ value: String(inputs.segmentFooterHeaderHex) }),
        fromHex({ value: String(inputs.segmentFooterTrailerHex) }),
      ],
    }),
    superblockAad: encodeCryptoContext({
      domain: "HizoFS/v1/superblock-aad",
      fields: [fromHex({ value: String(inputs.superblockHeaderHex) })],
    }),
    unlockAuthenticatorAad: encodeCryptoContext({
      domain: "HizoFS/v1/unlock-authenticator-aad",
      fields: [fromHex({ value: String(inputs.canonicalUnsignedUnlockEnvelopeHex) })],
    }),
    unlockAuthenticatorKey: encodeCryptoContext({
      domain: "HizoFS/v1/unlock-authenticator-key",
      fields: [
        fileSystemId,
        Buffer.of(Number(inputs.unlockCopy)),
        u64Be({ value: BigInt(Number(inputs.unlockSequence)) }),
      ],
    }),
  };
}

export async function loadKnownAnswerVectors({ fixturePath }) {
  const parsed = JSON.parse(await readFile(fixturePath, "utf8"));
  if (parsed?.schema !== "hizofs-v1-known-answer-vectors" || parsed?.schemaVersion !== 1) {
    throw new TypeError("unsupported HizoFS known-answer fixture");
  }
  return parsed;
}

export async function verifyKnownAnswerVectors({ fixturePath }) {
  const vector = await loadKnownAnswerVectors({ fixturePath });
  const { inputs, expected } = vector;
  const binaryVectorCount = verifyBinaryFixtureRoundTrips({ expected });
  const contexts = contextVectors({ inputs });
  for (const [name, bytes] of Object.entries(contexts)) {
    expectHex({ actual: bytes, expected: expected.contextsHex[name], label: `${name} context` });
  }

  const rootKey = fromHex({ value: String(inputs.rootKeyHex) });
  const recordDerivedKey = Buffer.from(hkdfSync(
    "sha256",
    rootKey,
    Buffer.alloc(0),
    contexts.recordKey,
    32,
  ));
  expectHex({
    actual: recordDerivedKey,
    expected: expected.recordDerivedKeyHex,
    label: "record HKDF key",
  });

  const recordNonce = fromHex({ value: String(inputs.recordNonceHex) });
  const recordPlaintext = fromHex({ value: String(inputs.recordPlaintextHex) });
  const recordCiphertext = aesGcmEncrypt({
    aad: contexts.recordAad,
    key: recordDerivedKey,
    nonce: recordNonce,
    plaintext: recordPlaintext,
  });
  expectHex({
    actual: recordCiphertext,
    expected: expected.recordCiphertextAndTagHex,
    label: "record ciphertext and tag",
  });
  assert.deepEqual(
    aesGcmDecrypt({
      aad: contexts.recordAad,
      ciphertextAndTag: recordCiphertext,
      key: recordDerivedKey,
      nonce: recordNonce,
    }),
    recordPlaintext,
  );
  const wrongRecordAad = Buffer.from(contexts.recordAad);
  wrongRecordAad[wrongRecordAad.length - 1] ^= 1;
  assert.throws(() => aesGcmDecrypt({
    aad: wrongRecordAad,
    ciphertextAndTag: recordCiphertext,
    key: recordDerivedKey,
    nonce: recordNonce,
  }));

  const credentialWrappingKey = pbkdf2Sync(
    Buffer.from(String(inputs.passphrase), "utf8"),
    contexts.passphraseSlotKdf,
    Number(inputs.iterations),
    32,
    "sha256",
  );
  expectHex({
    actual: credentialWrappingKey,
    expected: expected.credentialWrappingKeyHex,
    label: "credential wrapping key",
  });
  const wrappedRootKey = aesGcmEncrypt({
    aad: contexts.passphraseSlotAad,
    key: credentialWrappingKey,
    nonce: fromHex({ value: String(inputs.credentialWrapNonceHex) }),
    plaintext: rootKey,
  });
  expectHex({
    actual: wrappedRootKey,
    expected: expected.wrappedRootKeyCiphertextAndTagHex,
    label: "wrapped Root Key",
  });
  assert.deepEqual(aesGcmDecrypt({
    aad: contexts.passphraseSlotAad,
    ciphertextAndTag: wrappedRootKey,
    key: credentialWrappingKey,
    nonce: fromHex({ value: String(inputs.credentialWrapNonceHex) }),
  }), rootKey);

  const unlockAuthenticatorKey = Buffer.from(hkdfSync(
    "sha256",
    rootKey,
    Buffer.alloc(0),
    contexts.unlockAuthenticatorKey,
    32,
  ));
  const unlockAuthenticatorTag = aesGcmEncrypt({
    aad: contexts.unlockAuthenticatorAad,
    key: unlockAuthenticatorKey,
    nonce: fromHex({ value: String(inputs.unlockAuthenticatorNonceHex) }),
    plaintext: Buffer.alloc(0),
  });
  expectHex({
    actual: unlockAuthenticatorTag,
    expected: expected.unlockAuthenticatorTagHex,
    label: "Unlock Authenticator tag",
  });
  assert.equal(aesGcmDecrypt({
    aad: contexts.unlockAuthenticatorAad,
    ciphertextAndTag: unlockAuthenticatorTag,
    key: unlockAuthenticatorKey,
    nonce: fromHex({ value: String(inputs.unlockAuthenticatorNonceHex) }),
  }).length, 0);

  return Object.freeze({
    binaryVectorCount,
    contextVectorCount: Object.keys(contexts).length,
    cryptoVectorCount: 4,
    schemaVersion: vector.schemaVersion,
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const fixturePath = process.argv[2] ?? fileURLToPath(new URL(
    "../../../src/00-storage/service/hizofs/00-format/v1/test-fixtures/known-answer-vectors-v1.json",
    import.meta.url,
  ));
  const result = await verifyKnownAnswerVectors({ fixturePath });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
