import { Buffer } from "node:buffer";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath, URL } from "node:url";

import { decodeRootInodeLeafPage, verifyPortableRootInode } from "./read-root-inode.mjs";


const knownAnswerPath = fileURLToPath(new URL(
  "../../../src/00-storage/service/hizofs/00-format/v1/test-fixtures/known-answer-vectors-v1.json",
  import.meta.url,
));

const fixturePath = fileURLToPath(new URL(
  "../../../src/00-storage/service/hizofs/authenticated-store/tests/test-fixtures/empty-container-portable-v1.json",
  import.meta.url,
));

test("reads the portable root Inode Table and empty root directory", async () => {
  assert.deepEqual(await verifyPortableRootInode({ fixturePath, passphrase: undefined }), {
    rootDirectoryContent: "inline",
    rootDirectoryCreatedAt: null,
    rootDirectoryEntryCount: 0,
    rootDirectoryInodeNumber: "1",
    rootDirectoryInodeRevision: "1",
    rootDirectoryModifiedAt: null,
    rootInodeTableEntryCount: 1,
    rootInodeTableFrameLength: 112,
    rootInodeTableLevel: 0,
    segmentBytes: 368,
  });
});

test("rejects non-zero root Inode Table page flags", () => {
  const bytes = Buffer.from([0, 1, 0, 0]);
  assert.throws(() => decodeRootInodeLeafPage({ bytes }), /header is invalid/u);
});


test("rejects trailing bytes in a root Inode Table leaf", () => {
  assert.throws(() => decodeRootInodeLeafPage({ bytes: Buffer.from([0, 0, 0, 0, 0]) }), /trailing bytes/u);
});

test("rejects an excessive root Inode Table item count", () => {
  assert.throws(() => decodeRootInodeLeafPage({ bytes: Buffer.from([0, 0, 0x0b, 0x22]) }), /header is invalid/u);
});


test("decodes the independent inline namespace known-answer leaf", async () => {
  const fixture = JSON.parse(await readFile(knownAnswerPath, "utf8"));
  const page = decodeRootInodeLeafPage({ bytes: Buffer.from(fixture.expected.inodeLeafPageHex, "hex") });
  assert.equal(page.itemCount, 4);
  const [root, file, child, symlink] = page.entries;
  assert.deepEqual(root.entries, [
    { inodeKind: "file", inodeNumber: 2n, name: "hello.txt", targetType: "inode" },
    { inodeKind: "directory", inodeNumber: 3n, name: "sub", targetType: "inode" },
    { inodeKind: "symlink", inodeNumber: 4n, name: "sym", targetType: "inode" },
  ]);
  assert.equal(file.inodeKind, "file");
  assert.equal(file.inodeRevision, 3n);
  assert.equal(file.fileSize, 6n);
  assert.equal(file.inlineBytes.toString("utf8"), "hello\n");
  assert.equal(file.timestamps.createdAt, -10n);
  assert.equal(file.timestamps.modifiedAt, 20n);
  assert.equal(child.inodeKind, "directory");
  assert.deepEqual(child.entries, []);
  assert.equal(symlink.inodeKind, "symlink");
  assert.equal(symlink.target, "../hello.txt");
  assert.equal(symlink.timestamps.modifiedAt, 30n);
});
