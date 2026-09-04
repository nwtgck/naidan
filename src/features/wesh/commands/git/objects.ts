import { pathExists, readFileBytes, writeFileBytes } from './files';
import type { GitFiles } from './files';
import type { GitObject, GitObjectType } from './object-format';
import { encodeObjectHeader, objectIdFor } from './object-format';
import { createGitPackReadCache, readPackedObject } from './pack-reader';
import type { GitPackReadCache } from './pack-reader';
import type { GitRepository } from './repository';
import { joinPath } from './repository';
import { deflateZlibChunks, inflateZlib } from './zlib';

export type { GitObject, GitObjectType } from './object-format';
export { objectIdFor } from './object-format';

const textDecoder = new TextDecoder();

export async function writeObject({ files, repository, type, body }: {
  files: GitFiles,
  repository: GitRepository,
  type: GitObjectType,
  body: Uint8Array,
}): Promise<string> {
  const header = encodeObjectHeader({ type, bodyByteLength: body.byteLength });
  const objectId = objectIdFor({ type, body });
  const objectDirectory = joinPath({ base: repository.commonDirPath, child: `objects/${objectId.slice(0, 2)}` });
  const objectPath = joinPath({ base: objectDirectory, child: objectId.slice(2) });
  if (!await pathExists({ files, path: objectDirectory })) {
    await files.mkdir({ path: objectDirectory, recursive: true });
  }
  if (!await pathExists({ files, path: objectPath })) {
    await writeFileBytes({
      files,
      path: objectPath,
      bytes: await deflateZlibChunks({ chunks: [header, body] }),
    });
  }
  return objectId;
}

async function readLooseObject({ files, repository, objectId }: {
  files: GitFiles,
  repository: GitRepository,
  objectId: string,
}): Promise<GitObject | undefined> {
  const objectPath = joinPath({
    base: repository.commonDirPath,
    child: `objects/${objectId.slice(0, 2)}/${objectId.slice(2)}`,
  });
  if (!await pathExists({ files, path: objectPath })) return undefined;
  const encoded = await inflateZlib({ bytes: await readFileBytes({ files, path: objectPath }) });
  const nulIndex = encoded.indexOf(0);
  if (nulIndex < 0) throw new Error(`Corrupt loose object ${objectId}: missing header terminator`);
  const header = textDecoder.decode(encoded.subarray(0, nulIndex));
  const match = /^(blob|tree|commit|tag) ([0-9]+)$/u.exec(header);
  if (match === null) throw new Error(`Corrupt loose object ${objectId}: invalid header`);
  const body = encoded.subarray(nulIndex + 1);
  const expectedLength = Number.parseInt(match[2]!, 10);
  if (body.byteLength !== expectedLength) {
    throw new Error(`Corrupt loose object ${objectId}: size mismatch`);
  }
  const type = match[1] as GitObjectType;
  if (objectIdFor({ type, body }) !== objectId) {
    throw new Error(`Corrupt loose object ${objectId}: object id mismatch`);
  }
  return { type, body };
}

export interface GitObjectReadCache {
  packReadCache: GitPackReadCache,
}

export function createGitObjectReadCache(): GitObjectReadCache {
  return { packReadCache: createGitPackReadCache() };
}

interface ObjectResolutionContext {
  resolvingObjectIds: Set<string>,
  cache: GitObjectReadCache | undefined,
}

async function readObjectInternal({ files, repository, objectId, resolutionContext }: {
  files: GitFiles,
  repository: GitRepository,
  objectId: string,
  resolutionContext: ObjectResolutionContext,
}): Promise<GitObject> {
  if (!/^[0-9a-f]{40}$/u.test(objectId)) {
    throw new Error(`Invalid object id: ${objectId}`);
  }
  if (resolutionContext.resolvingObjectIds.has(objectId)) {
    throw new Error(`packed object dependency cycle detected for ${objectId}`);
  }
  resolutionContext.resolvingObjectIds.add(objectId);
  try {
    const looseObject = await readLooseObject({ files, repository, objectId });
    if (looseObject !== undefined) return looseObject;
    const packedObject = await readPackedObject({
      files,
      repository,
      objectId,
      readExternalObject: async ({ objectId: baseObjectId }) => readObjectInternal({
        files,
        repository,
        objectId: baseObjectId,
        resolutionContext,
      }),
      cache: resolutionContext.cache?.packReadCache,
    });
    if (packedObject !== undefined) return packedObject;
    throw new Error(`Object not found: ${objectId}`);
  } finally {
    resolutionContext.resolvingObjectIds.delete(objectId);
  }
}

export async function readObject({ files, repository, objectId, cache }: {
  files: GitFiles,
  repository: GitRepository,
  objectId: string,
  cache?: GitObjectReadCache,
}): Promise<GitObject> {
  return readObjectInternal({
    files,
    repository,
    objectId,
    resolutionContext: { resolvingObjectIds: new Set(), cache },
  });
}

export const TEST_ONLY = {
  readLooseObject,
};
