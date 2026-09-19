import type { GitFiles } from './files';
import { pathExists, readFileText, replaceTextViaLock } from './files';
import type { GitIdentity } from './identity';
import { readPackedRefs, removePackedRef } from './packed-refs';
import { appendReflog } from './reflog';
import type { GitRepository } from './repository';
import { sortByGitUtf8StringKey } from './utf8-order';
import { joinPath } from './repository';

export interface GitHeadState {
  symbolicRef: string | undefined,
  objectId: string | undefined,
}


export type GitHeadTarget =
  | { type: 'symbolic', refName: string, objectId: string }
  | { type: 'detached', objectId: string };

export interface GitReflogUpdate {
  identity: GitIdentity,
  timestamp: string,
  message: string,
}

export function assertRefName({ refName }: { refName: string }): void {
  const components = refName.split('/');
  const hasForbiddenCharacter = [...refName].some(character => {
    const codePoint = character.codePointAt(0)!;
    return codePoint <= 0x20
      || codePoint === 0x7f
      || character === '~'
      || character === '^'
      || character === ':'
      || character === '?'
      || character === '*'
      || character === '['
      || character === '\\';
  });
  if (!refName.startsWith('refs/')
    || components.some(component => component.length === 0 || component.startsWith('.') || component.endsWith('.lock'))
    || refName.includes('..')
    || refName.includes('@{')
    || refName.endsWith('.')
    || hasForbiddenCharacter) {
    throw new Error(`invalid ref name: ${refName}`);
  }
}

async function readRefRecursive({ files, repository, refName, visitedRefNames }: {
  files: GitFiles,
  repository: GitRepository,
  refName: string,
  visitedRefNames: ReadonlySet<string>,
}): Promise<string | undefined> {
  assertRefName({ refName });
  if (visitedRefNames.has(refName)) throw new Error(`symbolic ref cycle at ${refName}`);
  const nextVisitedRefNames = new Set(visitedRefNames);
  nextVisitedRefNames.add(refName);
  const path = joinPath({ base: repository.commonDirPath, child: refName });
  if (await pathExists({ files, path })) {
    const stat = await files.lstat({ path });
    switch (stat.type) {
    case 'directory':
      break;
    case 'file': {
      const value = (await readFileText({ files, path })).trim();
      if (/^[0-9a-f]{40}$/u.test(value)) return value;
      if (value.startsWith('ref: ')) {
        const targetRefName = value.slice(5);
        assertRefName({ refName: targetRefName });
        return readRefRecursive({ files, repository, refName: targetRefName, visitedRefNames: nextVisitedRefNames });
      }
      throw new Error(`invalid ref value in ${refName}`);
    }
    case 'fifo':
    case 'chardev':
    case 'symlink':
      throw new Error(`invalid ref entry type ${stat.type}: ${refName}`);
    default: {
      const _ex: never = stat.type;
      throw new Error(`Unhandled ref entry type: ${_ex}`);
    }
    }
  }
  return (await readPackedRefs({ files, repository })).find(entry => entry.refName === refName)?.objectId;
}

export async function readRef({ files, repository, refName }: {
  files: GitFiles,
  repository: GitRepository,
  refName: string,
}): Promise<string | undefined> {
  return readRefRecursive({ files, repository, refName, visitedRefNames: new Set() });
}

export async function writeSymbolicRef({ files, repository, refName, targetRefName }: {
  files: GitFiles,
  repository: GitRepository,
  refName: string,
  targetRefName: string,
}): Promise<void> {
  assertRefName({ refName });
  assertRefName({ refName: targetRefName });
  const refPath = joinPath({ base: repository.commonDirPath, child: refName });
  const slashIndex = refPath.lastIndexOf('/');
  const parent = slashIndex <= 0 ? '/' : refPath.slice(0, slashIndex);
  if (!await pathExists({ files, path: parent })) await files.mkdir({ path: parent, recursive: true });
  await replaceTextViaLock({ files, path: refPath, text: `ref: ${targetRefName}\n` });
}

export async function writeRef({ files, repository, refName, objectId }: {
  files: GitFiles,
  repository: GitRepository,
  refName: string,
  objectId: string,
}): Promise<void> {
  assertRefName({ refName });
  if (!/^[0-9a-f]{40}$/u.test(objectId)) throw new Error(`invalid object id: ${objectId}`);
  const refPath = joinPath({ base: repository.commonDirPath, child: refName });
  const slashIndex = refPath.lastIndexOf('/');
  const parent = slashIndex <= 0 ? '/' : refPath.slice(0, slashIndex);
  if (!await pathExists({ files, path: parent })) await files.mkdir({ path: parent, recursive: true });
  await replaceTextViaLock({ files, path: refPath, text: `${objectId}\n` });
}

