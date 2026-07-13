import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toBinaryObjectId } from '@/01-models/ids';
import type { Settings } from '@/01-models/types';
import { MockFileSystemDirectoryHandle } from '@/utils/in-memory-file-system';
import { createEncryptedOpfs } from '@/00-storage/service/encrypted-opfs';
import { createNativeOpfsFileSystemSession } from '@/00-storage/service/storage-file-system/native-opfs';
import type {
  StorageDirectoryHandle,
  StorageEntryHandle,
  StorageFileSystemSession,
} from '@/00-storage/service/storage-file-system/types';
import { HostVolumeDB } from '@/00-storage/service/opfs/host-volume-db';
import { NaidanOpfsStorageBackend } from './backend';

const ROOT_KEY = new Uint8Array(32).fill(17);
const BINARY_OBJECT_ID = toBinaryObjectId({
  raw: '00000000-0000-4000-a000-0000000000a1',
});

const SETTINGS: Settings = {
  titleGeneration: {
    endpoint: 'same_scope',
    model: 'same_scope',
    lmParameters: {
      temperature: undefined,
      topP: undefined,
      maxCompletionTokens: undefined,
      presencePenalty: undefined,
      frequencyPenalty: undefined,
      stop: undefined,
      reasoning: { effort: undefined },
    },
  },
  storageType: 'opfs',
  providerProfiles: [],
  mounts: [],
  endpoint: { type: 'openai', url: 'http://localhost' },
};

type LogicalTreeValue =
  | { readonly kind: 'directory' }
  | { readonly kind: 'file'; readonly bytes: readonly number[] }
  | { readonly kind: 'symlink'; readonly target: string };

async function readLogicalTree({ root }: {
  root: StorageDirectoryHandle;
}): Promise<Readonly<Record<string, LogicalTreeValue>>> {
  const values: Record<string, LogicalTreeValue> = {};

  async function visit({ directory, prefix }: {
    directory: StorageDirectoryHandle;
    prefix: string;
  }): Promise<void> {
    const entries: Array<readonly [string, StorageEntryHandle]> = [];
    for await (const entry of directory.entries()) {
      entries.push(entry);
    }
    entries.sort(([left], [right]) => left.localeCompare(right));

    for (const [name, handle] of entries) {
      const path = prefix.length === 0 ? name : `${prefix}/${name}`;
      switch (handle.kind) {
      case 'directory':
        values[path] = { kind: 'directory' };
        await visit({ directory: handle, prefix: path });
        break;
      case 'file': {
        const readable = await handle.openReadable({
          mimeType: 'application/octet-stream',
        });
        try {
          const bytes = new Uint8Array(await new Response(readable.stream({
            start: 0,
            end: undefined,
            signal: undefined,
          })).arrayBuffer());
          values[path] = { kind: 'file', bytes: [...bytes] };
        } finally {
          await readable.close();
        }
        break;
      }
      case 'symlink':
        values[path] = { kind: 'symlink', target: await handle.readTarget() };
        break;
      default: {
        const _ex: never = handle;
        throw new Error(`Unhandled storage entry: ${String(_ex)}`);
      }
      }
    }
  }

  await visit({ directory: root, prefix: '' });
  return values;
}

async function exerciseBackend({ session }: {
  session: StorageFileSystemSession;
}): Promise<Readonly<Record<string, LogicalTreeValue>>> {
  const backend = new NaidanOpfsStorageBackend({
    namespaceRoot: session.root,
    hostVolumeDB: new HostVolumeDB(),
  });
  await backend.init();
  await backend.saveSettings({ settings: SETTINGS });
  await backend.writeBinaryObject({
    source: {
      type: 'direct_blob',
      blob: new Blob([new Uint8Array([1, 2, 3, 4])], {
        type: 'application/octet-stream',
      }),
    },
    binaryObjectId: BINARY_OBJECT_ID,
    name: 'value.bin',
    mimeType: 'application/octet-stream',
    size: 4,
    createdAt: 123,
    signal: undefined,
  });

  const special = await backend.openSpecialFileSystemDirectory({
    type: 'debug_wesh',
    path: '/global/home',
    create: true,
  });
  expect(special?.type).toBe('storage_directory');
  if (special?.type !== 'storage_directory') {
    throw new Error('Expected a storage directory');
  }
  const file = await special.handle.getFileHandle({
    name: 'note.txt',
    create: true,
  });
  const writable = await file.createWritable({ keepExistingData: false });
  await writable.write({
    position: 0,
    data: new TextEncoder().encode('debug'),
  });
  await writable.close();

  expect(await backend.loadSettings()).toMatchObject(SETTINGS);
  const binary = await backend.openBinaryObject({
    binaryObjectId: BINARY_OBJECT_ID,
  });
  expect(binary).not.toBeNull();
  if (binary === null) {
    throw new Error('Expected the binary object');
  }
  try {
    expect([...new Uint8Array(await new Response(binary.stream({
      start: 0,
      end: undefined,
      signal: undefined,
    })).arrayBuffer())]).toEqual([1, 2, 3, 4]);
  } finally {
    await binary.close();
  }

  return await readLogicalTree({ root: session.root });
}

describe('Naidan OPFS layout backend', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-02T03:04:05.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('produces the same released logical layout over native OPFS and EncryptedOpfs', async () => {
    const nativeSession = createNativeOpfsFileSystemSession({
      root: new MockFileSystemDirectoryHandle({ name: 'native-root' }),
    });
    const encryptedSession = await createEncryptedOpfs({
      backingDirectory: new MockFileSystemDirectoryHandle({
        name: 'encrypted-backing',
      }),
      fileSystemRootKey: ROOT_KEY,
    });

    const nativeTree = await exerciseBackend({ session: nativeSession });
    const encryptedTree = await exerciseBackend({ session: encryptedSession });

    expect(encryptedTree).toEqual(nativeTree);
    expect(nativeTree).toMatchObject({
      'naidan-storage': { kind: 'directory' },
      'naidan-storage/settings.json': { kind: 'file' },
      'naidan-storage/binary-objects/a1': { kind: 'directory' },
      'naidan-debug-wesh/global/home/note.txt': {
        kind: 'file',
        bytes: [...new TextEncoder().encode('debug')],
      },
    });
  });
});
