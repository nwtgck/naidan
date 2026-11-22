import type { WeshEntryChange, WeshEntryRef, WeshPreparedRename } from '@/features/wesh/types';
import { branchRefName } from './branch';
import { concatBytes } from './bytes';
import type { GitConfig } from './config';
import { shouldCreateBranchReflog, withRenamedLocalConfigSection } from './config';
import type { GitFileLock, GitFilePublisher, GitFiles } from './files';
import { pathExists, readFileBytes, readFileText, replaceFileViaLock, replaceTextViaLock, resolveOptionalEntry, withFileLock, withFileLocks } from './files';
import type { GitIdentity } from './identity';
import { resolveGitReflogIdentity, resolveGitTimestamp } from './identity';
import { readPackedRefs, withPackedRefRemoval } from './packed-refs';
import { appendReflog, formatReflogLine, resolveReflogEntry, ZERO_OBJECT_ID } from './reflog';
import type { GitRepository } from './repository';
import { sortByGitUtf8StringKey } from './utf8-order';
import { joinPath } from './repository';

const textEncoder = new TextEncoder();

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
  if (visitedRefNames.has(refName)) {
    throw new Error(`symbolic ref cycle at ${refName}`);
  }
  const nextVisitedRefNames = new Set(visitedRefNames);
  nextVisitedRefNames.add(refName);
  const path = joinPath({ base: repository.commonDirPath, child: refName });
  const entry = await resolveOptionalEntry({ files, path });
  return readRefEntry({ files, repository, refName, entry, visitedRefNames: nextVisitedRefNames, symbolic: 'follow' });
}

async function readRefEntry({ files, repository, refName, entry, visitedRefNames, symbolic }: {
  files: GitFiles,
  repository: GitRepository,
  refName: string,
  entry: WeshEntryRef | undefined,
  visitedRefNames: ReadonlySet<string>,
  symbolic: 'follow' | 'reject',
}): Promise<string | undefined> {
  switch (entry?.type) {
  case undefined:
  case 'directory':
    return (await readPackedRefs({ files, repository })).find(packedEntry => packedEntry.refName === refName)?.objectId;
  case 'file': {
    const value = (await readFileText({ files, entry })).trim();
    if (/^[0-9a-f]{40}$/u.test(value)) {
      return value;
    }
    if (value.startsWith('ref: ')) {
      switch (symbolic) {
      case 'reject':
        throw new Error(`Cannot update through nested symbolic ref ${refName}`);
      case 'follow':
        return readRefRecursive({ files, repository, refName: value.slice(5), visitedRefNames });
      default: {
        const _ex: never = symbolic;
        throw new Error(`Unhandled symbolic reference rule: ${_ex}`);
      }
      }
    }
    throw new Error(`invalid ref value in ${refName}`);
  }
  case 'fifo':
  case 'chardev':
  case 'symlink':
    throw new Error(`invalid ref entry type ${entry.type}: ${refName}`);
  default: {
    const _ex: never = entry;
    throw new Error(`Unhandled ref entry: ${String(_ex)}`);
  }
  }
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
  await writeLooseRef({ files, repository, refName, text: `ref: ${targetRefName}\n`, prepare: undefined });
}

async function ensureRefParent({ files, path }: { files: GitFiles, path: string }): Promise<void> {
  const slashIndex = path.lastIndexOf('/');
  const parent = slashIndex <= 0 ? '/' : path.slice(0, slashIndex);
  if (!await pathExists({ files, path: parent })) {
    await files.mkdir({ path: parent, recursive: true });
  }
}

