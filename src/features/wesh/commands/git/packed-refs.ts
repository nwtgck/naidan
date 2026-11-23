import type { WeshPreparedRename } from '@/features/wesh/types';
import type { GitFiles } from './files';
import { readFileText, resolveOptionalEntry, withFileLock } from './files';
import type { GitRepository } from './repository';
import { sortByGitUtf8StringKey } from './utf8-order';
import { joinPath } from './repository';

const textEncoder = new TextEncoder();

export interface GitPackedRef {
  refName: string,
  objectId: string,
  peeledObjectId: string | undefined,
}

function assertPackedObjectId({ objectId }: { objectId: string }): void {
  if (!/^[0-9a-f]{40}$/u.test(objectId)) {
    throw new Error(`invalid packed ref object id: ${objectId}`);
  }
}

async function readPackedRefFile({ files, path }: {
  files: GitFiles,
  path: string,
}) {
  const entry = await resolveOptionalEntry({ files, path });
  switch (entry?.type) {
  case undefined:
    return { entry: undefined, entries: [] };
  case 'file':
    break;
  case 'directory':
  case 'fifo':
  case 'chardev':
  case 'symlink':
    throw new Error(`Not a regular packed-refs file: ${path}`);
  default: {
    const _ex: never = entry;
    throw new Error(`Unhandled packed-refs entry: ${String(_ex)}`);
  }
  }
  const result: GitPackedRef[] = [];
  let previous: GitPackedRef | undefined;
  for (const line of (await readFileText({ files, entry })).split(/\r?\n/u)) {
    if (line.length === 0 || line.startsWith('#')) {
      continue;
    }
    if (line.startsWith('^')) {
      if (previous === undefined) {
        throw new Error('packed-refs contains a peeled line without a ref');
      }
      const peeledObjectId = line.slice(1);
      assertPackedObjectId({ objectId: peeledObjectId });
      previous.peeledObjectId = peeledObjectId;
      continue;
    }
    const match = /^([0-9a-f]{40}) (refs\/.+)$/u.exec(line);
    if (match === null) {
      throw new Error(`invalid packed-refs line: ${line}`);
    }
    assertPackedObjectId({ objectId: match[1]! });
    previous = { refName: match[2]!, objectId: match[1]!, peeledObjectId: undefined };
    result.push(previous);
  }
  return { entry, entries: result };
}

export async function readPackedRefs({ files, repository }: {
  files: GitFiles,
  repository: GitRepository,
}): Promise<GitPackedRef[]> {
  return (await readPackedRefFile({ files, path: joinPath({ base: repository.commonDirPath, child: 'packed-refs' }) })).entries;
}

function serializePackedRefs({ entries }: {
  entries: readonly GitPackedRef[],
}): Uint8Array {
  const sorted = sortByGitUtf8StringKey({ values: entries, key: ({ value }) => value.refName });
  const lines = ['# pack-refs with: peeled fully-peeled sorted '];
  for (const entry of sorted) {
    lines.push(`${entry.objectId} ${entry.refName}`);
    if (entry.peeledObjectId !== undefined) {
      lines.push(`^${entry.peeledObjectId}`);
    }
  }
  return textEncoder.encode(`${lines.join('\n')}\n`);
}

export async function withPackedRefRemoval({ files, repository, refName, publish }: {
  files: GitFiles,
  repository: GitRepository,
  refName: string,
  publish: ({ rename }: { rename: WeshPreparedRename | undefined }) => Promise<void>,
}): Promise<boolean> {
  const path = joinPath({ base: repository.commonDirPath, child: 'packed-refs' });
  return withFileLock({
    files,
    path,
    operation: async ({ replace, verify }) => {
      const { entry, entries } = await readPackedRefFile({ files, path });
      const filtered = entries.filter(packed => packed.refName !== refName);
      if (filtered.length === entries.length) {
        await verify();
        await publish({ rename: undefined });
        return false;
      }
      await replace({
        replacement: {
          bytes: serializePackedRefs({ entries: filtered }),
          expectedDestination: { entry },
          publish,
        },
      });
      return true;
    },
  });
}

export const TEST_ONLY = {
};
