import { Buffer } from "node:buffer";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";

import { loadPortableFixture, unlockPortableFixture } from "./read-empty-container.mjs";
import { readActiveCommitAuthority, readAuthenticatedHomeRecord } from "./read-active-commit.mjs";
import { decodeRootInodeLeafPage } from "./read-root-inode.mjs";
import { openPortableSuperblocks } from "./read-superblocks.mjs";

const INODE_TABLE_KIND = 16;
const MAXIMUM_DIRECTORY_DEPTH = 64;

export function readInlineNamespace({ fixture, rootKey, selected }) {
  const active = readActiveCommitAuthority({ fixture, rootKey, selected });
  const reference = active.commit.rootInodeTableRootHomeRef;
  const opened = readAuthenticatedHomeRecord({ expectedKind: INODE_TABLE_KIND, fixture, reference, rootKey });
  const page = decodeRootInodeLeafPage({ bytes: opened.plaintext });
  const byNumber = new Map(page.entries.map(entry => [entry.inodeNumber, entry]));
  const root = byNumber.get(active.commit.rootDirectoryInodeNumber);
  if (root?.inodeKind !== "directory") throw new TypeError("root directory Inode is missing or has the wrong kind");
  const entries = [];
  const visitedDirectories = new Set();
  const walk = ({ directory, path, depth }) => {
    if (depth > MAXIMUM_DIRECTORY_DEPTH) throw new RangeError("inline namespace depth exceeds the reader bound");
    if (directory.contentKind !== "inline") throw new TypeError("tree-backed directory traversal is not implemented");
    if (visitedDirectories.has(directory.inodeNumber)) throw new TypeError("inline namespace contains a directory cycle");
    visitedDirectories.add(directory.inodeNumber);
    for (const target of directory.entries) {
      if (target.targetType !== "inode") throw new TypeError("Subvolume traversal is not implemented");
      const inode = byNumber.get(target.inodeNumber);
      if (inode === undefined || inode.inodeKind !== target.inodeKind) {
        throw new TypeError("directory target disagrees with the root Inode Table");
      }
      const targetPath = `${path}/${target.name}`;
      const summary = {
        inodeNumber: inode.inodeNumber.toString(),
        inodeRevision: inode.inodeRevision.toString(),
        kind: inode.inodeKind,
        path: targetPath,
      };
      switch (inode.inodeKind) {
      case "directory":
        entries.push(summary);
        walk({ directory: inode, path: targetPath, depth: depth + 1 });
        break;
      case "file":
        if (inode.contentKind !== "inline") throw new TypeError("extent-backed file extraction is not implemented");
        entries.push({ contentHex: Buffer.from(inode.inlineBytes).toString("hex"), ...summary, size: inode.fileSize.toString() });
        break;
      case "symlink": entries.push({ ...summary, target: inode.target }); break;
      default: throw new TypeError("unsupported Inode kind");
      }
    }
  };
  walk({ directory: root, path: "", depth: 0 });
  entries.sort((left, right) => (left.path < right.path ? -1 : left.path === right.path ? 0 : 1));
  return Object.freeze({
    activeCommitSequence: active.commit.commitSequence.toString(),
    entries: Object.freeze(entries),
    rootDirectoryInodeNumber: root.inodeNumber.toString(),
  });
}

export async function verifyPortableInlineNamespace({ fixturePath, passphrase }) {
  const fixture = await loadPortableFixture({ fixturePath });
  const unlocked = unlockPortableFixture({ fixture, passphrase: passphrase ?? fixture.passphrase });
  try {
    const superblocks = openPortableSuperblocks({ fixture, rootKey: unlocked.rootKey, unlockSequence: unlocked.summary.unlockSequence });
    return readInlineNamespace({ fixture, rootKey: unlocked.rootKey, selected: superblocks.selected });
  } finally {
    unlocked.rootKey.fill(0);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const fixturePath = process.argv[2] ?? fileURLToPath(new URL(
    "../../../src/00-storage/service/hizofs/worker/tests/test-fixtures/nonempty-container-portable-v1.json",
    import.meta.url,
  ));
  process.stdout.write(`${JSON.stringify(await verifyPortableInlineNamespace({ fixturePath, passphrase: process.argv[3] }))}\n`);
}