async function rollbackRefAfterReflogFailure({ files, repository, refName, oldObjectId }: {
  files: GitFiles,
  repository: GitRepository,
  refName: string,
  oldObjectId: string | undefined,
}): Promise<void> {
  const refPath = joinPath({ base: repository.commonDirPath, child: refName });
  if (oldObjectId === undefined) {
    if (await pathExists({ files, path: refPath })) await files.unlink({ path: refPath });
    return;
  }
  await writeRef({ files, repository, refName, objectId: oldObjectId });
}

interface OptionalTextFileState {
  path: string,
  text: string | undefined,
}

async function captureOptionalTextFile({ files, path }: {
  files: GitFiles,
  path: string,
}): Promise<OptionalTextFileState> {
  return { path, text: await pathExists({ files, path }) ? await readFileText({ files, path }) : undefined };
}

async function restoreOptionalTextFile({ files, state }: {
  files: GitFiles,
  state: OptionalTextFileState,
}): Promise<void> {
  if (state.text === undefined) {
    if (await pathExists({ files, path: state.path })) await files.unlink({ path: state.path });
    return;
  }
  await replaceTextViaLock({ files, path: state.path, text: state.text });
}

function errorMessage({ error }: { error: unknown }): string {
  return error instanceof Error ? error.message : String(error);
}

async function rollbackRefOrThrow({ files, repository, refName, oldObjectId, originalError }: {
  files: GitFiles,
  repository: GitRepository,
  refName: string,
  oldObjectId: string | undefined,
  originalError: unknown,
}): Promise<never> {
  try {
    await rollbackRefAfterReflogFailure({ files, repository, refName, oldObjectId });
  } catch (rollbackError) {
    const originalMessage = errorMessage({ error: originalError });
    const rollbackMessage = errorMessage({ error: rollbackError });
    throw new Error(`${originalMessage}; ref rollback also failed: ${rollbackMessage}`);
  }
  throw originalError;
}

export async function createRef({ files, repository, refName, objectId, reflog }: {
  files: GitFiles,
  repository: GitRepository,
  refName: string,
  objectId: string,
  reflog?: GitReflogUpdate,
}): Promise<void> {
  if (await readRef({ files, repository, refName }) !== undefined) {
    throw new Error(`reference already exists: ${refName}`);
  }
  await writeRef({ files, repository, refName, objectId });
  if (reflog !== undefined) {
    try {
      await appendReflog({
        files,
        path: joinPath({ base: repository.commonDirPath, child: `logs/${refName}` }),
        oldObjectId: undefined,
        newObjectId: objectId,
        identity: reflog.identity,
        timestamp: reflog.timestamp,
        message: reflog.message,
      });
    } catch (error) {
      await rollbackRefOrThrow({ files, repository, refName, oldObjectId: undefined, originalError: error });
    }
  }
}

export async function updateRef({ files, repository, refName, objectId, reflog }: {
  files: GitFiles,
  repository: GitRepository,
  refName: string,
  objectId: string,
  reflog: GitReflogUpdate | undefined,
}): Promise<void> {
  const oldObjectId = await readRef({ files, repository, refName });
  await writeRef({ files, repository, refName, objectId });
  if (reflog !== undefined) {
    try {
      await appendReflog({
        files,
        path: joinPath({ base: repository.commonDirPath, child: `logs/${refName}` }),
        oldObjectId,
        newObjectId: objectId,
        identity: reflog.identity,
        timestamp: reflog.timestamp,
        message: reflog.message,
      });
    } catch (error) {
      await rollbackRefOrThrow({ files, repository, refName, oldObjectId, originalError: error });
    }
  }
}

export async function deleteRef({ files, repository, refName }: {
  files: GitFiles,
  repository: GitRepository,
  refName: string,
}): Promise<boolean> {
  assertRefName({ refName });
  const refPath = joinPath({ base: repository.commonDirPath, child: refName });
  const looseState = await captureOptionalTextFile({ files, path: refPath });
  let removed = false;
  if (looseState.text !== undefined) {
    await files.unlink({ path: refPath });
    removed = true;
  }
  try {
    if (await removePackedRef({ files, repository, refName })) removed = true;
  } catch (error) {
    if (looseState.text !== undefined) {
      try {
        await restoreOptionalTextFile({ files, state: looseState });
      } catch (rollbackError) {
        throw new Error(`${errorMessage({ error })}; loose ref rollback also failed: ${errorMessage({ error: rollbackError })}`);
      }
    }
    throw error;
  }
  return removed;
}


