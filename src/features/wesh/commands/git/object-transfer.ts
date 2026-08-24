import { bytesToHex } from './bytes';
import type { GitFiles } from './files';
import { readObject, writeObject } from './objects';
import type { GitObject } from './objects';
import type { GitRepository } from './repository';

const textDecoder = new TextDecoder();

function commitReferences({ object }: { object: GitObject }): string[] {
  const headerEnd = (() => {
    for (let index = 0; index + 1 < object.body.byteLength; index += 1) {
      if (object.body[index] === 0x0a && object.body[index + 1] === 0x0a) return index;
    }
    return -1;
  })();
  if (headerEnd < 0) throw new Error('corrupt commit: missing header terminator');
  const headers = textDecoder.decode(object.body.subarray(0, headerEnd)).split('\n');
  const references: string[] = [];
  for (const header of headers) {
    if (header.startsWith('tree ')) references.push(header.slice(5));
    else if (header.startsWith('parent ')) references.push(header.slice(7));
  }
  if (!references.some(reference => /^[0-9a-f]{40}$/u.test(reference))) {
    throw new Error('corrupt commit: missing object reference');
  }
  return references;
}

function tagReferences({ object }: { object: GitObject }): string[] {
  const firstNewline = object.body.indexOf(0x0a);
  if (firstNewline < 0) throw new Error('corrupt tag: missing object header');
  const firstLine = textDecoder.decode(object.body.subarray(0, firstNewline));
  const match = /^object ([0-9a-f]{40})$/u.exec(firstLine);
  if (match === null) throw new Error('corrupt tag: invalid object header');
  return [match[1]!];
}

function treeReferences({ object }: { object: GitObject }): string[] {
  const references: string[] = [];
  let offset = 0;
  while (offset < object.body.byteLength) {
    const spaceOffset = object.body.indexOf(0x20, offset);
    if (spaceOffset < 0) throw new Error('corrupt tree: missing mode separator');
    const nulOffset = object.body.indexOf(0, spaceOffset + 1);
    if (nulOffset < 0 || nulOffset + 21 > object.body.byteLength) throw new Error('corrupt tree: truncated entry');
    const modeText = textDecoder.decode(object.body.subarray(offset, spaceOffset));
    const mode = Number.parseInt(modeText, 8);
    if (!Number.isFinite(mode)) throw new Error('corrupt tree: invalid mode');
    if (mode !== 0o160000) {
      references.push(bytesToHex({ bytes: object.body.subarray(nulOffset + 1, nulOffset + 21) }));
    }
    offset = nulOffset + 21;
  }
  return references;
}

function referencedObjectIds({ object }: { object: GitObject }): string[] {
  switch (object.type) {
  case 'blob':
    return [];
  case 'tree':
    return treeReferences({ object });
  case 'commit':
    return commitReferences({ object });
  case 'tag':
    return tagReferences({ object });
  default: {
    const _ex: never = object.type;
    throw new Error(`Unhandled object type: ${_ex}`);
  }
  }
}

export async function transferReachableObjects({ files, sourceRepository, destinationRepository, rootObjectIds }: {
  files: GitFiles,
  sourceRepository: GitRepository,
  destinationRepository: GitRepository,
  rootObjectIds: readonly string[],
}): Promise<number> {
  const visited = new Set<string>();
  const pending = [...rootObjectIds];
  let transferred = 0;
  while (pending.length > 0) {
    const objectId = pending.pop()!;
    if (visited.has(objectId)) continue;
    visited.add(objectId);
    const object = await readObject({ files, repository: sourceRepository, objectId });
    const writtenObjectId = await writeObject({
      files,
      repository: destinationRepository,
      type: object.type,
      body: object.body,
    });
    if (writtenObjectId !== objectId) throw new Error(`object id changed while transferring ${objectId}`);
    transferred += 1;
    pending.push(...referencedObjectIds({ object }));
  }
  return transferred;
}

export const TEST_ONLY = {
  referencedObjectIds,
};
