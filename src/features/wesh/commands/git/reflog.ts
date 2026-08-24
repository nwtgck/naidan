import type { GitFiles } from './files';
import { pathExists, readFileText, replaceTextViaLock } from './files';
import type { GitIdentity } from './identity';

const ZERO_OBJECT_ID = '0000000000000000000000000000000000000000';

function parentPath({ path }: { path: string }): string {
  const slashIndex = path.lastIndexOf('/');
  return slashIndex <= 0 ? '/' : path.slice(0, slashIndex);
}

function normalizeReflogMessage({ message }: { message: string }): string {
  return message.replace(/[\r\n]+/gu, ' ').trim();
}

export async function appendReflog({ files, path, oldObjectId, newObjectId, identity, timestamp, message }: {
  files: GitFiles,
  path: string,
  oldObjectId: string | undefined,
  newObjectId: string,
  identity: GitIdentity,
  timestamp: string,
  message: string,
}): Promise<void> {
  const directory = parentPath({ path });
  if (!await pathExists({ files, path: directory })) await files.mkdir({ path: directory, recursive: true });
  const previous = await pathExists({ files, path }) ? await readFileText({ files, path }) : '';
  const line = `${oldObjectId ?? ZERO_OBJECT_ID} ${newObjectId} ${identity.name} <${identity.email}> ${timestamp}\t${normalizeReflogMessage({ message })}\n`;
  await replaceTextViaLock({ files, path, text: `${previous}${line}` });
}


export interface GitReflogEntry {
  oldObjectId: string,
  newObjectId: string,
  identity: string,
  timestamp: string,
  message: string,
}

export async function readReflog({ files, path }: {
  files: GitFiles,
  path: string,
}): Promise<GitReflogEntry[]> {
  if (!await pathExists({ files, path })) return [];
  const result: GitReflogEntry[] = [];
  for (const line of (await readFileText({ files, path })).split('\n')) {
    if (line.length === 0) continue;
    const tabIndex = line.indexOf('\t');
    if (tabIndex < 0) throw new Error(`invalid reflog entry in ${path}`);
    const metadata = line.slice(0, tabIndex);
    const message = line.slice(tabIndex + 1);
    const match = /^([0-9a-f]{40}) ([0-9a-f]{40}) (.+ <[^>]*>) ([0-9]+ [+-][0-9]{4})$/u.exec(metadata);
    if (match === null) throw new Error(`invalid reflog entry in ${path}`);
    result.push({
      oldObjectId: match[1]!,
      newObjectId: match[2]!,
      identity: match[3]!,
      timestamp: match[4]!,
      message,
    });
  }
  return result;
}

export const TEST_ONLY = {
  normalizeReflogMessage,
};
