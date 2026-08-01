import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import test from "node:test";
import { fileURLToPath, URL } from "node:url";

import { decodeRequiredRecordReference } from "./binary-fixtures.mjs";
import {
  encodeCryptoContext,
  loadKnownAnswerVectors,
  verifyKnownAnswerVectors,
} from "./verify-vectors.mjs";

const fixturePath = fileURLToPath(new URL(
  "../../../src/00-storage/service/hizofs/00-format/v1/test-fixtures/known-answer-vectors-v1.json",
  import.meta.url,
));

test("verifies HizoFS V1 known-answer vectors independently", async () => {
  assert.deepEqual(await verifyKnownAnswerVectors({ fixturePath }), {
    binaryVectorCount: 3,
    contextVectorCount: 8,
    cryptoVectorCount: 4,
    schemaVersion: 1,
  });
});

test("rejects invalid independent context framing inputs", () => {
  assert.throws(() => encodeCryptoContext({ domain: "", fields: [] }), /printable ASCII/u);
  assert.throws(() => encodeCryptoContext({ domain: "HizoFS/v1/test", fields: new Array(65_536).fill(Buffer.alloc(0)) }), /field count/u);
});

test("rejects non-zero Record Reference reserved bytes", async () => {
  const fixture = await loadKnownAnswerVectors({ fixturePath });
  const commitBytes = Buffer.from(fixture.expected.fileSystemCommitHex, "hex");
  const corruptedReference = Buffer.from(commitBytes.subarray(32, 64));
  corruptedReference[29] = 1;
  assert.throws(
    () => decodeRequiredRecordReference({ bytes: corruptedReference }),
    /reserved bytes must be zero/u,
  );
});