async function writeLooseRef({ files, repository, refName, text, prepare }: {
  files: GitFiles,
  repository: GitRepository,
  refName: string,
  text: string,
  prepare: (({ entry }: { entry: WeshEntryRef | undefined }) => Promise<GitFilePublisher | undefined>) | undefined,
}): Promise<void> {
  const refPath = joinPath({ base: repository.commonDirPath, child: refName });
  await ensureRefParent({ files, path: refPath });
  await replaceFileViaLock({
    files,
    path: refPath,
    prepareBytes: async () => {
      const entry = await resolveOptionalEntry({ files, path: refPath });
      if (entry !== undefined && entry.type !== 'file') {
        throw new Error(`invalid ref entry type ${entry.type}: ${refName}`);
      }
      return { bytes: textEncoder.encode(text), expectedDestination: { entry }, publish: await prepare?.({ entry }) };
    },
  });
}

export async function writeRef({ files, repository, refName, objectId }: {
  files: GitFiles,
  repository: GitRepository,
  refName: string,
  objectId: string,
}): Promise<void> {
  await publishRef({ files, repository, refName, objectId, create: false, prepare: undefined });
}

async function publishRef({ files, repository, refName, objectId, create, prepare }: {
  files: GitFiles,
  repository: GitRepository,
  refName: string,
  objectId: string,
  create: boolean,
  prepare: (({ oldObjectId }: { oldObjectId: string | undefined }) => GitFilePublisher | undefined) | undefined,
}): Promise<void> {
  assertRefName({ refName });
  if (!/^[0-9a-f]{40}$/u.test(objectId)) {
    throw new Error(`invalid object id: ${objectId}`);
  }
  await writeLooseRef({
    files,
    repository,
    refName,
    text: `${objectId}\n`,
    prepare: create || prepare !== undefined ? async ({ entry }) => {
      if (create && entry !== undefined) {
        throw new Error(`reference already exists: ${refName}`);
      }
      const oldObjectId = await readRefEntry({
        files,
        repository,
        refName,
        entry,
        visitedRefNames: new Set([refName]),
        symbolic: 'reject',
      });
      if (create && oldObjectId !== undefined) {
        throw new Error(`reference already exists: ${refName}`);
      }
      return prepare?.({ oldObjectId });
    } : undefined,
  });
}

async function writeRefAndReflog({ files, repository, refName, objectId, reflog, create }: {
  files: GitFiles,
  repository: GitRepository,
  refName: string,
  objectId: string,
  reflog: GitReflogUpdate | undefined,
  create: boolean,
}): Promise<void> {
  await publishRef({
    files,
    repository,
    refName,
    objectId,
    create,
    prepare: ({ oldObjectId }) => reflog === undefined ? undefined
      : ({ rename: ref }) => appendReflog({
        files,
        path: joinPath({ base: repository.commonDirPath, child: `logs/${refName}` }),
        oldObjectId,
        newObjectId: objectId,
        ...reflog,
        publish: ({ rename: log }) => files.publishEntries({ changes: [log, ref] }),
      }),
  });
}

export async function createRef({ files, repository, refName, objectId, reflog }: {
  files: GitFiles,
  repository: GitRepository,
  refName: string,
  objectId: string,
  reflog?: GitReflogUpdate,
}): Promise<void> {
  await writeRefAndReflog({ files, repository, refName, objectId, reflog, create: true });
}

export async function updateRef({ files, repository, refName, objectId, reflog }: {
  files: GitFiles,
  repository: GitRepository,
  refName: string,
  objectId: string,
  reflog: GitReflogUpdate | undefined,
}): Promise<void> {
  await writeRefAndReflog({ files, repository, refName, objectId, reflog, create: false });
}

export async function deleteRef({ files, repository, refName }: {
  files: GitFiles,
  repository: GitRepository,
  refName: string,
}): Promise<boolean> {
  assertRefName({ refName });
  const path = joinPath({ base: repository.commonDirPath, child: refName });
  await ensureRefParent({ files, path });
  return withFileLock({
    files,
    path,
    operation: async ({ verify }) => {
      const loose = await resolveOptionalEntry({ files, path });
      if (loose !== undefined && loose.type !== 'file') {
        throw new Error(`invalid ref entry type ${loose.type}: ${refName}`);
      }
      return deleteLockedRef({ files, repository, refName, loose, reflog: undefined, verify });
    },
  });
}

