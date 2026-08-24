import { compareBytes, concatBytes, hexToBytes } from './bytes';
import type { GitFiles } from './files';
import type { GitIndexEntry } from './index-file';
import { readObject, writeObject } from './objects';
import type { GitRepository } from './repository';
import { assertSafeGitRepositoryPath, assertSafeGitTreeEntryName, decodeGitPathBytes } from './path-safety';

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder('utf-8', { fatal: true });

interface TreeNode {
  files: Map<string, GitIndexEntry>,
  directories: Map<string, TreeNode>,
}

export interface GitTreeEntry {
  path: string,
  objectId: string,
  mode: number,
}

function createTreeNode(): TreeNode {
  return { files: new Map(), directories: new Map() };
}

function insertIndexEntry({ root, entry }: { root: TreeNode, entry: GitIndexEntry }): void {
  assertSafeGitRepositoryPath({ path: entry.path, source: 'index' });
  const segments = entry.path.split('/');
  if (segments.some(segment => segment.length === 0)) throw new Error(`invalid index path: ${entry.path}`);
  let node = root;
  for (let index = 0; index < segments.length - 1; index += 1) {
    const segment = segments[index]!;
    const existing = node.directories.get(segment);
    if (existing !== undefined) {
      node = existing;
      continue;
    }
    const created = createTreeNode();
    node.directories.set(segment, created);
    node = created;
  }
  node.files.set(segments[segments.length - 1]!, entry);
}

async function writeTreeNode({ files, repository, node }: {
  files: GitFiles,
  repository: GitRepository,
  node: TreeNode,
}): Promise<string> {
  const records: Array<{ name: string, isDirectory: boolean, mode: number, objectId: string }> = [];
  for (const [name, entry] of node.files) {
    records.push({ name, isDirectory: false, mode: entry.mode, objectId: entry.objectId });
  }
  for (const [name, child] of node.directories) {
    records.push({
      name,
      isDirectory: true,
      mode: 0o40000,
      objectId: await writeTreeNode({ files, repository, node: child }),
    });
  }
  records.sort((left, right) => compareBytes({
    left: textEncoder.encode(left.isDirectory ? `${left.name}/` : left.name),
    right: textEncoder.encode(right.isDirectory ? `${right.name}/` : right.name),
  }));

  const chunks = records.flatMap(record => [
    textEncoder.encode(`${record.mode.toString(8)} ${record.name}\0`),
    hexToBytes({ hex: record.objectId }),
  ]);
  return writeObject({
    files,
    repository,
    type: 'tree',
    body: concatBytes({ chunks }),
  });
}

export async function writeTreeFromIndex({ files, repository, entries }: {
  files: GitFiles,
  repository: GitRepository,
  entries: readonly GitIndexEntry[],
}): Promise<string> {
  const root = createTreeNode();
  for (const entry of entries) {
    if (entry.stage !== 0) throw new Error(`cannot write tree with unmerged index entry: ${entry.path}`);
    insertIndexEntry({ root, entry });
  }
  return writeTreeNode({ files, repository, node: root });
}

export async function readTreeRecursively({ files, repository, treeObjectId }: {
  files: GitFiles,
  repository: GitRepository,
  treeObjectId: string,
}): Promise<GitTreeEntry[]> {
  const result: GitTreeEntry[] = [];

  const visit = async ({ objectId, prefix }: { objectId: string, prefix: string }): Promise<void> => {
    const object = await readObject({ files, repository, objectId });
    switch (object.type) {
    case 'tree':
      break;
    case 'blob':
    case 'commit':
    case 'tag':
      throw new Error(`object ${objectId} is not a tree`);
    default: {
      const _ex: never = object.type;
      throw new Error(`Unhandled object type: ${_ex}`);
    }
    }
    let offset = 0;
    while (offset < object.body.byteLength) {
      const spaceOffset = object.body.indexOf(0x20, offset);
      if (spaceOffset < 0) throw new Error(`corrupt tree ${objectId}: missing mode separator`);
      const nulOffset = object.body.indexOf(0, spaceOffset + 1);
      if (nulOffset < 0 || nulOffset + 21 > object.body.byteLength) throw new Error(`corrupt tree ${objectId}: truncated entry`);
      const modeText = textDecoder.decode(object.body.subarray(offset, spaceOffset));
      const mode = Number.parseInt(modeText, 8);
      if (!Number.isFinite(mode)) throw new Error(`corrupt tree ${objectId}: invalid mode`);
      const name = decodeGitPathBytes({ bytes: object.body.subarray(spaceOffset + 1, nulOffset), source: 'tree' });
      assertSafeGitTreeEntryName({ name });
      const childObjectId = Array.from(
        object.body.subarray(nulOffset + 1, nulOffset + 21),
        byte => byte.toString(16).padStart(2, '0'),
      ).join('');
      const path = prefix.length === 0 ? name : `${prefix}/${name}`;
      assertSafeGitRepositoryPath({ path, source: 'tree' });
      if (mode === 0o40000) {
        await visit({ objectId: childObjectId, prefix: path });
      } else {
        result.push({ path, objectId: childObjectId, mode });
      }
      offset = nulOffset + 21;
    }
  };

  await visit({ objectId: treeObjectId, prefix: '' });
  return result;
}

export async function readTreeIntoIndex({ files, repository, treeObjectId }: {
  files: GitFiles,
  repository: GitRepository,
  treeObjectId: string,
}): Promise<GitIndexEntry[]> {
  const treeEntries = await readTreeRecursively({ files, repository, treeObjectId });
  const indexEntries: GitIndexEntry[] = [];
  for (const entry of treeEntries) {
    let size = 0;
    if (entry.mode !== 0o160000) {
      const object = await readObject({ files, repository, objectId: entry.objectId });
      switch (object.type) {
      case 'blob':
        size = object.body.byteLength;
        break;
      case 'tree':
      case 'commit':
      case 'tag':
        throw new Error(`tree entry ${entry.path} does not reference a blob`);
      default: {
        const _ex: never = object.type;
        throw new Error(`Unhandled object type: ${_ex}`);
      }
      }
    }
    indexEntries.push({
      path: entry.path,
      objectId: entry.objectId,
      mode: entry.mode,
      size,
      stage: 0,
    });
  }
  return indexEntries;
}

export const TEST_ONLY = {
};
