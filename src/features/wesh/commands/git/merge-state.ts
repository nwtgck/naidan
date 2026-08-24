import type { GitFiles } from './files';
import { pathExists, readFileText, replaceTextViaLock } from './files';
import type { GitRepository } from './repository';
import { joinPath } from './repository';

export interface GitMergeState {
  mergeHeadObjectId: string,
  message: string,
}

function statePath({ repository, name }: { repository: GitRepository, name: string }): string {
  return joinPath({ base: repository.gitDirPath, child: name });
}

export async function readMergeState({ files, repository }: {
  files: GitFiles,
  repository: GitRepository,
}): Promise<GitMergeState | undefined> {
  const mergeHeadPath = statePath({ repository, name: 'MERGE_HEAD' });
  if (!await pathExists({ files, path: mergeHeadPath })) return undefined;
  const mergeHeadObjectId = (await readFileText({ files, path: mergeHeadPath })).trim();
  if (!/^[0-9a-f]{40}$/u.test(mergeHeadObjectId)) throw new Error('invalid MERGE_HEAD');
  const messagePath = statePath({ repository, name: 'MERGE_MSG' });
  const rawMessage = await readFileText({ files, path: messagePath });
  const commentOffset = rawMessage.indexOf('\n# Conflicts:');
  const message = (commentOffset < 0 ? rawMessage : rawMessage.slice(0, commentOffset)).trimEnd();
  if (message.length === 0) throw new Error('empty MERGE_MSG');
  return { mergeHeadObjectId, message };
}

export async function writeMergeState({ files, repository, mergeHeadObjectId, message, conflictPaths }: {
  files: GitFiles,
  repository: GitRepository,
  mergeHeadObjectId: string,
  message: string,
  conflictPaths: readonly string[],
}): Promise<void> {
  if (!/^[0-9a-f]{40}$/u.test(mergeHeadObjectId)) throw new Error(`invalid merge head: ${mergeHeadObjectId}`);
  await replaceTextViaLock({ files, path: statePath({ repository, name: 'MERGE_HEAD' }), text: `${mergeHeadObjectId}\n` });
  await replaceTextViaLock({ files, path: statePath({ repository, name: 'MERGE_MODE' }), text: '' });
  const conflictSection = conflictPaths.length === 0
    ? ''
    : `\n# Conflicts:\n${conflictPaths.map(path => `#\t${path}\n`).join('')}`;
  await replaceTextViaLock({
    files,
    path: statePath({ repository, name: 'MERGE_MSG' }),
    text: `${message}\n${conflictSection}`,
  });
}

export async function clearMergeState({ files, repository }: {
  files: GitFiles,
  repository: GitRepository,
}): Promise<void> {
  for (const name of ['MERGE_HEAD', 'MERGE_MODE', 'MERGE_MSG']) {
    const path = statePath({ repository, name });
    if (await pathExists({ files, path })) await files.unlink({ path });
  }
}

export const TEST_ONLY = {
};
