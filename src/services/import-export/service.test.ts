import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ImportExportService, type IImportExportStorage } from './service';
import JSZip from 'jszip';
import type { SettingsDto, ChatMetaDto, ChatGroupDto } from '../../models/dto';
import type { ImportConfig } from './types';
import type { Mocked } from 'vitest';
import type { StorageSnapshot } from '../../models/types';

const UUID_G1 = '018d476a-7b3a-73fd-8000-000000000001';
const UUID_C1 = '018d476a-7b3a-73fd-8000-000000000002';
const UUID_C2 = '018d476a-7b3a-73fd-8000-000000000003';
const UUID_A1 = '018d476a-7b3a-73fd-8000-000000000004';
const UUID_M1 = '018d476a-7b3a-73fd-8000-000000000005';
const UUID_M2 = '018d476a-7b3a-73fd-8000-000000000006';
const NEW_UUID = '018d476a-7b3a-73fd-8000-ffffffffffff';

vi.mock('../../utils/id', () => ({
  generateId: vi.fn(() => NEW_UUID)
}));

vi.stubGlobal('crypto', {
  randomUUID: vi.fn(() => NEW_UUID)
});

vi.mock('../../composables/useGlobalEvents', () => ({
  useGlobalEvents: () => ({
    addErrorEvent: vi.fn()
  })
}));

