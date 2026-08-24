import type { GitFiles } from './files';
import { readCommit } from './commits';
import { readObject } from './objects';
import { readHead, readRef } from './refs';
import type { GitRepository } from './repository';
import { readTreeRecursively } from './tree';

type RevisionSuffix =
  | { type: 'parent' | 'first-parent-ancestor', count: number }
  | { type: 'peel', expected: 'any' | 'commit' };

function ambiguousRevisionError({ expression }: { expression: string }): Error {
  return new Error(`ambiguous argument '${expression}': unknown revision or path not in the working tree.`);
}


export async function peelTagObjectId({ files, repository, objectId, depth = 0 }: {
  files: GitFiles,
  repository: GitRepository,
  objectId: string,
  depth?: number,
}): Promise<string> {
  if (depth > 16) throw new Error(`tag chain is too deep at ${objectId}`);
  const object = await readObject({ files, repository, objectId });
  switch (object.type) {
  case 'blob':
  case 'commit':
  case 'tree':
    return objectId;
  case 'tag': {
    const text = new TextDecoder().decode(object.body);
    const match = /^object ([0-9a-f]{40})$/mu.exec(text);
    if (match === null) throw new Error(`corrupt tag ${objectId}: object header is missing`);
    return peelTagObjectId({ files, repository, objectId: match[1]!, depth: depth + 1 });
  }
  default: {
    const _ex: never = object.type;
    throw new Error(`Unhandled revision object type: ${_ex}`);
  }
  }
}

export async function peelToCommitObjectId({ files, repository, objectId }: {
  files: GitFiles,
  repository: GitRepository,
  objectId: string,
}): Promise<string> {
  const peeledObjectId = await peelTagObjectId({ files, repository, objectId });
  const object = await readObject({ files, repository, objectId: peeledObjectId });
  switch (object.type) {
  case 'commit':
    return peeledObjectId;
  case 'blob':
  case 'tree':
    throw new Error(`object ${peeledObjectId} is not a commit`);
  case 'tag':
    throw new Error(`tag ${peeledObjectId} did not peel to a non-tag object`);
  default: {
    const _ex: never = object.type;
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

async function resolveBaseRevision({ files, repository, base }: {
  files: GitFiles,
  repository: GitRepository,
  base: string,
}): Promise<string> {
  if (base === 'HEAD') {
    const head = await readHead({ files, repository });
    if (head.objectId === undefined) throw ambiguousRevisionError({ expression: base });
    return head.objectId;
  }

  if (/^[0-9a-f]{40}$/u.test(base)) {
    await readObject({ files, repository, objectId: base });
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

  throw ambiguousRevisionError({ expression: base });
}

export async function resolveRevision({ files, repository, expression }: {
  files: GitFiles,
  repository: GitRepository,
  expression: string,
}): Promise<string> {
  const parsed = parseRevisionExpression({ expression });
  let objectId = await resolveBaseRevision({ files, repository, base: parsed.base });

  for (const suffix of parsed.suffixes) {
    switch (suffix.type) {
    case 'parent': {
      objectId = await peelToCommitObjectId({ files, repository, objectId });
      if (suffix.count === 0) break;
      const commit = await readCommit({ files, repository, objectId });
      const parent = commit.parentObjectIds[suffix.count - 1];
      if (parent === undefined) throw ambiguousRevisionError({ expression });
      objectId = parent;
      break;
    }
    case 'first-parent-ancestor':
      objectId = await peelToCommitObjectId({ files, repository, objectId });
      for (let count = 0; count < suffix.count; count += 1) {
        const commit = await readCommit({ files, repository, objectId });
        const parent = commit.parentObjectIds[0];
        if (parent === undefined) throw ambiguousRevisionError({ expression });
        objectId = parent;
      }
      break;
    case 'peel':
      switch (suffix.expected) {
      case 'commit':
        objectId = await peelToCommitObjectId({ files, repository, objectId });
        break;
      case 'any':
        objectId = await peelTagObjectId({ files, repository, objectId });
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

export async function resolveCommitRevision({ files, repository, expression }: {
  files: GitFiles,
  repository: GitRepository,
  expression: string,
}): Promise<string> {
  const objectId = await resolveRevision({ files, repository, expression });
  return peelToCommitObjectId({ files, repository, objectId });
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
  const commitObjectId = await resolveCommitRevision({ files, repository, expression: revisionExpression });
  const commit = await readCommit({ files, repository, objectId: commitObjectId });
  const entries = await readTreeRecursively({ files, repository, treeObjectId: commit.treeObjectId });
  const entry = entries.find(candidate => candidate.path === path);
  if (entry === undefined) throw new Error(`path '${path}' does not exist in '${revisionExpression}'`);
  return { objectId: entry.objectId, mode: entry.mode };
}

export const TEST_ONLY = {
  parseRevisionExpression,
};
