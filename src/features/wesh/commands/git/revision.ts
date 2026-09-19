import type { GitFiles } from './files';
import { readCommit } from './commits';
import { pathExists } from './files';
import { createGitObjectReadCache, readObject } from './objects';
import type { GitObjectReadCache } from './objects';
import { findPackIndexObjectIdsByPrefix, readPackIndex } from './pack-index';
import { readHead, readRef } from './refs';
import type { GitRepository } from './repository';
import { joinPath } from './repository';
import { readTreePath } from './tree';

type RevisionSuffix =
  | { type: 'parent' | 'first-parent-ancestor', count: number }
  | { type: 'peel', expected: 'any' | 'commit' };

export class GitUnknownRevisionError extends Error {
  readonly expression: string;

  constructor({ expression }: { expression: string }) {
    super(`ambiguous argument '${expression}': unknown revision or path not in the working tree.`);
    this.name = 'GitUnknownRevisionError';
    this.expression = expression;
  }
}

function ambiguousRevisionError({ expression }: { expression: string }): GitUnknownRevisionError {
  return new GitUnknownRevisionError({ expression });
}

interface PeeledTagObject {
  objectId: string,
  type: 'blob' | 'commit' | 'tree',
}

async function peelTagObject({ files, repository, objectId, depth = 0, objectReadCache }: {
  files: GitFiles,
  repository: GitRepository,
  objectId: string,
  depth?: number,
  objectReadCache?: GitObjectReadCache,
}): Promise<PeeledTagObject> {
  if (depth > 16) throw new Error(`tag chain is too deep at ${objectId}`);
  const object = await readObject({ files, repository, objectId, cache: objectReadCache });
  switch (object.type) {
  case 'blob':
  case 'commit':
  case 'tree':
    return { objectId, type: object.type };
  case 'tag': {
    const text = new TextDecoder().decode(object.body);
    const match = /^object ([0-9a-f]{40})$/mu.exec(text);
    if (match === null) throw new Error(`corrupt tag ${objectId}: object header is missing`);
    return peelTagObject({
      files,
      repository,
      objectId: match[1]!,
      depth: depth + 1,
      objectReadCache,
    });
  }
  default: {
    const _ex: never = object.type;
    throw new Error(`Unhandled revision object type: ${_ex}`);
  }
  }
}

export async function peelTagObjectId({ files, repository, objectId, depth = 0, objectReadCache }: {
  files: GitFiles,
  repository: GitRepository,
  objectId: string,
  depth?: number,
  objectReadCache?: GitObjectReadCache,
}): Promise<string> {
  return (await peelTagObject({ files, repository, objectId, depth, objectReadCache })).objectId;
}

export async function peelToCommitObjectId({ files, repository, objectId, objectReadCache }: {
  files: GitFiles,
  repository: GitRepository,
  objectId: string,
  objectReadCache?: GitObjectReadCache,
}): Promise<string> {
  const peeled = await peelTagObject({ files, repository, objectId, objectReadCache });
  switch (peeled.type) {
  case 'commit':
    return peeled.objectId;
  case 'blob':
  case 'tree':
    throw new Error(`object ${peeled.objectId} is not a commit`);
  default: {
    const _ex: never = peeled.type;
    throw new Error(`Unhandled revision object type: ${_ex}`);
  }
  }
}

function parseRevisionExpression({ expression }: { expression: string }): {
  base: string,
  suffixes: RevisionSuffix[],
} {
  const specialIndex = expression.search(/[~^]/u);
  if (specialIndex < 0) return { base: expression, suffixes: [] };
  const base = expression.slice(0, specialIndex);
  const suffixText = expression.slice(specialIndex);
  if (base.length === 0) throw ambiguousRevisionError({ expression });

  const suffixes: RevisionSuffix[] = [];
  let offset = 0;
  while (offset < suffixText.length) {
    const marker = suffixText[offset]!;
    if (marker !== '~' && marker !== '^') {
      throw new Error(`invalid revision suffix in '${expression}'`);
    }
    offset += 1;
    if (marker === '^' && suffixText[offset] === '{') {
      const close = suffixText.indexOf('}', offset + 1);
      if (close < 0) throw new Error(`invalid revision suffix in '${expression}'`);
      const expected = suffixText.slice(offset + 1, close);
      if (expected === '') suffixes.push({ type: 'peel', expected: 'any' });
      else if (expected === 'commit') suffixes.push({ type: 'peel', expected: 'commit' });
      else throw new Error(`unsupported revision peel type '${expected}'`);
      offset = close + 1;
      continue;
    }
    const numberMatch = /^[0-9]+/u.exec(suffixText.slice(offset));
    const count = numberMatch === null ? 1 : Number.parseInt(numberMatch[0], 10);
    offset += numberMatch?.[0].length ?? 0;
    let type: 'first-parent-ancestor' | 'parent';
    switch (marker) {
    case '~':
      type = 'first-parent-ancestor';
      break;
    case '^':
      type = 'parent';
      break;
    default: {
      const _ex: never = marker;
      throw new Error(`Unhandled revision marker: ${_ex}`);
    }
    }
    suffixes.push({ type, count });
  }
  return { base, suffixes };
}