describe('ImportExportService', () => {
  let mockStorage: Mocked<IImportExportStorage>;
  let service: ImportExportService;

  beforeEach(() => {
    mockStorage = {
      dumpWithoutLock: vi.fn(),
      restore: vi.fn(),
      clearAll: vi.fn(),
      loadSettings: vi.fn(),
      updateSettings: vi.fn().mockImplementation(async (updater) => {
        const current = await mockStorage.loadSettings();
        await updater(current);
      }),
      listChats: vi.fn(),
      listChatGroups: vi.fn(),
      loadHierarchy: vi.fn().mockResolvedValue({ items: [] }),
    } as any;
    service = new ImportExportService(mockStorage);
  });

  const createValidSettingsDto = (overrides: Partial<SettingsDto> = {}): SettingsDto => ({
    endpoint: { type: 'ollama', url: 'http://localhost:11434' },
    storageType: 'local',
    autoTitleEnabled: true,
    providerProfiles: [],
    ...overrides
  });

  const createValidChatMetaDto = (overrides: Partial<ChatMetaDto> = {}): ChatMetaDto => ({
    id: UUID_C1,
    title: 'Test Chat',
    updatedAt: 1000,
    createdAt: 1000,
    debugEnabled: false,
    ...overrides
  });

  describe('exportData', () => {
    it('handles empty storage gracefully and uses dumpWithoutLock', async () => {
      mockStorage.dumpWithoutLock.mockResolvedValue({
        structure: {
          settings: {
            endpointType: 'openai',
            endpointUrl: '',
            autoTitleEnabled: true,
            storageType: 'local',
            providerProfiles: []
          } as any,
          hierarchy: { items: [] },
          chatMetas: [],
          chatGroups: []
        },
        contentStream: (async function* () {})()
      });
      const { filename } = await service.exportData({});
      expect(filename).toMatch(/^naidan-data-\d{4}-\d{2}-\d{2}\.zip$/);
      expect(mockStorage.dumpWithoutLock).toHaveBeenCalled();
    });
  });

  describe('Import - Replace Mode', () => {
    it('wipes current data and calls restore() even with empty ZIP', async () => {
      const zip = new JSZip();
      zip.file('export-manifest.json', '{}');
      zip.file('chat-metas.json', JSON.stringify({ entries: [] }));

      const zipBlob = await zip.generateAsync({ type: 'blob' });
      const config: ImportConfig = {
        data: { mode: 'replace' },
        settings: { endpoint: 'none', model: 'none', titleModel: 'none', systemPrompt: 'none', lmParameters: 'none', providerProfiles: 'none' }
      };

      mockStorage.loadSettings.mockResolvedValue(null);
      await service.executeImport(zipBlob, config);

      expect(mockStorage.clearAll).toHaveBeenCalled();
      expect(mockStorage.restore).toHaveBeenCalledWith(expect.anything());
    });
  });

  describe('Import - Append Mode (ID Remapping)', () => {
    it('preserves timestamps but remaps IDs', async () => {
      const zip = new JSZip();
      zip.file('export-manifest.json', '{}');

      const ORIGINAL_TIME = 123456789;
      const chatMeta = createValidChatMetaDto({ id: UUID_C1, updatedAt: ORIGINAL_TIME, createdAt: ORIGINAL_TIME });
      zip.file('chat-metas.json', JSON.stringify({ entries: [chatMeta] }));
      zip.folder('chat-contents')!.file(`${UUID_C1}.json`, JSON.stringify({ root: { items: [] } }));

      const zipBlob = await zip.generateAsync({ type: 'blob' });
      await service.executeImport(zipBlob, { data: { mode: 'append' }, settings: { endpoint: 'none', model: 'none', titleModel: 'none', systemPrompt: 'none', lmParameters: 'none', providerProfiles: 'none' } });

      const calls = mockStorage.restore.mock.calls;
      const snapshot = calls[0]![0] as StorageSnapshot;
      const chunks = [];
      for await (const chunk of snapshot.contentStream) {
        chunks.push(chunk);
      }

      const chatChunk = chunks.find(c => c.type === 'chat');
      if (chatChunk?.type === 'chat') {
        expect(chatChunk.data.id).toBe(NEW_UUID);
        expect(chatChunk.data.updatedAt).toBe(ORIGINAL_TIME);
        expect(chatChunk.data.createdAt).toBe(ORIGINAL_TIME);
      }
    });

    it('should remap IDs in deep branches and preserve attachments association', async () => {
      const zip = new JSZip();
      zip.file('export-manifest.json', '{}');
      const now = 1000;
      const chatMeta = createValidChatMetaDto({ id: UUID_C1 });
      zip.file('chat-metas.json', JSON.stringify({ entries: [chatMeta] }));

      const content = {
        root: {
          items: [{
            id: UUID_M1, role: 'user', content: 'hello', timestamp: now,
            replies: {
              items: [{
                id: UUID_M2, role: 'assistant', content: 'response', timestamp: now + 100,
                attachments: [{
                  id: UUID_A1, binaryObjectId: UUID_A1, name: 'img.png', status: 'persisted'
                }],
                replies: { items: [] }
              }]
            }
          }]
        }
      };
      zip.folder('chat-contents')!.file(`${UUID_C1}.json`, JSON.stringify(content));

      const shard = UUID_A1.slice(-2);
      const binFolder = zip.folder('binary-objects')!.folder(shard);
      binFolder!.file(`${UUID_A1}.bin`, new Blob(['...']));
      binFolder!.file('index.json', JSON.stringify({
        objects: {
          [UUID_A1]: { id: UUID_A1, mimeType: 'image/png', size: 100, createdAt: now, name: 'img.png' }
        }
      }));

      await service.executeImport(await zip.generateAsync({ type: 'blob' }), {
        data: { mode: 'append' },
        settings: { endpoint: 'none', model: 'none', titleModel: 'none', systemPrompt: 'none', lmParameters: 'none', providerProfiles: 'none' }
      });

      const calls = mockStorage.restore.mock.calls;
      const snapshot = calls[0]![0] as StorageSnapshot;
      const chunks = [];
      for await (const chunk of snapshot.contentStream) {
        chunks.push(chunk);
      }

      const chatChunk = chunks.find(c => c.type === 'chat');
      if (chatChunk?.type === 'chat' && chatChunk.data.root) {
        const nestedNode = chatChunk.data.root.items[0]!.replies.items[0];
        expect(nestedNode!.attachments![0]!.id).toBe(NEW_UUID);
      }
      expect(chunks.find(c => c.type === 'binary_object')?.id).toBe(NEW_UUID);
    });

    it('applies prefixes to both chat titles and group names', async () => {
      const zip = new JSZip();
      zip.file('export-manifest.json', '{}');

      const groupDto: ChatGroupDto = { id: UUID_G1, name: 'General', updatedAt: 1000, isCollapsed: false };
      zip.folder('chat-groups')!.file(`${UUID_G1}.json`, JSON.stringify(groupDto));

      const chatMeta = createValidChatMetaDto({ id: UUID_C1, title: 'Old Title' });
      zip.file('chat-metas.json', JSON.stringify({ entries: [chatMeta] }));
      zip.folder('chat-contents')!.file(`${UUID_C1}.json`, JSON.stringify({ root: { items: [] } }));

      await service.executeImport(await zip.generateAsync({ type: 'blob' }), {
        data: { mode: 'append', chatTitlePrefix: '[Chat] ', chatGroupNamePrefix: '[Group] ' },
        settings: { endpoint: 'none', model: 'none', titleModel: 'none', systemPrompt: 'none', lmParameters: 'none', providerProfiles: 'none' }
      });

      const calls = mockStorage.restore.mock.calls;
      const snapshot = calls[0]![0] as StorageSnapshot;
      const chunks = [];
      for await (const chunk of snapshot.contentStream) {
        chunks.push(chunk);
      }

      expect(snapshot.structure.chatGroups.find(g => g.name === '[Group] General')).toBeDefined();
      expect(chunks.find(c => c.type === 'chat')?.data.title).toBe('[Chat] Old Title');
    });

    it('does NOT call clearAll and preserves existing hierarchy during append', async () => {
      const zip = new JSZip();
      zip.file('export-manifest.json', '{}');
      zip.file('chat-metas.json', JSON.stringify({ entries: [] }));
      const zipBlob = await zip.generateAsync({ type: 'blob' });

      // Mock existing storage state
      const existingHierarchy = { items: [{ type: 'chat', id: 'existing-chat' }] };
      mockStorage.loadHierarchy.mockResolvedValue(existingHierarchy as any);

      await service.executeImport(zipBlob, {
        data: { mode: 'append' },
        settings: { endpoint: 'none', model: 'none', titleModel: 'none', systemPrompt: 'none', lmParameters: 'none', providerProfiles: 'none' }
      });

      expect(mockStorage.clearAll).not.toHaveBeenCalled();

      // Verify that the hierarchy sent to restore contains the existing item
      const snapshot = mockStorage.restore.mock.calls[0]![0] as StorageSnapshot;
      expect(snapshot.structure.hierarchy.items).toContainEqual({ type: 'chat', id: 'existing-chat' });
    });
  });

  describe('Settings Merge - Edge Cases', () => {
    it('correctly merges complex lmParameters objects', async () => {
      const zip = new JSZip();
      zip.file('export-manifest.json', '{}');
      zip.file('settings.json', JSON.stringify(createValidSettingsDto({
        lmParameters: { temperature: 0.1, stop: ['ZIP'] }
      })));

      const zipBlob = await zip.generateAsync({ type: 'blob' });
      mockStorage.loadSettings.mockResolvedValue({
        endpointType: 'ollama',
        lmParameters: { temperature: 0.9, maxCompletionTokens: 500, stop: ['OLD'] }
      } as any);

      const config: ImportConfig = {
        data: { mode: 'append' },
        settings: { endpoint: 'none', model: 'none', titleModel: 'none', systemPrompt: 'none', lmParameters: 'replace', providerProfiles: 'none' }
      };

      await service.executeImport(zipBlob, config);

      expect(mockStorage.updateSettings).toHaveBeenCalled();
      const updater = mockStorage.updateSettings.mock.calls[0]![0];
      const result = await updater(await mockStorage.loadSettings());
      expect(result).toEqual(expect.objectContaining({
        lmParameters: {
          temperature: 0.1,
          stop: ['ZIP']
        }
      }));
    });

    it('regenerates IDs for provider profiles when using append strategy', async () => {
      const zip = new JSZip();
      zip.file('export-manifest.json', '{}');
      zip.file('settings.json', JSON.stringify(createValidSettingsDto({
        providerProfiles: [{ id: UUID_G1, name: 'Imported', endpoint: { type: 'ollama', url: 'http://localhost:11434' } } as any]
      })));

      mockStorage.loadSettings.mockResolvedValue({
        endpointType: 'ollama',
        storageType: 'local',
        providerProfiles: [{ id: '018d476a-7b3a-73fd-8000-000000000009', name: 'Existing', endpointType: 'openai', endpointUrl: '' }]
      } as any);

      await service.executeImport(await zip.generateAsync({ type: 'blob' }), {
        data: { mode: 'replace' },
        settings: { endpoint: 'none', model: 'none', titleModel: 'none', systemPrompt: 'none', lmParameters: 'none', providerProfiles: 'append' }
      });

      expect(mockStorage.updateSettings).toHaveBeenCalled();
      const updater = mockStorage.updateSettings.mock.calls[0]![0];
      const result = await updater(await mockStorage.loadSettings());
      expect(result).toEqual(expect.objectContaining({
        providerProfiles: [
          expect.objectContaining({ id: '018d476a-7b3a-73fd-8000-000000000009' }),
          expect.objectContaining({ id: NEW_UUID, name: 'Imported' })
        ]
      }));
    });
  });

  describe('analyze() - Preview', () => {
    it('returns empty stats for empty ZIP', async () => {
      const zip = new JSZip();
      zip.file('export-manifest.json', '{}');
      const zipBlob = await zip.generateAsync({ type: 'blob' });
      const preview = await service.analyze(zipBlob);
      expect(preview.stats.chatsCount).toBe(0);
      expect(preview.stats.hasSettings).toBe(false);
    });

    it('correctly builds complex hierarchy and counts while skipping malformed entries', async () => {
      const zip = new JSZip();
      const now = Date.now();
      zip.file('export-manifest.json', JSON.stringify({ app_version: '1.0' }));

      zip.folder('chat-groups')!.file(`${UUID_G1}.json`, JSON.stringify({ id: UUID_G1, name: 'G1', updatedAt: now, isCollapsed: false }));
      zip.file('chat-metas.json', JSON.stringify({ entries: [
        { id: UUID_C1, title: 'C1', groupId: UUID_G1, updatedAt: now, createdAt: now },
        { id: UUID_C2, title: 'C2', groupId: null, updatedAt: now, createdAt: now },
        { id: 'invalid-uuid', title: 'Broken' }
      ] }));

      // Add a binary object in a shard
      const shard = UUID_A1.slice(-2);
      zip.folder('binary-objects')!.folder(shard)!.file(`${UUID_A1}.bin`, new Blob(['...']));

      const preview = await service.analyze(await zip.generateAsync({ type: 'blob' }));

      expect(preview.stats.chatsCount).toBe(2); // Broken is skipped
      expect(preview.stats.attachmentsCount).toBe(1);
      expect(preview.items).toHaveLength(2); // Group 1 and Root Chat C2
      const groupItem = preview.items.find(i => i.type === 'chat_group');
      if (groupItem?.type === 'chat_group') {
        expect(groupItem.data.items).toHaveLength(1);
        expect(groupItem.data.items[0]!.title).toBe('C1');
      }
    });
  });
});