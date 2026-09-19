import { bytesToHex, compareBytes, writeHexBytes } from './bytes';
import type { GitFiles } from './files';
import type { GitIndexEntry } from './index-file';
import { createGitObjectReadCache, readObject, writeObject } from './objects';
import type { GitObjectReadCache } from './objects';
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

interface GitTreeObjectEntry {
  name: string,
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
  const records: Array<{
    mode: number,
    objectId: string,
    modeBytes: Uint8Array,
    nameBytes: Uint8Array,
    sortKey: Uint8Array,
  }> = [];

  const appendRecord = ({ name, mode, objectId, isDirectory }: {
    name: string,
    mode: number,
    objectId: string,
    isDirectory: boolean,
  }): void => {
    const nameBytes = textEncoder.encode(name);
    let sortKey = nameBytes;
    if (isDirectory) {
      sortKey = new Uint8Array(nameBytes.byteLength + 1);
      sortKey.set(nameBytes);
      sortKey[nameBytes.byteLength] = 0x2f;
    }
    records.push({
      mode,
      objectId,
      modeBytes: textEncoder.encode(mode.toString(8)),
      nameBytes,
      sortKey,
    });
  };

  for (const [name, entry] of node.files) {
    appendRecord({ name, mode: entry.mode, objectId: entry.objectId, isDirectory: false });
  }
  for (const [name, child] of node.directories) {
    appendRecord({
      name,
      mode: 0o40000,
      objectId: await writeTreeNode({ files, repository, node: child }),
      isDirectory: true,
    });
  }
  records.sort((left, right) => compareBytes({ left: left.sortKey, right: right.sortKey }));

  const bodyLength = records.reduce(
    (length, record) => length + record.modeBytes.byteLength + 1 + record.nameBytes.byteLength + 1 + 20,
    0,
  );
  const body = new Uint8Array(bodyLength);
  let offset = 0;
  for (const record of records) {
    body.set(record.modeBytes, offset);
    offset += record.modeBytes.byteLength;
    body[offset] = 0x20;
    offset += 1;
    body.set(record.nameBytes, offset);
    offset += record.nameBytes.byteLength;
    body[offset] = 0;
    offset += 1;
    writeHexBytes({ hex: record.objectId, bytes: body, offset, byteLength: 20 });
    offset += 20;
  }
  return writeObject({ files, repository, type: 'tree', body });
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

async function readTreeObjectEntries({ files, repository, treeObjectId, objectReadCache }: {
  files: GitFiles,
  repository: GitRepository,
  treeObjectId: string,
  objectReadCache?: GitObjectReadCache,
}): Promise<GitTreeObjectEntry[]> {
  const object = await readObject({ files, repository, objectId: treeObjectId, cache: objectReadCache });
  switch (object.type) {
  case 'tree':
    break;
  case 'blob':
  case 'commit':
  case 'tag':
    throw new Error(`object ${treeObjectId} is not a tree`);
  default: {
    const _ex: never = object.type;
    throw new Error(`Unhandled object type: ${_ex}`);
  }
  }

  const entries: GitTreeObjectEntry[] = [];
  let offset = 0;
  while (offset < object.body.byteLength) {
    const spaceOffset = object.body.indexOf(0x20, offset);
    if (spaceOffset < 0) throw new Error(`corrupt tree ${treeObjectId}: missing mode separator`);
    const nulOffset = object.body.indexOf(0, spaceOffset + 1);
    if (nulOffset < 0 || nulOffset + 21 > object.body.byteLength)
      throw new Error(`corrupt tree ${treeObjectId}: truncated entry`);
    const modeText = textDecoder.decode(object.body.subarray(offset, spaceOffset));
    const mode = Number.parseInt(modeText, 8);
    if (!Number.isFinite(mode)) throw new Error(`corrupt tree ${treeObjectId}: invalid mode`);
    const name = decodeGitPathBytes({ bytes: object.body.subarray(spaceOffset + 1, nulOffset), source: 'tree' });
    assertSafeGitTreeEntryName({ name });
    entries.push({
      name,
      objectId: bytesToHex({ bytes: object.body.subarray(nulOffset + 1, nulOffset + 21) }),
      mode,
    });
    offset = nulOffset + 21;
  }
  return entries;
}

export async function readTreePath({ files, repository, treeObjectId, path, objectReadCache }: {
  files: GitFiles,
  repository: GitRepository,
  treeObjectId: string,
  path: string,
  objectReadCache?: GitObjectReadCache,
}): Promise<GitTreeEntry | undefined> {
  const segments = path.split('/');
  let currentTreeObjectId = treeObjectId;
  let currentPath = '';

  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index]!;
    const entries = await readTreeObjectEntries({
      files,
      repository,
      treeObjectId: currentTreeObjectId,
      objectReadCache,
    });
    const entry = entries.find(candidate => candidate.name === segment);
    if (entry === undefined) return undefined;

    currentPath = currentPath.length === 0 ? segment : `${currentPath}/${segment}`;
    assertSafeGitRepositoryPath({ path: currentPath, source: 'tree' });
    if (index === segments.length - 1) {
      return { path: currentPath, objectId: entry.objectId, mode: entry.mode };
    }
    if (entry.mode !== 0o40000) return undefined;
    currentTreeObjectId = entry.objectId;
  }

  return undefined;
}

export async function readTreeRecursively({ files, repository, treeObjectId, objectReadCache }: {
  files: GitFiles,
  repository: GitRepository,
  treeObjectId: string,
  objectReadCache?: GitObjectReadCache,
}): Promise<GitTreeEntry[]> {
  const result: GitTreeEntry[] = [];

  const visit = async ({ objectId, prefix }: { objectId: string, prefix: string }): Promise<void> => {
    const entries = await readTreeObjectEntries({ files, repository, treeObjectId: objectId, objectReadCache });
    for (const entry of entries) {
      const path = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
      assertSafeGitRepositoryPath({ path, source: 'tree' });
      if (entry.mode === 0o40000) {
        await visit({ objectId: entry.objectId, prefix: path });
      } else {
        result.push({ path, objectId: entry.objectId, mode: entry.mode });
      }
    }
  };

  await visit({ objectId: treeObjectId, prefix: '' });
  return result;
}

export async function readTreeIntoIndex({ files, repository, treeObjectId, objectReadCache: suppliedObjectReadCache }: {
  files: GitFiles,
  repository: GitRepository,
  treeObjectId: string,
  objectReadCache?: GitObjectReadCache,
}): Promise<GitIndexEntry[]> {
  const objectReadCache = suppliedObjectReadCache ?? createGitObjectReadCache();
  const treeEntries = await readTreeRecursively({
    files,
    repository,
    treeObjectId,
    objectReadCache,
  });
  const indexEntries: GitIndexEntry[] = [];
  for (const entry of treeEntries) {
    let size = 0;
    if (entry.mode !== 0o160000) {
      const object = await readObject({ files, repository, objectId: entry.objectId, cache: objectReadCache });
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
