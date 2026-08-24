import type { GitFiles } from './files';
import { pathExists, readFileText, replaceTextViaLock } from './files';
import type { GitRepository } from './repository';
import { joinPath } from './repository';

export interface GitRebaseTodoEntry {
  objectId: string,
  subject: string,
}

export interface GitRebaseState {
  headRefName: string,
  origHeadObjectId: string,
  ontoObjectId: string,
  todo: GitRebaseTodoEntry[],
  done: GitRebaseTodoEntry[],
  stoppedObjectId: string | undefined,
  message: string | undefined,
}

function rebaseDirectory({ repository }: { repository: GitRepository }): string {
  return joinPath({ base: repository.gitDirPath, child: 'rebase-merge' });
}

function statePath({ repository, name }: { repository: GitRepository, name: string }): string {
  return joinPath({ base: rebaseDirectory({ repository }), child: name });
}

function formatTodo({ entries }: { entries: readonly GitRebaseTodoEntry[] }): string {
  return entries.map(entry => `pick ${entry.objectId} ${entry.subject}\n`).join('');
}

function parseTodo({ text }: { text: string }): GitRebaseTodoEntry[] {
  if (text.length === 0) return [];
  return text.split('\n').filter(line => line.length > 0).map(line => {
    const match = /^pick ([0-9a-f]{40})(?: (.*))?$/u.exec(line);
    if (match === null) throw new Error(`unsupported rebase todo line: ${line}`);
    return { objectId: match[1]!, subject: match[2] ?? '' };
  });
}

async function readOptionalText({ files, path }: { files: GitFiles, path: string }): Promise<string | undefined> {
  return await pathExists({ files, path }) ? await readFileText({ files, path }) : undefined;
}

export async function readRebaseState({ files, repository }: {
  files: GitFiles,
  repository: GitRepository,
}): Promise<GitRebaseState | undefined> {
  const directory = rebaseDirectory({ repository });
  if (!await pathExists({ files, path: directory })) return undefined;
  const headRefName = (await readFileText({ files, path: statePath({ repository, name: 'head-name' }) })).trim();
  const origHeadObjectId = (await readFileText({ files, path: statePath({ repository, name: 'orig-head' }) })).trim();
  const ontoObjectId = (await readFileText({ files, path: statePath({ repository, name: 'onto' }) })).trim();
  if (!headRefName.startsWith('refs/heads/')) throw new Error('invalid rebase head-name');
  if (!/^[0-9a-f]{40}$/u.test(origHeadObjectId)) throw new Error('invalid rebase orig-head');
  if (!/^[0-9a-f]{40}$/u.test(ontoObjectId)) throw new Error('invalid rebase onto');
  const stoppedText = await readOptionalText({ files, path: statePath({ repository, name: 'stopped-sha' }) });
  const stoppedObjectId = stoppedText?.trim();
  if (stoppedObjectId !== undefined && !/^[0-9a-f]{40}$/u.test(stoppedObjectId)) {
    throw new Error('invalid rebase stopped-sha');
  }
  const messageText = await readOptionalText({ files, path: statePath({ repository, name: 'message' }) });
  const commentOffset = messageText?.indexOf('\n# Conflicts:') ?? -1;
  const message = messageText === undefined
    ? undefined
    : (commentOffset < 0 ? messageText : messageText.slice(0, commentOffset)).trimEnd();
  return {
    headRefName,
    origHeadObjectId,
    ontoObjectId,
    todo: parseTodo({ text: await readFileText({ files, path: statePath({ repository, name: 'git-rebase-todo' }) }) }),
    done: parseTodo({ text: await readFileText({ files, path: statePath({ repository, name: 'done' }) }) }),
    stoppedObjectId,
    message,
  };
}