async function resolveAbbreviatedObjectId({ files, repository, prefix }: {
  files: GitFiles,
  repository: GitRepository,
  prefix: string,
}): Promise<string | undefined> {
  if (!/^[0-9a-f]{4,39}$/u.test(prefix)) return undefined;
  const matches = new Set<string>();
  const looseDirectory = joinPath({
    base: repository.commonDirPath,
    child: `objects/${prefix.slice(0, 2)}`,
  });
  if (await pathExists({ files, path: looseDirectory })) {
    const suffixPrefix = prefix.slice(2);
    for await (const entry of files.readDir({ path: looseDirectory })) {
      if (entry.type !== 'file' || !/^[0-9a-f]{38}$/u.test(entry.name)) continue;
      if (entry.name.startsWith(suffixPrefix)) matches.add(`${prefix.slice(0, 2)}${entry.name}`);
      if (matches.size > 1) break;
    }
  }

  if (matches.size <= 1) {
    const packDirectory = joinPath({ base: repository.commonDirPath, child: 'objects/pack' });
    if (await pathExists({ files, path: packDirectory })) {
      for await (const entry of files.readDir({ path: packDirectory })) {
        if (entry.type !== 'file' || !entry.name.endsWith('.idx')) continue;
        const packIndex = await readPackIndex({ files, repository, indexFileName: entry.name });
        for (const objectId of findPackIndexObjectIdsByPrefix({ packIndex, prefix, limit: 2 })) {
          matches.add(objectId);
          if (matches.size > 1) break;
        }
        if (matches.size > 1) break;
      }
    }
  }

  if (matches.size > 1) throw new Error(`short object ID ${prefix} is ambiguous`);
  return matches.values().next().value as string | undefined;
}

async function resolveBaseRevision({ files, repository, base, objectReadCache }: {
  files: GitFiles,
  repository: GitRepository,
  base: string,
  objectReadCache?: GitObjectReadCache,
}): Promise<string> {
  if (base === 'HEAD') {
    const head = await readHead({ files, repository });
    if (head.objectId === undefined) throw ambiguousRevisionError({ expression: base });
    return head.objectId;
  }

  if (/^[0-9a-f]{40}$/u.test(base)) {
    await readObject({ files, repository, objectId: base, cache: objectReadCache });
    return base;
  }

  const candidates = base.startsWith('refs/')
    ? [base]
    : [
      `refs/heads/${base}`,
      `refs/tags/${base}`,
      `refs/remotes/${base}`,
      `refs/remotes/${base}/HEAD`,
    ];
  for (const refName of candidates) {
    const objectId = await readRef({ files, repository, refName });
    if (objectId !== undefined) return objectId;
  }

  const abbreviated = await resolveAbbreviatedObjectId({ files, repository, prefix: base });
  if (abbreviated !== undefined) return abbreviated;

  throw ambiguousRevisionError({ expression: base });
}

export async function resolveRevision({ files, repository, expression, objectReadCache }: {
  files: GitFiles,
  repository: GitRepository,
  expression: string,
  objectReadCache?: GitObjectReadCache,
}): Promise<string> {
  const parsed = parseRevisionExpression({ expression });
  let objectId = await resolveBaseRevision({ files, repository, base: parsed.base, objectReadCache });

  for (const suffix of parsed.suffixes) {
    switch (suffix.type) {
    case 'parent': {
      objectId = await peelToCommitObjectId({ files, repository, objectId, objectReadCache });
      if (suffix.count === 0) break;
      const commit = await readCommit({ files, repository, objectId, objectReadCache });
      const parent = commit.parentObjectIds[suffix.count - 1];
      if (parent === undefined) throw ambiguousRevisionError({ expression });
      objectId = parent;
      break;
    }
    case 'first-parent-ancestor':
      objectId = await peelToCommitObjectId({ files, repository, objectId, objectReadCache });
      for (let count = 0; count < suffix.count; count += 1) {
        const commit = await readCommit({ files, repository, objectId, objectReadCache });
        const parent = commit.parentObjectIds[0];
        if (parent === undefined) throw ambiguousRevisionError({ expression });
        objectId = parent;
      }
      break;
    case 'peel':
      switch (suffix.expected) {
      case 'commit':
        objectId = await peelToCommitObjectId({ files, repository, objectId, objectReadCache });
        break;
      case 'any':
        objectId = await peelTagObjectId({ files, repository, objectId, objectReadCache });
        break;
      default: {
        const _ex: never = suffix.expected;
        throw new Error(`Unhandled revision peel type: ${_ex}`);
      }
      }
      break;
    default: {
      const _ex: never = suffix;
      throw new Error(`Unhandled revision suffix: ${String(_ex)}`);
    }
    }
  }
  return objectId;
}

export async function resolveCommitRevision({ files, repository, expression, objectReadCache }: {
  files: GitFiles,
  repository: GitRepository,
  expression: string,
  objectReadCache?: GitObjectReadCache,
}): Promise<string> {
  const objectId = await resolveRevision({ files, repository, expression, objectReadCache });
  return peelToCommitObjectId({ files, repository, objectId, objectReadCache });
}

export async function resolveRevisionPath({ files, repository, expression }: {
  files: GitFiles,
  repository: GitRepository,
  expression: string,
}): Promise<{ objectId: string, mode: number }> {
  const colonIndex = expression.indexOf(':');
  if (colonIndex <= 0) throw new Error(`invalid object name '${expression}'`);
  const revisionExpression = expression.slice(0, colonIndex);
  const path = expression.slice(colonIndex + 1).replace(/^\/+/, '');
  if (path.length === 0) throw new Error(`invalid object name '${expression}'`);
  const objectReadCache = createGitObjectReadCache();
  const commitObjectId = await resolveCommitRevision({
    files,
    repository,
    expression: revisionExpression,
    objectReadCache,
  });
  const commit = await readCommit({ files, repository, objectId: commitObjectId, objectReadCache });
  const entry = await readTreePath({
    files,
    repository,
    treeObjectId: commit.treeObjectId,
    path,
    objectReadCache,
  });
  if (entry === undefined) throw new Error(`path '${path}' does not exist in '${revisionExpression}'`);
  return { objectId: entry.objectId, mode: entry.mode };
}

export const TEST_ONLY = {
  parseRevisionExpression,
};
