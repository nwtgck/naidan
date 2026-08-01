import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath, URL } from "node:url";

import { verifyPortableSuperblocks } from "./read-superblocks.mjs";

const fixturePath = fileURLToPath(new URL(
  "../../../src/00-storage/service/hizofs/authenticated-store/tests/test-fixtures/empty-container-portable-v1.json",
  import.meta.url,
));

test("independently decrypts and selects portable Superblock authority", async () => {
  const result = await verifyPortableSuperblocks({ fixturePath });
  assert.equal(result.authenticatedSuperblockCopies, 2);
  assert.equal(result.copyState, "normal");
  assert.equal(result.activeCommitSequence, "1");
  assert.equal(result.minimumUnlockSequence, "1");
  assert.equal(result.requiredFeatureBits, "0");
  assert.equal(result.fallbackCommitPresent, false);
  assert.equal(result.relocationIndexPresent, false);
  assert.equal(result.selectedPublicationSequence, "2");
  assert.equal(result.selectedSuperblockCopy, 1);
  assert.equal(result.activeCommitFrameLength, 192);
  assert.equal(result.activeCommitOffset, "176");
});