export async function renameRef({ files, repository, oldRefName, newRefName, reflog }: {
  files: GitFiles,
  repository: GitRepository,
  oldRefName: string,
  newRefName: string,
  reflog: GitReflogUpdate | undefined,
}): Promise<boolean> {
  assertRefName({ refName: oldRefName });
  assertRefName({ refName: newRefName });
  if (oldRefName === newRefName) return true;
  if (await readRef({ files, repository, refName: newRefName }) !== undefined) {
    throw new Error(`reference already exists: ${newRefName}`);
  }
  const objectId = await readRef({ files, repository, refName: oldRefName });
  if (objectId === undefined) return false;

  const oldLogPath = joinPath({ base: repository.commonDirPath, child: `logs/${oldRefName}` });
  const newLogPath = joinPath({ base: repository.commonDirPath, child: `logs/${newRefName}` });
  const oldLogState = await captureOptionalTextFile({ files, path: oldLogPath });
  const newLogState = await captureOptionalTextFile({ files, path: newLogPath });

  try {
    await writeRef({ files, repository, refName: newRefName, objectId });
    await deleteRef({ files, repository, refName: oldRefName });

    if (oldLogState.text !== undefined) {
      const slashIndex = newLogPath.lastIndexOf('/');
      const parent = slashIndex <= 0 ? '/' : newLogPath.slice(0, slashIndex);
      if (!await pathExists({ files, path: parent })) await files.mkdir({ path: parent, recursive: true });
      await replaceTextViaLock({ files, path: newLogPath, text: oldLogState.text });
      if (await pathExists({ files, path: oldLogPath })) await files.unlink({ path: oldLogPath });
    }
    if (reflog !== undefined) {
      await appendReflog({
        files,
        path: newLogPath,
        oldObjectId: objectId,
        newObjectId: objectId,
        identity: reflog.identity,
        timestamp: reflog.timestamp,
        message: reflog.message,
      });
    }
    return true;
  } catch (error) {
    const rollbackErrors: string[] = [];
    try {
      await writeRef({ files, repository, refName: oldRefName, objectId });
    } catch (rollbackError) {
      rollbackErrors.push(`${oldRefName}: ${errorMessage({ error: rollbackError })}`);
    }
    try {
      await rollbackRefAfterReflogFailure({ files, repository, refName: newRefName, oldObjectId: undefined });
    } catch (rollbackError) {
      rollbackErrors.push(`${newRefName}: ${errorMessage({ error: rollbackError })}`);
    }
    for (const state of [oldLogState, newLogState]) {
      try {
        await restoreOptionalTextFile({ files, state });
      } catch (rollbackError) {
        rollbackErrors.push(`${state.path}: ${errorMessage({ error: rollbackError })}`);
      }
    }
    if (rollbackErrors.length > 0) {
      throw new Error(`${errorMessage({ error })}; ref rename rollback also failed: ${rollbackErrors.join('; ')}`);
    }
    throw error;
  }
}

export interface GitListedRef {
  refName: string,
  objectId: string,
  symbolicTargetRefName: string | undefined,
}

