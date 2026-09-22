import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LocalStorageProvider } from './local-storage';
import { OPFSStorageProvider } from './opfs-storage';
import { STORAGE_KEY_PREFIX } from '@/constants';
import { toChatId } from '@/01-models/ids';

const rawId = 'read-integrity';
const id = toChatId({ raw: rawId });
const contentKey = `${STORAGE_KEY_PREFIX}lsp:chat_content:${rawId}`;
const metaKey = `${STORAGE_KEY_PREFIX}lsp:chat_meta:${rawId}`;
const meta = JSON.stringify({ id: rawId, title: 'Saved chat', createdAt: 0, updatedAt: 1, debugEnabled: false });
const content = JSON.stringify({ root: { items: [{ id: 'answer', role: 'assistant', createdAt: 0,
  parts: [{ type: 'text', text: `\
  <think>原文</think>\\r
🙂`, completeness: 'partial' }],
  interruption: { type: 'cancelled' }, replies: { items: [] } }] }, currentLeafId: 'answer' });
const invalidContents = [
  '',
  '{',
  'null',
  JSON.stringify({ root: { items: [{ id: 'a', role: 'assistant', timestamp: 0, content: 'Legacy-looking', parts: null, replies: { items: [] } }] } }),
  JSON.stringify({ root: { items: [{ id: 'a', role: 'assistant', createdAt: 0, parts: [{ id: 'p', type: 'future_part', text: 'Do not delete' }], replies: { items: [] } }] } }),
];

function createFile({ name, text }: { name: string; text: string }) {
  return { kind: 'file' as const, name, getFile: vi.fn(async () => new File([text], name)) };
}

function createDirectory({ name }: { name: string }) {
  const files = new Map<string, ReturnType<typeof createFile>>();
  return {
    kind: 'directory' as const, name, files,
    getFileHandle: vi.fn(async (fileName: string) => {
      const file = files.get(fileName);
      if (!file) throw new DOMException('Missing file', 'NotFoundError');
      return file;
    }),
  };
}

function installOpfs() {
  const contentDirectory = createDirectory({ name: 'chat-contents' });
  const metaDirectory = createDirectory({ name: 'chat-metas' });
  const storage = {
    ...createDirectory({ name: 'naidan-storage' }),
    getDirectoryHandle: vi.fn(async (name: string) => {
      if (name === 'chat-contents') return contentDirectory;
      if (name === 'chat-metas') return metaDirectory;
      throw new Error(`Unexpected directory: ${name}`);
    }),
  };
  storage.files.set('migration-state.json', createFile({ name: 'migration-state.json', text: JSON.stringify({ completedMigrations: [{ name: 'v1_uploaded_files_to_binary_objects', completedAt: 1 }] }) }));
  storage.files.set('hierarchy.json', createFile({ name: 'hierarchy.json', text: '{"items":[]}' }));
  const root = { getDirectoryHandle: vi.fn(async () => storage) };
  const getDirectory = vi.fn(async () => root);
  vi.stubGlobal('navigator', { storage: { getDirectory } });
  return { contentDirectory, metaDirectory, storage, getDirectory };
}

beforeEach(() => {
  localStorage.clear();
});
afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});

