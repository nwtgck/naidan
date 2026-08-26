import type { GitFiles } from './files';
import { pathExists, readFileText, replaceTextViaLock } from './files';
import type { GitRepository } from './repository';
import { compareGitUtf8Strings } from './utf8-order';
import { joinPath } from './repository';

export interface GitPackedRef {
  refName: string,
  objectId: string,
  peeledObjectId: string | undefined,
}

function assertPackedObjectId({ objectId }: { objectId: string }): void {
  if (!/^[0-9a-f]{40}$/u.test(objectId)) throw new Error(`invalid packed ref object id: ${objectId}`);
}

export async function readPackedRefs({ files, repository }: {
  files: GitFiles,
  repository: GitRepository,
}): Promise<GitPackedRef[]> {
  const path = joinPath({ base: repository.commonDirPath, child: 'packed-refs' });
  if (!await pathExists({ files, path })) return [];
  const result: GitPackedRef[] = [];
  let previous: GitPackedRef | undefined;
  for (const line of (await readFileText({ files, path })).split(/\r?\n/u)) {
    if (line.length === 0 || line.startsWith('#')) continue;
    if (line.startsWith('^')) {
      if (previous === undefined) throw new Error('packed-refs contains a peeled line without a ref');
      const peeledObjectId = line.slice(1);
      assertPackedObjectId({ objectId: peeledObjectId });
      previous.peeledObjectId = peeledObjectId;
      continue;
    }
    const match = /^([0-9a-f]{40}) (refs\/.+)$/u.exec(line);
    if (match === null) throw new Error(`invalid packed-refs line: ${line}`);
    assertPackedObjectId({ objectId: match[1]! });
    previous = { refName: match[2]!, objectId: match[1]!, peeledObjectId: undefined };
    result.push(previous);
  }
  return result;
}

async function writePackedRefs({ files, repository, entries }: {
  files: GitFiles,
  repository: GitRepository,
  entries: readonly GitPackedRef[],
}): Promise<void> {
  const sorted = [...entries].sort((left, right) => compareGitUtf8Strings({ left: left.refName, right: right.refName }));
  const lines = ['# pack-refs with: peeled fully-peeled sorted '];
  for (const entry of sorted) {
    lines.push(`${entry.objectId} ${entry.refName}`);
    if (entry.peeledObjectId !== undefined) lines.push(`^${entry.peeledObjectId}`);
  }
  await replaceTextViaLock({
    files,
    path: joinPath({ base: repository.commonDirPath, child: 'packed-refs' }),
    text: `${lines.join('\n')}\n`,
  });
}

export async function removePackedRef({ files, repository, refName }: {
  files: GitFiles,
  repository: GitRepository,
  refName: string,
}): Promise<boolean> {
  const entries = await readPackedRefs({ files, repository });
  const filtered = entries.filter(entry => entry.refName !== refName);
  if (filtered.length === entries.length) return false;
  await writePackedRefs({ files, repository, entries: filtered });
  return true;
}

export const TEST_ONLY = {
};