export async function listRefs({ files, repository, prefix }: {
  files: GitFiles,
  repository: GitRepository,
  prefix: string,
}): Promise<GitListedRef[]> {
  if (prefix !== 'refs') assertRefName({ refName: prefix });
  const byName = new Map<string, GitListedRef>();
  for (const entry of await readPackedRefs({ files, repository })) {
    if (entry.refName.startsWith(`${prefix}/`)) {
      byName.set(entry.refName, {
        refName: entry.refName,
        objectId: entry.objectId,
        symbolicTargetRefName: undefined,
      });
    }
  }

  const basePath = joinPath({ base: repository.commonDirPath, child: prefix });
  if (await pathExists({ files, path: basePath })) {
    const visit = async ({ directoryPath, refPrefix }: {
      directoryPath: string,
      refPrefix: string,
    }): Promise<void> => {
      for await (const entry of files.readDir({ path: directoryPath })) {
        const refName = `${refPrefix}/${entry.name}`;
        switch (entry.type) {
        case 'directory':
          await visit({ directoryPath: entry.fullPath, refPrefix: refName });
          break;
        case 'file': {
          if (entry.name.endsWith('.lock')) break;
          const value = (await readFileText({ files, path: entry.fullPath })).trim();
          if (/^[0-9a-f]{40}$/u.test(value)) {
            byName.set(refName, { refName, objectId: value, symbolicTargetRefName: undefined });
            break;
          }
          if (value.startsWith('ref: ')) {
            const symbolicTargetRefName = value.slice(5);
            assertRefName({ refName: symbolicTargetRefName });
            const objectId = await readRef({ files, repository, refName: symbolicTargetRefName });
            if (objectId === undefined) throw new Error(`dangling symbolic ref ${refName}: ${symbolicTargetRefName}`);
            byName.set(refName, { refName, objectId, symbolicTargetRefName });
            break;
          }
          throw new Error(`invalid ref value in ${refName}`);
        }
        case 'fifo':
        case 'chardev':
        case 'symlink':
          throw new Error(`unsupported ref entry type ${entry.type}: ${refName}`);
        default: {
          const _ex: never = entry.type;
          throw new Error(`Unhandled ref entry type: ${_ex}`);
        }
        }
      }
    };
    await visit({ directoryPath: basePath, refPrefix: prefix });
  }

  return sortByGitUtf8StringKey({ values: byName.values(), key: ({ value }) => value.refName });
}

export async function readHead({ files, repository }: {
  files: GitFiles,
  repository: GitRepository,
}): Promise<GitHeadState> {
  const headText = (await readFileText({
    files,
    path: joinPath({ base: repository.gitDirPath, child: 'HEAD' }),
  })).trim();
  if (headText.startsWith('ref: ')) {
    const symbolicRef = headText.slice(5);
    return {
      symbolicRef,
      objectId: await readRef({ files, repository, refName: symbolicRef }),
    };
  }
  if (/^[0-9a-f]{40}$/u.test(headText)) return { symbolicRef: undefined, objectId: headText };
  throw new Error('invalid HEAD');
}

export async function setHeadSymbolic({ files, repository, refName }: {
  files: GitFiles,
  repository: GitRepository,
  refName: string,
}): Promise<void> {
  assertRefName({ refName });
  await replaceTextViaLock({
    files,
    path: joinPath({ base: repository.gitDirPath, child: 'HEAD' }),
    text: `ref: ${refName}\n`,
  });
}

async function appendHeadReflogs({ files, repository, head, newObjectId, update }: {
  files: GitFiles,
  repository: GitRepository,
  head: GitHeadState,
  newObjectId: string,
  update: GitReflogUpdate,
}): Promise<void> {
  const branchLogPath = head.symbolicRef === undefined
    ? undefined
    : joinPath({ base: repository.commonDirPath, child: `logs/${head.symbolicRef}` });
  const headLogPath = joinPath({ base: repository.gitDirPath, child: 'logs/HEAD' });
  const previousLogs = [
    ...(branchLogPath === undefined ? [] : [await captureOptionalTextFile({ files, path: branchLogPath })]),
    await captureOptionalTextFile({ files, path: headLogPath }),
  ];
  try {
    if (branchLogPath !== undefined) {
      await appendReflog({
        files,
        path: branchLogPath,
        oldObjectId: head.objectId,
        newObjectId,
        identity: update.identity,
        timestamp: update.timestamp,
        message: update.message,
      });
    }
    await appendReflog({
      files,
      path: headLogPath,
      oldObjectId: head.objectId,
      newObjectId,
      identity: update.identity,
      timestamp: update.timestamp,
      message: update.message,
    });
  } catch (error) {
    const rollbackErrors: string[] = [];
    for (const state of [...previousLogs].reverse()) {
      try {
        await restoreOptionalTextFile({ files, state });
      } catch (rollbackError) {
        rollbackErrors.push(`${state.path}: ${errorMessage({ error: rollbackError })}`);
      }
    }
    if (rollbackErrors.length > 0) {
      throw new Error(`${errorMessage({ error })}; reflog rollback also failed: ${rollbackErrors.join('; ')}`);
    }
    throw error;
  }
}

