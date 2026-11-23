import type { WeshEntryRef } from '@/features/wesh/types';
import type { GitFilePublisher, GitFiles } from './files';
import { pathExists, readFileText, replaceFileViaLock, resolveOptionalEntry } from './files';
import type { GitIdentity } from './identity';

export const ZERO_OBJECT_ID = '0000000000000000000000000000000000000000';
const textEncoder = new TextEncoder();

function parentPath({ path }: { path: string }): string {
  const slashIndex = path.lastIndexOf('/');
  return slashIndex <= 0 ? '/' : path.slice(0, slashIndex);
}

function normalizeReflogMessage({ message }: { message: string }): string {
  return message.replace(/[\r\n]+/gu, ' ').trim();
}

export function formatReflogLine({ oldObjectId, newObjectId, identity, timestamp, message }: {
  oldObjectId: string | undefined,
  newObjectId: string,
  identity: GitIdentity,
  timestamp: string,
  message: string,
}): string {
  return `${oldObjectId ?? ZERO_OBJECT_ID} ${newObjectId} ${identity.name} <${identity.email}> ${timestamp}\t${normalizeReflogMessage({ message })}\n`;
}

export async function appendReflog({ files, path, oldObjectId, newObjectId, identity, timestamp, message, publish }: {
  files: GitFiles,
  path: string,
  oldObjectId: string | undefined,
  newObjectId: string,
  identity: GitIdentity,
  timestamp: string,
  message: string,
  publish?: GitFilePublisher,
}): Promise<void> {
  const directory = parentPath({ path });
  if (!await pathExists({ files, path: directory })) {
    await files.mkdir({ path: directory, recursive: true });
  }
  const line = formatReflogLine({ oldObjectId, newObjectId, identity, timestamp, message });
  await replaceFileViaLock({
    files,
    path,
    prepareBytes: async () => {
      const entry = await resolveReflogEntry({ files, path });
      const previous = entry === undefined ? '' : await readFileText({ files, entry });
      return { bytes: textEncoder.encode(`${previous}${line}`), expectedDestination: { entry }, publish };
    },
  });
}


export interface GitReflogEntry {
  oldObjectId: string,
  newObjectId: string,
  identity: string,
  timestamp: string,
  message: string,
}

export async function resolveReflogEntry({ files, path }: {
  files: GitFiles,
  path: string,
}): Promise<WeshEntryRef<'file'> | undefined> {
  const entry = await resolveOptionalEntry({ files, path });
  switch (entry?.type) {
  case undefined:
    return undefined;
  case 'file':
    return entry;
  case 'directory':
  case 'symlink':
  case 'fifo':
  case 'chardev':
    throw new Error(`Not a regular reflog: ${path}`);
  default: {
    const _ex: never = entry;
    throw new Error(`Unhandled reflog entry: ${String(_ex)}`);
  }
  }
}

export async function readReflogFile({ files, path }: {
  files: GitFiles,
  path: string,
}): Promise<{ entry: WeshEntryRef<'file'> | undefined, entries: GitReflogEntry[], text: string }> {
  const entry = await resolveReflogEntry({ files, path });
  if (entry === undefined) {
    return { entry: undefined, entries: [], text: '' };
  }
  const result: GitReflogEntry[] = [];
  const text = await readFileText({ files, entry });
  for (const line of text.split('\n')) {
    if (line.length === 0) {
      continue;
    }
    const tabIndex = line.indexOf('\t');
    if (tabIndex < 0) {
      throw new Error(`invalid reflog entry in ${path}`);
    }
    const metadata = line.slice(0, tabIndex);
    const message = line.slice(tabIndex + 1);
    const match = /^([0-9a-f]{40}) ([0-9a-f]{40}) (.+ <[^>]*>) ([0-9]+ [+-][0-9]{4})$/u.exec(metadata);
    if (match === null) {
      throw new Error(`invalid reflog entry in ${path}`);
    }
    result.push({
      oldObjectId: match[1]!,
      newObjectId: match[2]!,
      identity: match[3]!,
      timestamp: match[4]!,
      message,
    });
  }
  return { entry, entries: result, text };
}

export async function readReflog({ files, path }: { files: GitFiles, path: string }): Promise<GitReflogEntry[]> {
  return (await readReflogFile({ files, path })).entries;
}

export const TEST_ONLY = {
  normalizeReflogMessage,
};