/** Publish removal while the caller holds the corresponding ref lock. */
export async function deleteLockedRef({ files, repository, refName, loose, reflog, verify, before }: {
  files: GitFiles,
  repository: GitRepository,
  refName: string,
  loose: WeshEntryRef | undefined,
  reflog: WeshEntryRef | undefined,
  verify: () => Promise<void>,
  before?: readonly WeshPreparedRename[],
}): Promise<boolean> {
  const removedPacked = await withPackedRefRemoval({
    files,
    repository,
    refName,
    publish: async ({ rename }) => {
      const changes: WeshEntryChange[] = before === undefined ? [] : [...before];
      if (rename !== undefined) {
        changes.push(rename);
      }
      if (loose !== undefined) {
        changes.push({ operation: 'unlink', entry: loose });
      }
      if (reflog !== undefined) {
        changes.push({ operation: 'unlink', entry: reflog });
      }
      await verify();
      await files.publishEntries({ changes });
    },
  });
  return removedPacked || loose !== undefined;
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
  if (prefix !== 'refs') {
    assertRefName({ refName: prefix });
  }
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
          if (entry.name.endsWith('.lock')) {
            break;
          }
          const value = (await readFileText({ files, path: entry.fullPath })).trim();
          if (/^[0-9a-f]{40}$/u.test(value)) {
            byName.set(refName, { refName, objectId: value, symbolicTargetRefName: undefined });
            break;
          }
          if (value.startsWith('ref: ')) {
            const symbolicTargetRefName = value.slice(5);
            assertRefName({ refName: symbolicTargetRefName });
            const objectId = await readRef({ files, repository, refName: symbolicTargetRefName });
            if (objectId === undefined) {
              throw new Error(`dangling symbolic ref ${refName}: ${symbolicTargetRefName}`);
            }
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

async function readHeadFile({ files, path }: { files: GitFiles, path: string }): Promise<{
  entry: WeshEntryRef<'file'>,
  text: string,
  head: GitHeadState,
}> {
  const entry = await resolveOptionalEntry({ files, path });
  if (entry === undefined || entry.type !== 'file') {
    throw new Error('invalid HEAD');
  }
  const text = (await readFileText({ files, entry })).trim();
  if (text.startsWith('ref: ')) {
    const symbolicRef = text.slice(5);
    assertRefName({ refName: symbolicRef });
    return { entry, text, head: { symbolicRef, objectId: undefined } };
  }
  if (/^[0-9a-f]{40}$/u.test(text)) {
    return { entry, text, head: { symbolicRef: undefined, objectId: text } };
  }
  throw new Error('invalid HEAD');
}

export async function readHead({ files, repository }: {
  files: GitFiles,
  repository: GitRepository,
}): Promise<GitHeadState> {
  const { head } = await readHeadFile({ files, path: joinPath({ base: repository.gitDirPath, child: 'HEAD' }) });
  return head.symbolicRef === undefined ? head : {
    symbolicRef: head.symbolicRef,
    objectId: await readRef({ files, repository, refName: head.symbolicRef }),
  };
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

async function withRefLocks({ files, repository, refNames, operation }: {
  files: GitFiles,
  repository: GitRepository,
  refNames: readonly string[],
  operation: ({ locks }: { locks: ReadonlyMap<string, GitFileLock> }) => Promise<void>,
}): Promise<void> {
  const paths = refNames.map(refName => {
    assertRefName({ refName });
    return joinPath({ base: repository.commonDirPath, child: refName });
  });
  for (const path of paths) {
    await ensureRefParent({ files, path });
  }
  await withFileLocks({ files, paths, operation });
}

export async function readDirectRef({ files, repository, refName }: {
  files: GitFiles,
  repository: GitRepository,
  refName: string,
}): Promise<{ entry: WeshEntryRef<'file'> | undefined, objectId: string | undefined }> {
  const path = joinPath({ base: repository.commonDirPath, child: refName });
  const entry = await resolveOptionalEntry({ files, path });
  if (entry !== undefined && entry.type !== 'file') {
    throw new Error(`invalid ref entry type ${entry.type}: ${refName}`);
  }
  const objectId = await readRefEntry({ files, repository, refName, entry, visitedRefNames: new Set([refName]), symbolic: 'reject' });
  return { entry, objectId };
}

interface GitLockedReplacement {
  lock: GitFileLock,
  entry: WeshEntryRef | undefined,
  bytes: Uint8Array,
}

async function prepareReflogRename({ files, lock, path, append, source }: {
  files: GitFiles,
  lock: GitFileLock,
  path: string,
  append: string,
  source: WeshEntryRef<'file'> | undefined,
}): Promise<GitLockedReplacement> {
  const entry = await resolveReflogEntry({ files, path });
  const from = source ?? entry;
  const newBytes = textEncoder.encode(append);
  const bytes = from === undefined ? newBytes : concatBytes({ chunks: [await readFileBytes({ files, entry: from }), newBytes] });
  return { lock, entry, bytes };
}

async function withPreparedRenames({ replacements, publish }: {
  replacements: readonly GitLockedReplacement[],
  publish: ({ renames }: { renames: readonly WeshPreparedRename[] }) => Promise<void>,
}): Promise<void> {
  const renames: WeshPreparedRename[] = [];
  async function prepare({ index }: { index: number }): Promise<void> {
    const replacement = replacements[index];
    if (replacement === undefined) {
      await publish({ renames });
      return;
    }
    const { lock, entry, bytes } = replacement;
    await lock.replace({
      replacement: {
        bytes,
        expectedDestination: { entry },
        publish: ({ rename }) => {
          renames.push(rename);
          return prepare({ index: index + 1 });
        },
      },
    });
  }
  await prepare({ index: 0 });
}

async function assertBranchIsNotCheckedOutElsewhere({ files, repository, refName, headEntry }: {
  files: GitFiles,
  repository: GitRepository,
  refName: string,
  headEntry: WeshEntryRef<'file'>,
}): Promise<void> {
  async function checkHead({ gitDir }: { gitDir: string }): Promise<void> {
    if (gitDir === repository.gitDirPath) {
      return;
    }
    const path = joinPath({ base: gitDir, child: 'HEAD' });
    const entry = await resolveOptionalEntry({ files, path });
    if (entry !== undefined && await files.compareEntryIdentity({ first: headEntry, second: entry }) !== 'same'
      && (await readHeadFile({ files, path })).head.symbolicRef === refName) {
      throw new Error(`Cannot rename '${refName}' while it is checked out in another worktree`);
    }
  }

  await checkHead({ gitDir: repository.commonDirPath });
  const path = joinPath({ base: repository.commonDirPath, child: 'worktrees' });
  if (await resolveOptionalEntry({ files, path }) !== undefined) {
    for await (const entry of files.readDir({ path })) {
      switch (entry.type) {
      case 'directory':
        await checkHead({ gitDir: entry.fullPath });
        break;
      case 'file':
      case 'symlink':
      case 'fifo':
      case 'chardev':
        break;
      default: {
        const _ex: never = entry.type;
        throw new Error(`Unhandled worktree entry type: ${_ex}`);
      }
      }
    }
  }
}

export async function renameBranch({ files, repository, oldName, newName, config, env }: {
  files: GitFiles,
  repository: GitRepository,
  oldName: string | undefined,
  newName: string,
  config: GitConfig,
  env: ReadonlyMap<string, string>,
}): Promise<void> {
  const headPath = joinPath({ base: repository.gitDirPath, child: 'HEAD' });
  await withFileLock({
    files,
    path: headPath,
    operation: async ({ replace, verify }) => {
      const headLock = { replace, verify };
      const { entry: headEntry, head } = await readHeadFile({ files, path: headPath });
      const sourceName = oldName ?? branchNameFromHead({ head });
      if (sourceName === undefined) {
        throw new Error('cannot rename the current branch while not on any branch');
      }
      const oldRefName = branchRefName({ name: sourceName });
      const newRefName = branchRefName({ name: newName });
      const renamingCurrent = head.symbolicRef === oldRefName;
      const oldRefPath = joinPath({ base: repository.commonDirPath, child: oldRefName });
      const newRefPath = joinPath({ base: repository.commonDirPath, child: newRefName });
      const refNames = [...new Set([oldRefName, newRefName])].sort();
      await withRefLocks({
        files,
        repository,
        refNames,
        operation: async ({ locks: refLocks }) => {
          const oldRef = await readDirectRef({ files, repository, refName: oldRefName });
          const objectId = oldRef.objectId;
          if (objectId === undefined && !renamingCurrent) {
            throw new Error(`branch '${sourceName}' not found`);
          }
          if (oldRefName === newRefName) {
            return;
          }
          if ((await readDirectRef({ files, repository, refName: newRefName })).objectId !== undefined) {
            throw new Error(`a branch named '${newName}' already exists`);
          }
          // A checkout in another Wesh worktree also locks this ref before changing its HEAD.
          await assertBranchIsNotCheckedOutElsewhere({ files, repository, refName: oldRefName, headEntry });

          const oldLogPath = joinPath({ base: repository.commonDirPath, child: `logs/${oldRefName}` });
          const newLogPath = joinPath({ base: repository.commonDirPath, child: `logs/${newRefName}` });
          const headLogPath = joinPath({ base: repository.gitDirPath, child: 'logs/HEAD' });
          const logPaths: string[] = [];
          if (objectId !== undefined) {
            const createLog = shouldCreateBranchReflog({ config });
            const oldLog = await resolveReflogEntry({ files, path: oldLogPath });
            if (oldLog !== undefined) {
              logPaths.push(oldLogPath);
            }
            if (oldLog !== undefined || createLog) {
              logPaths.push(newLogPath);
            }
            if (renamingCurrent && (createLog || await resolveReflogEntry({ files, path: headLogPath }) !== undefined)) {
              logPaths.push(headLogPath);
            }
          }
          for (const path of logPaths) {
            await ensureRefParent({ files, path });
          }
          await withFileLocks({
            files,
            paths: logPaths,
            operation: async ({ locks: logLocks }) => {
              const replacements: GitLockedReplacement[] = [];
              const oldLogLock = logLocks.get(oldLogPath);
              const oldLog = oldLogLock === undefined ? undefined : await resolveReflogEntry({ files, path: oldLogPath });
              const newLogLock = logLocks.get(newLogPath);
              const headLogLock = logLocks.get(headLogPath);
              if (objectId !== undefined) {
                replacements.push({ lock: refLocks.get(newRefPath)!, bytes: textEncoder.encode(`${objectId}\n`), entry: undefined });
              }
              if (objectId !== undefined && (newLogLock !== undefined || headLogLock !== undefined)) {
                const reflog = {
                  identity: resolveGitReflogIdentity({ env, config }),
                  timestamp: resolveGitTimestamp({ env, role: 'COMMITTER' }),
                  message: `Branch: renamed ${oldRefName} to ${newRefName}`,
                };
                if (newLogLock !== undefined) {
                  replacements.push(await prepareReflogRename({
                    files,
                    lock: newLogLock,
                    path: newLogPath,
                    source: oldLog,
                    append: formatReflogLine({ oldObjectId: objectId, newObjectId: objectId, ...reflog }),
                  }));
                }
                if (headLogLock !== undefined) {
                  const away = formatReflogLine({ oldObjectId: objectId, newObjectId: ZERO_OBJECT_ID, ...reflog });
                  const back = formatReflogLine({ oldObjectId: undefined, newObjectId: objectId, ...reflog });
                  replacements.push(await prepareReflogRename({ files, lock: headLogLock, path: headLogPath, source: undefined, append: away + back }));
                }
              }
              if (renamingCurrent) {
                replacements.push({ lock: headLock, bytes: textEncoder.encode(`ref: ${newRefName}\n`), entry: headEntry });
              }
              await withPreparedRenames({
                replacements,
                publish: async ({ renames }) => {
                  await withRenamedLocalConfigSection({
                    files,
                    repository,
                    section: 'branch',
                    oldSubsection: sourceName,
                    newSubsection: newName,
                    publish: async ({ rename: configChange }) => {
                      const changes = configChange === undefined ? renames : [...renames, configChange];
                      const verify = async () => {
                        if (!renamingCurrent) {
                          await headLock.verify();
                        }
                        await refLocks.get(oldRefPath)!.verify();
                        await oldLogLock?.verify();
                      };
                      // Keep the old branch until the new ref, HEAD and configuration are durable.
                      if (objectId === undefined) {
                        await verify();
                        await refLocks.get(newRefPath)!.verify();
                        await files.publishEntries({ changes });
                      } else {
                        await deleteLockedRef({
                          files,
                          repository,
                          refName: oldRefName,
                          loose: oldRef.entry,
                          reflog: oldLog,
                          before: changes,
                          verify,
                        });
                      }
                    },
                  });
                },
              });
            },
          });
        },
      });
    },
  });
}

export async function moveHeadReference({ files, repository, target, reflog }: {
  files: GitFiles,
  repository: GitRepository,
  target: GitHeadTarget,
  reflog: GitReflogUpdate,
}): Promise<void> {
  const path = joinPath({ base: repository.gitDirPath, child: 'HEAD' });
  const newRefName = (() => {
    switch (target.type) {
    case 'symbolic':
      return target.refName;
    case 'detached':
      return undefined;
    default: {
      const _ex: never = target;
      throw new Error(`Unhandled HEAD target: ${String(_ex)}`);
    }
    }
  })();
  if (newRefName !== undefined) {
    assertRefName({ refName: newRefName });
  }
  if (!/^[0-9a-f]{40}$/u.test(target.objectId)) {
    throw new Error(`invalid object id: ${target.objectId}`);
  }
  await withFileLock({
    files,
    path,
    operation: async ({ replace }) => {
      const { entry, head } = await readHeadFile({ files, path });
      const refNames = new Set<string>();
      if (head.symbolicRef !== undefined) {
        refNames.add(head.symbolicRef);
      }
      if (newRefName !== undefined) {
        refNames.add(newRefName);
      }
      await withRefLocks({
        files,
        repository,
        refNames: [...refNames].sort(),
        operation: async ({ locks }) => {
          const oldObjectId = head.symbolicRef === undefined ? head.objectId
            : (await readDirectRef({ files, repository, refName: head.symbolicRef })).objectId;
          if (newRefName !== undefined
            && (await readDirectRef({ files, repository, refName: newRefName })).objectId !== target.objectId) {
            throw new Error(`Reference changed: ${newRefName}`);
          }
          const value = newRefName === undefined ? target.objectId : `ref: ${newRefName}`;
          await replace({
            replacement: {
              bytes: textEncoder.encode(`${value}\n`),
              expectedDestination: { entry },
              publish: ({ rename: headRename }) => appendReflog({
                files,
                path: joinPath({ base: repository.gitDirPath, child: 'logs/HEAD' }),
                oldObjectId,
                newObjectId: target.objectId,
                ...reflog,
                publish: async ({ rename: log }) => {
                  for (const lock of locks.values()) {
                    await lock.verify();
                  }
                  await files.publishEntries({ changes: [log, headRename] });
                },
              }),
            },
          });
        },
      });
    },
  });
}

export async function updateHead({ files, repository, objectId, reflog, expected }: {
  files: GitFiles,
  repository: GitRepository,
  objectId: string,
  reflog?: GitReflogUpdate,
  expected?: GitHeadState,
}): Promise<void> {
  if (!/^[0-9a-f]{40}$/u.test(objectId)) {
    throw new Error(`invalid object id: ${objectId}`);
  }
  const path = joinPath({ base: repository.gitDirPath, child: 'HEAD' });
  await withFileLock({
    files,
    path,
    operation: async ({ replace, verify }) => {
      const { entry, text, head } = await readHeadFile({ files, path });
      if (expected !== undefined && expected.symbolicRef !== head.symbolicRef) {
        throw new Error('HEAD changed while preparing the update');
      }

      function checkOldObjectId({ oldObjectId }: { oldObjectId: string | undefined }): void {
        if (expected !== undefined && expected.objectId !== oldObjectId) {
          throw new Error('HEAD changed while preparing the update');
        }
      }

      async function verifyHead(): Promise<void> {
        await verify();
        const current = await readHeadFile({ files, path });
        if (current.text !== text || await files.compareEntryIdentity({ first: entry, second: current.entry }) !== 'same') {
          throw new Error('HEAD changed while preparing the update');
        }
      }

      async function appendHeadLog({ oldObjectId, publish }: {
        oldObjectId: string | undefined,
        publish: GitFilePublisher,
      }): Promise<void> {
        if (reflog !== undefined) {
          await appendReflog({
            files,
            path: joinPath({ base: repository.gitDirPath, child: 'logs/HEAD' }),
            oldObjectId,
            newObjectId: objectId,
            ...reflog,
            publish,
          });
        }
      }

      const refName = head.symbolicRef;
      if (refName === undefined) {
        checkOldObjectId({ oldObjectId: head.objectId });
        await replace({
          replacement: {
            bytes: textEncoder.encode(`${objectId}\n`),
            expectedDestination: { entry },
            publish: reflog === undefined ? undefined : ({ rename: headRename }) => appendHeadLog({
              oldObjectId: head.objectId,
              publish: ({ rename: log }) => files.publishEntries({ changes: [log, headRename] }),
            }),
          },
        });
        return;
      }
      await publishRef({
        files,
        repository,
        refName,
        objectId,
        create: false,
        prepare: ({ oldObjectId }) => {
          checkOldObjectId({ oldObjectId });
          return async ({ rename: ref }) => {
            if (reflog === undefined) {
              await verifyHead();
              await files.publishEntries({ changes: [ref] });
              return;
            }
            await appendReflog({
              files,
              path: joinPath({ base: repository.commonDirPath, child: `logs/${refName}` }),
              oldObjectId,
              newObjectId: objectId,
              ...reflog,
              publish: ({ rename: branchLog }) => appendHeadLog({
                oldObjectId,
                publish: async ({ rename: headLog }) => {
                  await verifyHead();
                  await files.publishEntries({ changes: [headLog, branchLog, ref] });
                },
              }),
            });
          };
        },
      });
    },
  });
}

export async function writeOrigHead({ files, repository, objectId }: {
  files: GitFiles,
  repository: GitRepository,
  objectId: string,
}): Promise<void> {
  if (!/^[0-9a-f]{40}$/u.test(objectId)) {
    throw new Error(`invalid object id: ${objectId}`);
  }
  await replaceTextViaLock({
    files,
    path: joinPath({ base: repository.gitDirPath, child: 'ORIG_HEAD' }),
    text: `${objectId}\n`,
  });
}

export function branchNameFromHead({ head }: { head: GitHeadState }): string | undefined {
  if (head.symbolicRef === undefined) {
    return undefined;
  }
  const prefix = 'refs/heads/';
  return head.symbolicRef.startsWith(prefix) ? head.symbolicRef.slice(prefix.length) : undefined;
}

export const TEST_ONLY = {
};
