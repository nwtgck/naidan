import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LocalStorageProvider } from './local-storage';
import { MemoryStorageProvider } from './memory-storage';
import { OPFSStorageProvider } from './opfs-storage';
import { STORAGE_KEY_PREFIX } from '@/constants';
import { toChatGroupId } from '@/01-models/ids';
import * as mappers from '@/00-storage/mapper/mappers';

const rawId = 'group-read-integrity';
const id = toChatGroupId({ raw: rawId });
const key = `${STORAGE_KEY_PREFIX}lsp:chat_group:${rawId}`;
const chatGroup = { id, name: 'Saved chat group', items: [], updatedAt: 1, isCollapsed: false };
const valid = JSON.stringify({ id: rawId, name: chatGroup.name, updatedAt: 1, isCollapsed: false });

function createFile({ name, text }: { name: string, text: string }) {
  return { kind: 'file' as const, name, getFile: vi.fn(async () => new File([text], name)) };
}

function createDirectory({ name }: { name: string }) {
  const files = new Map<string, ReturnType<typeof createFile>>();
  return {
    kind: 'directory' as const,
    name,
    files,
    async *values() {
      yield* files.values();
    },
    getFileHandle: vi.fn(async (name: string) => {
      const file = files.get(name);
      if (file === undefined) {
        throw new DOMException('Missing file', 'NotFoundError');
      }
      return file;
    }),
  };
}

function installOpfs() {
  const groups = createDirectory({ name: 'chat-groups' });
  const metas = createDirectory({ name: 'chat-metas' });
  const storage = {
    ...createDirectory({ name: 'naidan-storage' }),
    getDirectoryHandle: vi.fn(async (name: string) => {
      switch (name) {
      case 'chat-groups': return groups;
      case 'chat-metas': return metas;
      default: throw new Error(`Unexpected directory: ${name}`);
      }
    }),
  };
  storage.files.set('migration-state.json', createFile({ name: 'migration-state.json', text: JSON.stringify({ completedMigrations: [{ name: 'v1_uploaded_files_to_binary_objects', completedAt: 1 }] }) }));
  storage.files.set('hierarchy.json', createFile({ name: 'hierarchy.json', text: JSON.stringify({ items: [] }) }));
  const root = { getDirectoryHandle: vi.fn(async () => storage) };
  const getDirectory = vi.fn(async () => root);
  vi.stubGlobal('navigator', { storage: { getDirectory } });
  return { groups, metas, storage, getDirectory };
}

beforeEach(() => localStorage.clear());

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

for (const backend of ['local', 'opfs'] as const) {
  describe(`${backend} chat group read integrity`, () => {
    async function setup() {
      switch (backend) {
      case 'local': return {
        provider: new LocalStorageProvider(),
        write: ({ text }: { text: string }) => {
          localStorage.setItem(key, text);
        },
        read: () => Promise.resolve(localStorage.getItem(key)),
      };
      case 'opfs': {
        const fs = installOpfs();
        const provider = new OPFSStorageProvider();
        await provider.init();
        return {
          provider,
          write: ({ text }: { text: string }) => {
            fs.groups.files.set(`${rawId}.json`, createFile({ name: `${rawId}.json`, text }));
          },
          read: async () => {
            const file = fs.groups.files.get(`${rawId}.json`);
            return file === undefined ? null : (await file.getFile()).text();
          },
        };
      }
      default: {
        const exhaustive: never = backend;
        throw new Error(String(exhaustive));
      }
      }
    }

    it('returns null for a missing group and reads a valid orphan without changing stored data', async () => {
      const { provider, write, read } = await setup();
      await expect(provider.loadChatGroup({ id })).resolves.toBeNull();
      write({ text: valid });
      await expect(provider.loadChatGroup({ id })).resolves.toMatchObject(chatGroup);
      expect(await read()).toBe(valid);
    });

    it.each(['', '{', 'null', JSON.stringify({ id: rawId })])('rejects malformed group data %j instead of returning absence', async text => {
      const { provider, write, read } = await setup();
      write({ text });
      await expect(provider.loadChatGroup({ id })).rejects.toThrow();
      expect(await read()).toBe(text);
    });

    it('propagates a failed related hierarchy read instead of claiming the group is absent', async () => {
      const { provider, write } = await setup();
      write({ text: valid });
      const error = new Error('Hierarchy unreadable');
      vi.spyOn(provider, 'loadHierarchy').mockRejectedValueOnce(error);
      await expect(provider.loadChatGroup({ id })).rejects.toBe(error);
    });
  });
}

it('keeps missing and failed in-memory group reads distinct', async () => {
  const provider = new MemoryStorageProvider();
  await expect(provider.loadChatGroup({ id })).resolves.toBeNull();
  await provider.saveChatGroup({ chatGroup });
  const error = new Error('Stored group could not be decoded');
  vi.spyOn(mappers, 'chatGroupToDomain').mockImplementationOnce(() => {
    throw error;
  });
  await expect(provider.loadChatGroup({ id })).rejects.toBe(error);
  await expect(provider.loadChatGroup({ id })).resolves.toMatchObject(chatGroup);
});

it.each(['NotAllowedError', 'NotReadableError', 'TypeMismatchError'])('propagates OPFS group lookup %s', async name => {
  const fs = installOpfs();
  const error = new DOMException('Unreadable group', name);
  fs.groups.getFileHandle.mockRejectedValue(error);
  const provider = new OPFSStorageProvider();
  await provider.init();
  await expect(provider.loadChatGroup({ id })).rejects.toBe(error);
});

it('does not turn a failed acquired group file read into a missing lookup', async () => {
  const fs = installOpfs();
  const file = createFile({ name: `${rawId}.json`, text: valid });
  fs.groups.files.set(file.name, file);
  const error = new DOMException('Disappeared after lookup', 'NotFoundError');
  file.getFile.mockRejectedValue(error);
  const provider = new OPFSStorageProvider();
  await provider.init();
  await expect(provider.loadChatGroup({ id })).rejects.toBe(error);
});

it('does not turn a failed storage root lookup into a missing group', async () => {
  const fs = installOpfs();
  const error = new DOMException('Storage unavailable', 'NotFoundError');
  fs.getDirectory.mockRejectedValue(error);
  await expect(new OPFSStorageProvider().loadChatGroup({ id })).rejects.toBe(error);
});

it('propagates LocalStorage group read failures without writing', async () => {
  const error = new DOMException('Storage denied', 'SecurityError');
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
    throw error;
  });
  const write = vi.spyOn(Storage.prototype, 'setItem');
  await expect(new LocalStorageProvider().loadChatGroup({ id })).rejects.toBe(error);
  expect(write).not.toHaveBeenCalled();
});
