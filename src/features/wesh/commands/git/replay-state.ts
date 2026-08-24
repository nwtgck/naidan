import type { GitFiles } from './files';
import { pathExists, readFileText, replaceTextViaLock } from './files';
import type { GitRepository } from './repository';
import { joinPath } from './repository';

export type GitReplayKind = 'cherry-pick' | 'revert';

export interface GitReplayState {
  kind: GitReplayKind,
  sourceObjectId: string,
  message: string,
}

function statePath({ repository, name }: { repository: GitRepository, name: string }): string {
  return joinPath({ base: repository.gitDirPath, child: name });
}

function headFileName({ kind }: { kind: GitReplayKind }): 'CHERRY_PICK_HEAD' | 'REVERT_HEAD' {
  switch (kind) {
  case 'cherry-pick':
    return 'CHERRY_PICK_HEAD';
  case 'revert':
    return 'REVERT_HEAD';
  default: {
    const _ex: never = kind;
    throw new Error(`Unhandled replay kind: ${_ex}`);
  }
  }
}

export async function readReplayState({ files, repository }: {
  files: GitFiles,
  repository: GitRepository,
}): Promise<GitReplayState | undefined> {
  const found: Array<{ kind: GitReplayKind, path: string }> = [];
  for (const kind of ['cherry-pick', 'revert'] as const) {
    const path = statePath({ repository, name: headFileName({ kind }) });
    if (await pathExists({ files, path })) found.push({ kind, path });
  }
  if (found.length === 0) return undefined;
  if (found.length !== 1) throw new Error('multiple replay states are active');
  const current = found[0]!;
  const sourceObjectId = (await readFileText({ files, path: current.path })).trim();
  if (!/^[0-9a-f]{40}$/u.test(sourceObjectId)) throw new Error(`invalid ${headFileName({ kind: current.kind })}`);
  const rawMessage = await readFileText({ files, path: statePath({ repository, name: 'MERGE_MSG' }) });
  const commentOffset = rawMessage.indexOf('\n# Conflicts:');
  const message = (commentOffset < 0 ? rawMessage : rawMessage.slice(0, commentOffset)).trimEnd();
  if (message.length === 0) throw new Error('empty MERGE_MSG');
  return { kind: current.kind, sourceObjectId, message };
}

export async function writeReplayState({ files, repository, kind, sourceObjectId, message, conflictPaths }: {
  files: GitFiles,
  repository: GitRepository,
  kind: GitReplayKind,
  sourceObjectId: string,
  message: string,
  conflictPaths: readonly string[],
}): Promise<void> {
  if (!/^[0-9a-f]{40}$/u.test(sourceObjectId)) throw new Error(`invalid replay object id: ${sourceObjectId}`);
  await replaceTextViaLock({
    files,
    path: statePath({ repository, name: headFileName({ kind }) }),
    text: `${sourceObjectId}\n`,
  });
  const conflictSection = conflictPaths.length === 0
    ? ''
    : `\n# Conflicts:\n${conflictPaths.map(path => `#\t${path}\n`).join('')}`;
  await replaceTextViaLock({
    files,
    path: statePath({ repository, name: 'MERGE_MSG' }),
    text: `${message.endsWith('\n') ? message : `${message}\n`}${conflictSection}`,
  });
}

export async function clearReplayState({ files, repository, kind }: {
  files: GitFiles,
  repository: GitRepository,
  kind: GitReplayKind,
}): Promise<void> {
  for (const name of [headFileName({ kind }), 'MERGE_MSG'] as const) {
    const path = statePath({ repository, name });
    if (await pathExists({ files, path })) await files.unlink({ path });
  }
}

export const TEST_ONLY = {
  headFileName,
};
