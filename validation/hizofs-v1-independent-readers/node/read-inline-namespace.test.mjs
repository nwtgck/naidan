import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath, URL } from "node:url";

import { verifyPortableInlineNamespace } from "./read-inline-namespace.mjs";

const fixturePath = fileURLToPath(new URL(
  "../../../src/00-storage/service/hizofs/worker/tests/test-fixtures/nonempty-container-portable-v1.json",
  import.meta.url,
));

test("extracts the production-generated inline namespace", async () => {
  assert.deepEqual(await verifyPortableInlineNamespace({ fixturePath, passphrase: undefined }), {
    activeCommitSequence: "6",
    entries: [
      { inodeNumber: "3", inodeRevision: "2", kind: "directory", path: "/docs" },
      { contentHex: "6e65737465640a", inodeNumber: "4", inodeRevision: "2", kind: "file", path: "/docs/nested.txt", size: "7" },
      { contentHex: "68656c6c6f0a", inodeNumber: "2", inodeRevision: "2", kind: "file", path: "/hello.txt", size: "6" },
    ],
    rootDirectoryInodeNumber: "1",
  });
});
