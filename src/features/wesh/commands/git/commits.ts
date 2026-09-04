import type { GitConfig } from './config';
import type { GitFiles } from './files';
import type { GitIdentity } from './identity';
import { resolveGitIdentity, resolveGitTimestamp } from './identity';
import { createGitObjectReadCache, readObject, writeObject } from './objects';
import type { GitObjectReadCache } from './objects';
import type { GitRepository } from './repository';

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export interface ParsedCommit {
  treeObjectId: string,
  parentObjectIds: string[],
  author: string,
  committer: string,
  message: string,
}

export type GitCommitCache = Map<string, ParsedCommit> & {
  objectReadCache: GitObjectReadCache,
};

export function createGitCommitCache(): GitCommitCache {
  const cache = new Map<string, ParsedCommit>() as GitCommitCache;
  cache.objectReadCache = createGitObjectReadCache();
  return cache;
}

export interface GitCommitAuthor {
  identity: GitIdentity,
  timestamp: string,
}

export interface CreatedCommit {
  objectId: string,
  authorIdentity: GitIdentity,
  authorTimestamp: string,
  committerIdentity: GitIdentity,
  committerTimestamp: string,
}

export function parseCommitAuthor({ value }: { value: string }): GitCommitAuthor {
  const match = /^(.*) <([^>]*)> ([0-9]+ [+-][0-9]{4})$/u.exec(value);
  if (match === null) throw new Error(`invalid commit author: ${value}`);
  return { identity: { name: match[1]!, email: match[2]! }, timestamp: match[3]! };
}

export async function createCommit({ files, repository, config, env, treeObjectId, parentObjectIds, message, authorOverride }: {
  files: GitFiles,
  repository: GitRepository,
  config: GitConfig,
  env: Map<string, string>,
  treeObjectId: string,
  parentObjectIds: readonly string[],
  message: string,
  authorOverride: GitCommitAuthor | undefined,
}): Promise<CreatedCommit> {
  const authorIdentity = authorOverride?.identity ?? resolveGitIdentity({ env, config, role: 'AUTHOR' });
  const committerIdentity = resolveGitIdentity({ env, config, role: 'COMMITTER' });
  const authorTimestamp = authorOverride?.timestamp ?? resolveGitTimestamp({ env, role: 'AUTHOR' });
  const committerTimestamp = resolveGitTimestamp({ env, role: 'COMMITTER' });
  const normalizedMessage = message.endsWith('\n') ? message : `${message}\n`;
  const lines = [
    `tree ${treeObjectId}`,
    ...parentObjectIds.map(parent => `parent ${parent}`),
    `author ${authorIdentity.name} <${authorIdentity.email}> ${authorTimestamp}`,
    `committer ${committerIdentity.name} <${committerIdentity.email}> ${committerTimestamp}`,
    '',
    normalizedMessage,
  ];
  const objectId = await writeObject({
    files,
    repository,
    type: 'commit',
    body: textEncoder.encode(lines.join('\n')),
  });
  return {
    objectId,
    authorIdentity,
    authorTimestamp,
    committerIdentity,
    committerTimestamp,
  };
}

export async function readCommit({ files, repository, objectId, objectReadCache }: {
  files: GitFiles,
  repository: GitRepository,
  objectId: string,
  objectReadCache?: GitObjectReadCache,
}): Promise<ParsedCommit> {
  const object = await readObject({ files, repository, objectId, cache: objectReadCache });
  switch (object.type) {
  case 'commit':
    break;
  case 'blob':
  case 'tree':
  case 'tag':
    throw new Error(`object ${objectId} is not a commit`);
  default: {
    const _ex: never = object.type;
    throw new Error(`Unhandled object type: ${_ex}`);
  }
  }
  const text = textDecoder.decode(object.body);
  const separatorIndex = text.indexOf('\n\n');
  if (separatorIndex < 0) throw new Error(`corrupt commit ${objectId}`);
  const headers = text.slice(0, separatorIndex).split('\n');
  let treeObjectId: string | undefined;
  const parentObjectIds: string[] = [];
  let author: string | undefined;
  let committer: string | undefined;
  for (const header of headers) {
    if (header.startsWith('tree ')) treeObjectId = header.slice(5);
    else if (header.startsWith('parent ')) parentObjectIds.push(header.slice(7));
    else if (header.startsWith('author ')) author = header.slice(7);
    else if (header.startsWith('committer ')) committer = header.slice(10);
  }
  if (treeObjectId === undefined || author === undefined || committer === undefined) {
    throw new Error(`corrupt commit ${objectId}: required header is missing`);
  }
  return {
    treeObjectId,
    parentObjectIds,
    author,
    committer,
    message: text.slice(separatorIndex + 2),
  };
}

export async function readCachedCommit({ files, repository, objectId, cache }: {
  files: GitFiles,
  repository: GitRepository,
  objectId: string,
  cache: GitCommitCache | undefined,
}): Promise<ParsedCommit> {
  if (cache === undefined) return readCommit({ files, repository, objectId });
  const cached = cache.get(objectId);
  if (cached !== undefined) return cached;
  const commit = await readCommit({ files, repository, objectId, objectReadCache: cache.objectReadCache });
  cache.set(objectId, commit);
  return commit;
}

export function commitSubject({ commit }: { commit: ParsedCommit }): string {
  return commit.message.split('\n', 1)[0] ?? '';
}

export const TEST_ONLY = {
};
