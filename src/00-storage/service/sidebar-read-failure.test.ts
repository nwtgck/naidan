import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LocalStorageProvider } from './local-storage';
import { OPFSStorageProvider } from './opfs-storage';
import { STORAGE_KEY_PREFIX } from '@/constants';

type RecordKind = 'hierarchy' | 'chat-meta' | 'chat-group';
const rawChatId = 'sidebar-saved-chat';
const rawChatGroupId = 'sidebar-saved-group';
const savedHierarchy = JSON.stringify({
  items: [
    { type: 'chat', id: rawChatId },
    { type: 'chat_group', id: rawChatGroupId, chat_ids: [] },
  ],
});
const savedChatMeta = JSON.stringify({ id: rawChatId, title: 'Saved chat', updatedAt: 1, createdAt: 1 });
const savedChatGroup = JSON.stringify({ id: rawChatGroupId, name: 'Saved group', updatedAt: 1, isCollapsed: false });

function createFile({ name, text }: { name: string, text: string }) {
  return { kind: 'file' as const, name, getFile: vi.fn(async () => new File([text], name)) };
}

function createDirectory({ name }: { name: string }) {
  const files = new Map<string, ReturnType<typeof createFile>>();
  return {
    kind: 'directory' as const,
    name,
    files,
    values: vi.fn(async function* () {
      yield* files.values();
    }),
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
  const metas = createDirectory({ name: 'chat-metas' });
  const chatGroups = createDirectory({ name: 'chat-groups' });
  const storage = {
    ...createDirectory({ name: 'naidan-storage' }),
    getDirectoryHandle: vi.fn(async (name: string) => {
      switch (name) {
      case 'chat-metas': return metas;
      case 'chat-groups': return chatGroups;
      default: throw new Error(`Unexpected directory: ${name}`);
      }
    }),
  };
  const getDirectory = vi.fn(async () => ({ getDirectoryHandle: vi.fn(async () => storage) }));
  vi.stubGlobal('navigator', { storage: { getDirectory } });
  return { metas, chatGroups, storage, getDirectory };
}

function localRecordKey({ record }: { record: RecordKind }) {
  switch (record) {
  case 'hierarchy': return `${STORAGE_KEY_PREFIX}lsp:hierarchy`;
  case 'chat-meta': return `${STORAGE_KEY_PREFIX}lsp:chat_meta:${rawChatId}`;
  case 'chat-group': return `${STORAGE_KEY_PREFIX}lsp:chat_group:${rawChatGroupId}`;
  default: {
    const exhaustive: never = record;
    throw new Error(String(exhaustive));
  }
  }
}

function setup({ backend }: { backend: 'local' | 'opfs' }) {
  switch (backend) {
  case 'local': return {
    provider: new LocalStorageProvider(),
    write: ({ record, text }: { record: RecordKind, text: string }) => {
      localStorage.setItem(localRecordKey({ record }), text);
    },
    read: ({ record }: { record: RecordKind }) => Promise.resolve(localStorage.getItem(localRecordKey({ record }))),
  };
  case 'opfs': {
    const fs = installOpfs();
    function locate({ record }: { record: RecordKind }) {
      switch (record) {
      case 'hierarchy': return { directory: fs.storage, name: 'hierarchy.json' };
      case 'chat-meta': return { directory: fs.metas, name: `${rawChatId}.json` };
      case 'chat-group': return { directory: fs.chatGroups, name: `${rawChatGroupId}.json` };
      default: {
        const exhaustive: never = record;
        throw new Error(String(exhaustive));
      }
      }
    }
    return {
      provider: new OPFSStorageProvider(),
      write: ({ record, text }: { record: RecordKind, text: string }) => {
        const { directory, name } = locate({ record });
        directory.files.set(name, createFile({ name, text }));
      },
      read: async ({ record }: { record: RecordKind }) => {
        const { directory, name } = locate({ record });
        const file = directory.files.get(name);
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

beforeEach(() => localStorage.clear());

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

for (const backend of ['local', 'opfs'] as const) {
  describe(`${backend} sidebar read integrity`, () => {
    it('treats a missing hierarchy as empty and reads saved chat and empty chat group records', async () => {
      const { provider, write } = setup({ backend });
      await expect(provider.getSidebarStructure()).resolves.toEqual([]);
      write({ record: 'hierarchy', text: savedHierarchy });
      write({ record: 'chat-meta', text: savedChatMeta });
      write({ record: 'chat-group', text: savedChatGroup });
      await expect(provider.getSidebarStructure()).resolves.toMatchObject([
        { type: 'chat', chat: { title: 'Saved chat' } },
        { type: 'chat_group', chatGroup: { name: 'Saved group', items: [] } },
      ]);
    });

    for (const record of ['hierarchy', 'chat-meta', 'chat-group'] as const) {
      it.each(['', '{', 'null', '{}'])(`rejects malformed ${record} %j without changing saved records`, async text => {
        const { provider, write, read } = setup({ backend });
        write({ record: 'hierarchy', text: savedHierarchy });
        write({ record: 'chat-meta', text: savedChatMeta });
        write({ record: 'chat-group', text: savedChatGroup });
        write({ record, text });
        await expect(provider.getSidebarStructure()).rejects.toThrow();
        expect(await read({ record })).toBe(text);
        expect(await read({ record: 'hierarchy' })).toBe(record === 'hierarchy' ? text : savedHierarchy);
      });
    }
  });
}

it.each(['NotAllowedError', 'NotReadableError', 'TypeMismatchError'])('propagates OPFS hierarchy lookup %s', async name => {
  const fs = installOpfs();
  const error = new DOMException('Hierarchy unavailable', name);
  fs.storage.getFileHandle.mockRejectedValue(error);
  await expect(new OPFSStorageProvider().getSidebarStructure()).rejects.toBe(error);
});

it('does not treat a failed acquired hierarchy file read as a missing lookup', async () => {
  const fs = installOpfs();
  const file = createFile({ name: 'hierarchy.json', text: savedHierarchy });
  fs.storage.files.set(file.name, file);
  const error = new DOMException('Disappeared after lookup', 'NotFoundError');
  file.getFile.mockRejectedValue(error);
  await expect(new OPFSStorageProvider().getSidebarStructure()).rejects.toBe(error);
  file.getFile.mockRestore();
  expect(await (await file.getFile()).text()).toBe(savedHierarchy);
});

for (const collection of ['metas', 'chatGroups'] as const) {
  it(`propagates OPFS ${collection} enumeration failures instead of reporting empty history`, async () => {
    const fs = installOpfs();
    const error = new DOMException('Directory unreadable', 'NotReadableError');
    fs[collection].values.mockImplementation(async function* () {
      yield createFile({ name: 'saved.json', text: collection === 'metas' ? savedChatMeta : savedChatGroup });
      throw error;
    });
    await expect(new OPFSStorageProvider().getSidebarStructure()).rejects.toBe(error);
  });

  it(`propagates OPFS ${collection} file read failures instead of silently omitting saved records`, async () => {
    const fs = installOpfs();
    const file = createFile({ name: 'saved.json', text: collection === 'metas' ? savedChatMeta : savedChatGroup });
    fs[collection].files.set(file.name, file);
    const error = new DOMException('File unreadable', 'NotReadableError');
    file.getFile.mockRejectedValue(error);
    await expect(new OPFSStorageProvider().getSidebarStructure()).rejects.toBe(error);
  });
}

it('does not treat a failed OPFS storage root lookup as empty history', async () => {
  const fs = installOpfs();
  const error = new DOMException('Storage unavailable', 'NotFoundError');
  fs.getDirectory.mockRejectedValue(error);
  await expect(new OPFSStorageProvider().getSidebarStructure()).rejects.toBe(error);
});

it('propagates LocalStorage read failures without writing', async () => {
  const error = new DOMException('Storage denied', 'SecurityError');
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
    throw error;
  });
  const write = vi.spyOn(Storage.prototype, 'setItem');
  await expect(new LocalStorageProvider().getSidebarStructure()).rejects.toBe(error);
  expect(write).not.toHaveBeenCalled();
});