for (const backend of ['local', 'opfs'] as const) {
  describe(`${backend} chat read integrity`, () => {
    async function setup() {
      if (backend === 'local') {
        return {
          provider: new LocalStorageProvider(),
          write: ({ kind, value }: { kind: 'content' | 'meta'; value: string }) => localStorage.setItem(kind === 'content' ? contentKey : metaKey, value),
          read: ({ kind }: { kind: 'content' | 'meta' }) => Promise.resolve(localStorage.getItem(kind === 'content' ? contentKey : metaKey)),
        };
      }
      const fs = installOpfs();
      const provider = new OPFSStorageProvider(); await provider.init();
      return {
        provider,
        write: ({ kind, value }: { kind: 'content' | 'meta'; value: string }) => {
          const name = `${rawId}.json`;
          (kind === 'content' ? fs.contentDirectory : fs.metaDirectory).files.set(name, createFile({ name, text: value }));
        },
        read: async ({ kind }: { kind: 'content' | 'meta' }) => {
          const file = (kind === 'content' ? fs.contentDirectory : fs.metaDirectory).files.get(`${rawId}.json`);
          return file ? (await file.getFile()).text() : null;
        },
      };
    }

    it('returns null only when the requested record does not exist', async () => {
      const { provider } = await setup();
      expect(await provider.loadChatContent({ id })).toBeNull();
      expect(await provider.loadChatContentWithoutAttachments({ id })).toBeNull();
      expect(await provider.loadChatMeta({ id })).toBeNull();
      expect(await provider.loadChat({ id })).toBeNull();
    });

    for (const [index, raw] of invalidContents.entries()) {
      it(`rejects invalid content ${index} without treating it as an absent chat`, async () => {
        const { provider, write, read } = await setup();
        write({ kind: 'meta', value: meta }); write({ kind: 'content', value: raw });
        await expect(provider.loadChatContent({ id })).rejects.toThrow();
        await expect(provider.loadChatContentWithoutAttachments({ id })).rejects.toThrow();
        await expect(provider.loadChat({ id })).rejects.toThrow();
        expect(await read({ kind: 'content' })).toBe(raw);
        expect((await provider.loadChatMeta({ id }))?.title).toBe('Saved chat');
        // Repairing the original bytes makes the same provider usable again.
        write({ kind: 'content', value: content });
        const loaded = await provider.loadChat({ id });
        expect(loaded?.root.items[0]).toMatchObject({ parts: [{ text: `\
  <think>原文</think>\\r
🙂`, completeness: 'partial' }], interruption: { type: 'cancelled' } });
      });
    }

    for (const raw of ['', '{', '{"id":"incomplete"}']) {
      it(`propagates malformed metadata ${JSON.stringify(raw)} and keeps content readable`, async () => {
        const { provider, write, read } = await setup();
        write({ kind: 'meta', value: raw }); write({ kind: 'content', value: content });
        await expect(provider.loadChatMeta({ id })).rejects.toThrow();
        await expect(provider.loadChat({ id })).rejects.toThrow();
        expect((await provider.loadChatContent({ id }))?.root.items[0]?.parts).toHaveLength(1);
        expect(await read({ kind: 'meta' })).toBe(raw);
      });
    }

    for (const kind of ['content', 'meta'] as const) {
      it(`does not hide malformed ${kind} when the other record is missing`, async () => {
        const { provider, write, read } = await setup();
        write({ kind, value: '{' });
        await expect(provider.loadChat({ id })).rejects.toThrow();
        expect(await read({ kind })).toBe('{');
      });
      it(`keeps a valid orphaned ${kind} unchanged`, async () => {
        const { provider, write, read } = await setup();
        const value = kind === 'meta' ? meta : content;
        write({ kind, value });
        expect(await provider.loadChat({ id })).toBeNull();
        expect(await read({ kind })).toBe(value);
      });
    }

    it('reads legacy content without writing or completing its migration', async () => {
      const { provider, write, read } = await setup();
      const legacy = JSON.stringify({ root: { items: [{ id: 'old', role: 'assistant', timestamp: 7,
        thinking: '  Thought ', content: '<think>literal</think> [Generation Aborted]', replies: { items: [] } }] } });
      write({ kind: 'meta', value: meta }); write({ kind: 'content', value: legacy });
      const loaded = await provider.loadChatContentWithoutAttachments({ id });
      expect(loaded?.root.items[0]).toMatchObject({ createdAt: 7, parts: [
        { type: 'reasoning', text: '  Thought ', completeness: 'complete' },
        { type: 'text', text: '<think>literal</think> [Generation Aborted]', completeness: 'complete' },
      ] });
      expect(await read({ kind: 'content' })).toBe(legacy);
    });

    it('continues accepting additional known-shape fields without tightening DTO validation', async () => {
      const { provider, write, read } = await setup();
      const raw = JSON.stringify({ ...JSON.parse(content), extra_metadata: { keep: 'original bytes' } });
      write({ kind: 'content', value: raw });
      expect(await provider.loadChatContent({ id })).not.toBeNull();
      expect(await read({ kind: 'content' })).toBe(raw);
    });
  });
}

for (const name of ['NotAllowedError', 'NotReadableError', 'TypeMismatchError']) {
  it(`propagates OPFS file lookup ${name}`, async () => {
    const fs = installOpfs(); const error = new DOMException('Unreadable', name);
    fs.contentDirectory.getFileHandle.mockRejectedValue(error);
    const provider = new OPFSStorageProvider(); await provider.init();
    await expect(provider.loadChatContent({ id })).rejects.toBe(error);
    await expect(provider.loadChatContentWithoutAttachments({ id })).rejects.toBe(error);
  });
}

it('does not mistake a removed or unreadable acquired file for a missing lookup', async () => {
  const fs = installOpfs(); const file = createFile({ name: `${rawId}.json`, text: content });
  fs.contentDirectory.files.set(file.name, file);
  const error = new DOMException('Disappeared after lookup', 'NotFoundError');
  file.getFile.mockRejectedValue(error);
  const provider = new OPFSStorageProvider(); await provider.init();
  await expect(provider.loadChatContent({ id })).rejects.toBe(error);
});

it('does not interpret failure to acquire the storage directory as a missing chat', async () => {
  const fs = installOpfs(); const error = new DOMException('Root unavailable', 'NotFoundError');
  fs.getDirectory.mockRejectedValue(error);
  await expect(new OPFSStorageProvider().loadChatContent({ id })).rejects.toBe(error);
});

it('propagates LocalStorage read failures without writing', async () => {
  const error = new DOMException('Storage denied', 'SecurityError');
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
    throw error;
  });
  const write = vi.spyOn(Storage.prototype, 'setItem');
  await expect(new LocalStorageProvider().loadChatContent({ id })).rejects.toBe(error);
  expect(write).not.toHaveBeenCalled();
});
