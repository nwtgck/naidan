import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath, URL } from "node:url";

import { verifyPortableUnlock } from "./read-empty-container.mjs";

const fixturePath = fileURLToPath(new URL(
  "../../../src/00-storage/service/hizofs/authenticated-store/tests/test-fixtures/empty-container-portable-v1.json",
  import.meta.url,
));

test("independently unlocks both portable Unlock Envelope copies", async () => {
  assert.deepEqual(await verifyPortableUnlock({ fixturePath }), {
    authenticatedUnlockCopies: 2,
    credentialSlotCount: 1,
    fileSystemId: "57XP043891T62-modnaes",
    rootKeyBytes: 32,
    schemaVersion: 1,
    selectedUnlockCopy: 0,
    unlockSequence: 1,
  });
});

test("rejects a wrong portable fixture passphrase", async () => {
  await assert.rejects(
    verifyPortableUnlock({ fixturePath, passphrase: "wrong passphrase" }),
    /did not authenticate/u,
  );
});
