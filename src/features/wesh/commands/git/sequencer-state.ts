import type { GitFiles } from './files';
import { pathExists, readFileText, replaceTextViaLock } from './files';
import type { GitRepository } from './repository';
import { joinPath } from './repository';
import type { GitReplayKind } from './replay-state';

export interface GitSequencerTodoEntry {
  kind: GitReplayKind,
  objectId: string,
  subject: string,
}

export interface GitSequencerState {
  headObjectId: string,
  todo: GitSequencerTodoEntry[],
  mainlineParentNumber: number | undefined,
}

function sequencerDirectory({ repository }: { repository: GitRepository }): string {
  return joinPath({ base: repository.gitDirPath, child: 'sequencer' });
}

function statePath({ repository, name }: { repository: GitRepository, name: string }): string {
  return joinPath({ base: sequencerDirectory({ repository }), child: name });
}

function todoVerb({ kind }: { kind: GitReplayKind }): 'pick' | 'revert' {
  switch (kind) {
  case 'cherry-pick':
    return 'pick';
  case 'revert':
    return 'revert';
  default: {
    const _ex: never = kind;
    throw new Error(`Unhandled replay kind: ${_ex}`);
  }
  }
}

function kindFromVerb({ verb }: { verb: string }): GitReplayKind {
  switch (verb) {
  case 'pick':
    return 'cherry-pick';
  case 'revert':
    return 'revert';
  default:
    throw new Error(`unsupported sequencer todo action: ${verb}`);
  }
}

function formatTodo({ entries }: { entries: readonly GitSequencerTodoEntry[] }): string {
  return entries.map(entry => `${todoVerb({ kind: entry.kind })} ${entry.objectId} ${entry.subject}\n`).join('');
}

function parseTodo({ text }: { text: string }): GitSequencerTodoEntry[] {
  if (text.length === 0) return [];
  return text.split('\n').filter(line => line.length > 0).map(line => {
    const match = /^(pick|revert) ([0-9a-f]{40})(?: (.*))?$/u.exec(line);
    if (match === null) throw new Error(`unsupported sequencer todo line: ${line}`);
    return {
      kind: kindFromVerb({ verb: match[1]! }),
      objectId: match[2]!,
      subject: match[3] ?? '',
    };
  });
}


function parseOptions({ text }: { text: string }): { mainlineParentNumber: number | undefined } {
  let mainlineParentNumber: number | undefined;
  for (const line of text.split('\n')) {
    const match = /^\s*mainline = ([0-9]+)$/u.exec(line);
    if (match !== null) {
      mainlineParentNumber = Number.parseInt(match[1]!, 10);
      if (mainlineParentNumber < 1) throw new Error('invalid sequencer mainline');
    }
  }
  return { mainlineParentNumber };
}

function formatOptions({ kind, mainlineParentNumber }: {
  kind: GitReplayKind,
  mainlineParentNumber: number | undefined,
}): string | undefined {
  const lines: string[] = [];
  switch (kind) {
  case 'cherry-pick':
    break;
  case 'revert':
    lines.push('\tedit = false');
    break;
  default: {
    const _ex: never = kind;
    throw new Error(`Unhandled sequencer kind: ${_ex}`);
  }
  }
  if (mainlineParentNumber !== undefined) lines.push(`\tmainline = ${mainlineParentNumber}`);
  if (lines.length === 0) return undefined;
  return `[options]\n${lines.join('\n')}\n`;
}

export async function readSequencerState({ files, repository }: {
  files: GitFiles,
  repository: GitRepository,
}): Promise<GitSequencerState | undefined> {
  const directory = sequencerDirectory({ repository });
  if (!await pathExists({ files, path: directory })) return undefined;
  const headObjectId = (await readFileText({ files, path: statePath({ repository, name: 'head' }) })).trim();
  if (!/^[0-9a-f]{40}$/u.test(headObjectId)) throw new Error('invalid sequencer head');
  const abortSafetyPath = statePath({ repository, name: 'abort-safety' });
  if (await pathExists({ files, path: abortSafetyPath })) {
    const abortSafetyObjectId = (await readFileText({ files, path: abortSafetyPath })).trim();
    if (abortSafetyObjectId !== headObjectId) throw new Error('sequencer abort-safety does not match head');
  }
  const optionsPath = statePath({ repository, name: 'opts' });
  const options = await pathExists({ files, path: optionsPath })
    ? parseOptions({ text: await readFileText({ files, path: optionsPath }) })
    : { mainlineParentNumber: undefined };
  return {
    headObjectId,
    todo: parseTodo({ text: await readFileText({ files, path: statePath({ repository, name: 'todo' }) }) }),
    mainlineParentNumber: options.mainlineParentNumber,
  };
}

export async function writeSequencerState({ files, repository, headObjectId, todo, mainlineParentNumber }: {
  files: GitFiles,
  repository: GitRepository,
  headObjectId: string,
  todo: readonly GitSequencerTodoEntry[],
  mainlineParentNumber?: number,
}): Promise<void> {
  if (!/^[0-9a-f]{40}$/u.test(headObjectId)) throw new Error(`invalid sequencer head object id: ${headObjectId}`);
  if (todo.length === 0) throw new Error('sequencer todo must not be empty');
  const directory = sequencerDirectory({ repository });
  await files.mkdir({ path: directory, recursive: true });
  await replaceTextViaLock({ files, path: statePath({ repository, name: 'head' }), text: `${headObjectId}\n` });
  await replaceTextViaLock({ files, path: statePath({ repository, name: 'abort-safety' }), text: `${headObjectId}\n` });
  await replaceTextViaLock({ files, path: statePath({ repository, name: 'todo' }), text: formatTodo({ entries: todo }) });
  const options = formatOptions({ kind: todo[0]!.kind, mainlineParentNumber });
  if (options !== undefined) {
    await replaceTextViaLock({ files, path: statePath({ repository, name: 'opts' }), text: options });
  }
}

export async function advanceSequencer({ files, repository }: {
  files: GitFiles,
  repository: GitRepository,
}): Promise<GitSequencerTodoEntry | undefined> {
  const state = await readSequencerState({ files, repository });
  if (state === undefined) throw new Error('no sequencer in progress');
  const current = state.todo[0];
  if (current === undefined) return undefined;
  const remaining = state.todo.slice(1);
  await replaceTextViaLock({ files, path: statePath({ repository, name: 'todo' }), text: formatTodo({ entries: remaining }) });
  return current;
}

export async function clearSequencerState({ files, repository }: {
  files: GitFiles,
  repository: GitRepository,
}): Promise<void> {
  const directory = sequencerDirectory({ repository });
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
      throw new Error(`unsupported sequencer state entry: ${entry.name}`);
    default: {
      const _ex: never = entry.type;
      throw new Error(`Unhandled sequencer state entry type: ${_ex}`);
    }
    }
  }
  await files.rmdir({ path: directory });
}

export const TEST_ONLY = {
  formatOptions,
  formatTodo,
  parseOptions,
  parseTodo,
};