export async function moveHeadReference({ files, repository, target, reflog }: {
  files: GitFiles,
  repository: GitRepository,
  target: GitHeadTarget,
  reflog: GitReflogUpdate,
}): Promise<void> {
  const oldHead = await readHead({ files, repository });
  const headPath = joinPath({ base: repository.gitDirPath, child: 'HEAD' });
  const headLogState = await captureOptionalTextFile({
    files,
    path: joinPath({ base: repository.gitDirPath, child: 'logs/HEAD' }),
  });
  switch (target.type) {
  case 'symbolic':
    assertRefName({ refName: target.refName });
    await replaceTextViaLock({ files, path: headPath, text: `ref: ${target.refName}\n` });
    break;
  case 'detached':
    if (!/^[0-9a-f]{40}$/u.test(target.objectId)) throw new Error(`invalid object id: ${target.objectId}`);
    await replaceTextViaLock({ files, path: headPath, text: `${target.objectId}\n` });
    break;
  default: {
    const _ex: never = target;
    throw new Error(`Unhandled HEAD target: ${String(_ex)}`);
  }
  }
  try {
    await appendReflog({
      files,
      path: headLogState.path,
      oldObjectId: oldHead.objectId,
      newObjectId: target.objectId,
      identity: reflog.identity,
      timestamp: reflog.timestamp,
      message: reflog.message,
    });
  } catch (error) {
    const rollbackErrors: string[] = [];
    try {
      await restoreOptionalTextFile({ files, state: headLogState });
    } catch (rollbackError) {
      rollbackErrors.push(`${headLogState.path}: ${errorMessage({ error: rollbackError })}`);
    }
    try {
      if (oldHead.symbolicRef !== undefined) {
        await replaceTextViaLock({ files, path: headPath, text: `ref: ${oldHead.symbolicRef}\n` });
      } else if (oldHead.objectId !== undefined) {
        await replaceTextViaLock({ files, path: headPath, text: `${oldHead.objectId}\n` });
      } else {
        rollbackErrors.push(`${headPath}: previous HEAD target is unavailable`);
      }
    } catch (rollbackError) {
      rollbackErrors.push(`${headPath}: ${errorMessage({ error: rollbackError })}`);
    }
    if (rollbackErrors.length > 0) {
      throw new Error(`${errorMessage({ error })}; HEAD rollback also failed: ${rollbackErrors.join('; ')}`);
    }
    throw error;
  }
}

export async function updateHead({ files, repository, objectId, reflog }: {
  files: GitFiles,
  repository: GitRepository,
  objectId: string,
  reflog?: GitReflogUpdate,
}): Promise<void> {
  if (!/^[0-9a-f]{40}$/u.test(objectId)) throw new Error(`invalid object id: ${objectId}`);
  const head = await readHead({ files, repository });
  const headPath = joinPath({ base: repository.gitDirPath, child: 'HEAD' });
  if (head.symbolicRef !== undefined) {
    await writeRef({ files, repository, refName: head.symbolicRef, objectId });
  } else {
    await replaceTextViaLock({ files, path: headPath, text: `${objectId}\n` });
  }
  if (reflog !== undefined) {
    try {
      await appendHeadReflogs({ files, repository, head, newObjectId: objectId, update: reflog });
    } catch (error) {
      const rollbackErrors: string[] = [];
      try {
        if (head.symbolicRef !== undefined) {
          await rollbackRefAfterReflogFailure({
            files,
            repository,
            refName: head.symbolicRef,
            oldObjectId: head.objectId,
          });
        } else if (head.objectId !== undefined) {
          await replaceTextViaLock({ files, path: headPath, text: `${head.objectId}\n` });
        } else {
          rollbackErrors.push(`${headPath}: previous HEAD object id is unavailable`);
        }
      } catch (rollbackError) {
        rollbackErrors.push(errorMessage({ error: rollbackError }));
      }
      if (rollbackErrors.length > 0) {
        throw new Error(`${errorMessage({ error })}; HEAD target rollback also failed: ${rollbackErrors.join('; ')}`);
      }
      throw error;
    }
  }
}

export async function writeOrigHead({ files, repository, objectId }: {
  files: GitFiles,
  repository: GitRepository,
  objectId: string,
}): Promise<void> {
  if (!/^[0-9a-f]{40}$/u.test(objectId)) throw new Error(`invalid object id: ${objectId}`);
  await replaceTextViaLock({
    files,
    path: joinPath({ base: repository.gitDirPath, child: 'ORIG_HEAD' }),
    text: `${objectId}\n`,
  });
}

export function branchNameFromHead({ head }: { head: GitHeadState }): string | undefined {
  if (head.symbolicRef === undefined) return undefined;
  const prefix = 'refs/heads/';
  return head.symbolicRef.startsWith(prefix) ? head.symbolicRef.slice(prefix.length) : undefined;
}

export const TEST_ONLY = {
};