export async function writeRebaseState({ files, repository, headRefName, origHeadObjectId, ontoObjectId, todo }: {
  files: GitFiles,
  repository: GitRepository,
  headRefName: string,
  origHeadObjectId: string,
  ontoObjectId: string,
  todo: readonly GitRebaseTodoEntry[],
}): Promise<void> {
  const directory = rebaseDirectory({ repository });
  await files.mkdir({ path: directory, recursive: true });
  await replaceTextViaLock({ files, path: statePath({ repository, name: 'head-name' }), text: `${headRefName}\n` });
  await replaceTextViaLock({ files, path: statePath({ repository, name: 'orig-head' }), text: `${origHeadObjectId}\n` });
  await replaceTextViaLock({ files, path: statePath({ repository, name: 'onto' }), text: `${ontoObjectId}\n` });
  await replaceTextViaLock({ files, path: statePath({ repository, name: 'git-rebase-todo' }), text: formatTodo({ entries: todo }) });
  await replaceTextViaLock({ files, path: statePath({ repository, name: 'done' }), text: '' });
  await replaceTextViaLock({ files, path: statePath({ repository, name: 'end' }), text: `${todo.length}\n` });
  await replaceTextViaLock({ files, path: statePath({ repository, name: 'msgnum' }), text: '0\n' });
}

export async function beginRebaseStep({ files, repository }: {
  files: GitFiles,
  repository: GitRepository,
}): Promise<GitRebaseTodoEntry | undefined> {
  const state = await readRebaseState({ files, repository });
  if (state === undefined) throw new Error('no rebase in progress');
  const step = state.todo[0];
  if (step === undefined) return undefined;
  const remaining = state.todo.slice(1);
  const done = [...state.done, step];
  await replaceTextViaLock({ files, path: statePath({ repository, name: 'git-rebase-todo' }), text: formatTodo({ entries: remaining }) });
  await replaceTextViaLock({ files, path: statePath({ repository, name: 'done' }), text: formatTodo({ entries: done }) });
  await replaceTextViaLock({ files, path: statePath({ repository, name: 'msgnum' }), text: `${done.length}\n` });
  return step;
}

export async function writeRebaseStoppedState({ files, repository, sourceObjectId, message, conflictPaths }: {
  files: GitFiles,
  repository: GitRepository,
  sourceObjectId: string,
  message: string,
  conflictPaths: readonly string[],
}): Promise<void> {
  await replaceTextViaLock({ files, path: statePath({ repository, name: 'stopped-sha' }), text: `${sourceObjectId}\n` });
  const conflictSection = conflictPaths.length === 0
    ? ''
    : `\n# Conflicts:\n${conflictPaths.map(path => `#\t${path}\n`).join('')}`;
  await replaceTextViaLock({
    files,
    path: statePath({ repository, name: 'message' }),
    text: `${message.endsWith('\n') ? message : `${message}\n`}${conflictSection}`,
  });
}

export async function clearRebaseStoppedState({ files, repository }: {
  files: GitFiles,
  repository: GitRepository,
}): Promise<void> {
  for (const name of ['stopped-sha', 'message'] as const) {
    const path = statePath({ repository, name });
    if (await pathExists({ files, path })) await files.unlink({ path });
  }
}

export async function clearRebaseState({ files, repository }: {
  files: GitFiles,
  repository: GitRepository,
}): Promise<void> {
  const directory = rebaseDirectory({ repository });
  if (!await pathExists({ files, path: directory })) return;
  for await (const entry of files.readDir({ path: directory })) {
    switch (entry.type) {
    case 'file':
      await files.unlink({ path: entry.fullPath });
      break;
    case 'directory':
    case 'fifo':
    case 'chardev':
    case 'symlink':
      throw new Error(`unsupported rebase state entry: ${entry.name}`);
    default: {
      const _ex: never = entry.type;
      throw new Error(`Unhandled rebase state entry type: ${_ex}`);
    }
    }
  }
  await files.rmdir({ path: directory });
}

export const TEST_ONLY = {
  formatTodo,
  parseTodo,
};
