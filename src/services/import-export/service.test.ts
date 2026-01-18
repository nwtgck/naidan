import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ImportExportService, type IImportExportStorage } from './service';
import JSZip from 'jszip';
import type { SettingsDto, ChatMetaDto, ChatGroupDto } from '../../models/dto';
import type { ImportConfig } from './types';
import type { Mocked } from 'vitest';

const UUID_G1 = '018d476a-7b3a-73fd-8000-000000000001';
const UUID_C1 = '018d476a-7b3a-73fd-8000-000000000002';
const UUID_C2 = '018d476a-7b3a-73fd-8000-000000000003';
const UUID_A1 = '018d476a-7b3a-73fd-8000-000000000004';
const UUID_M1 = '018d476a-7b3a-73fd-8000-000000000005';
const UUID_M2 = '018d476a-7b3a-73fd-8000-000000000006';
const NEW_UUID = '018d476a-7b3a-73fd-8000-ffffffffffff';

vi.mock('uuid', () => ({
  v7: vi.fn(() => NEW_UUID)
}));

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
      saveSettings: vi.fn(),
      listChats: vi.fn(),
      listChatGroups: vi.fn(),
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
    order: 0,
    debugEnabled: false,
    ...overrides
  });

  describe('exportData', () => {
    it('handles empty storage gracefully and uses dumpWithoutLock', async () => {
      mockStorage.dumpWithoutLock.mockImplementation(async function* () { /* yields nothing */ });
      const { filename } = await service.exportData({});
      expect(filename).toMatch(/^naidan_data_\d{4}-\d{2}-\d{2}\.zip$/);
      expect(mockStorage.dumpWithoutLock).toHaveBeenCalled();
    });
  });

  describe('Import - Replace Mode', () => {
    it('wipes current data and calls restore() even with empty ZIP', async () => {
      const zip = new JSZip();
      zip.file('export_manifest.json', '{}');
      zip.file('chat_metas.json', JSON.stringify({ entries: [] }));
      
      const zipBlob = await zip.generateAsync({ type: 'blob' });
      const config: ImportConfig = {
        data: { mode: 'replace' },
        settings: { endpoint: 'none', model: 'none', titleModel: 'none', systemPrompt: 'none', lmParameters: 'none', providerProfiles: 'none' }
      };

      mockStorage.loadSettings.mockResolvedValue(null);
      await service.executeImport(zipBlob, config);

      expect(mockStorage.clearAll).toHaveBeenCalled();
      expect(mockStorage.restore).toHaveBeenCalled();
    });
  });

  describe('Import - Append Mode (ID Remapping)', () => {
    it('preserves timestamps but remaps IDs', async () => {
      const zip = new JSZip();
      zip.file('export_manifest.json', '{}');
      
      const ORIGINAL_TIME = 123456789;
      const chatMeta = createValidChatMetaDto({ id: UUID_C1, updatedAt: ORIGINAL_TIME, createdAt: ORIGINAL_TIME });
      zip.file('chat_metas.json', JSON.stringify({ entries: [chatMeta] }));
      zip.folder('chat_contents')!.file(`${UUID_C1}.json`, JSON.stringify({ root: { items: [] } }));

      const zipBlob = await zip.generateAsync({ type: 'blob' });
      await service.executeImport(zipBlob, { data: { mode: 'append' }, settings: { endpoint: 'none', model: 'none', titleModel: 'none', systemPrompt: 'none', lmParameters: 'none', providerProfiles: 'none' } });

      const calls = mockStorage.restore.mock.calls;
      const generator = calls[0]![0];
      const chunks = [];
      for await (const chunk of generator) { chunks.push(chunk); }

      const chatChunk = chunks.find(c => c.type === 'chat');
      if (chatChunk?.type === 'chat') {
        expect(chatChunk.data.id).toBe(NEW_UUID);
        expect(chatChunk.data.updatedAt).toBe(ORIGINAL_TIME);
        expect(chatChunk.data.createdAt).toBe(ORIGINAL_TIME);
      }
    });

    it('should remap IDs in deep branches and preserve attachments association', async () => {
      const zip = new JSZip();
      zip.file('export_manifest.json', '{}');
      const now = 1000;
      const chatMeta = createValidChatMetaDto({ id: UUID_C1 });
      zip.file('chat_metas.json', JSON.stringify({ entries: [chatMeta] }));
      
      const content = {
        root: {
          items: [{
            id: UUID_M1, role: 'user', content: 'hello', timestamp: now,
            replies: {
              items: [{
                id: UUID_M2, role: 'assistant', content: 'response', timestamp: now + 100,
                attachments: [{ 
                  id: UUID_A1, originalName: 'img.png', mimeType: 'image/png', 
                  size: 100, uploadedAt: now, status: 'persisted' 
                }],
                replies: { items: [] }
              }]
            }
          }]
        }
      };
      zip.folder('chat_contents')!.file(`${UUID_C1}.json`, JSON.stringify(content));
      zip.folder('uploaded_files')!.folder(UUID_A1)!.file('img.png', new Blob(['...']));

      await service.executeImport(await zip.generateAsync({ type: 'blob' }), {
        data: { mode: 'append' },
        settings: { endpoint: 'none', model: 'none', titleModel: 'none', systemPrompt: 'none', lmParameters: 'none', providerProfiles: 'none' }
      });

      const generator = mockStorage.restore.mock.calls[0]![0];
      const chunks = [];
      for await (const chunk of generator) { chunks.push(chunk); }

      const chatChunk = chunks.find(c => c.type === 'chat');
      if (chatChunk?.type === 'chat' && chatChunk.data.root) {
        const nestedNode = chatChunk.data.root.items[0]!.replies.items[0];
        expect(nestedNode!.attachments![0]!.id).toBe(NEW_UUID);
      }
      expect(chunks.find(c => c.type === 'attachment')?.attachmentId).toBe(NEW_UUID);
    });

    it('applies prefixes to both chat titles and group names', async () => {
      const zip = new JSZip();
      zip.file('export_manifest.json', '{}');
      
      const groupDto: ChatGroupDto = { id: UUID_G1, name: 'General', order: 0, updatedAt: 1000, isCollapsed: false };
      zip.folder('chat_groups')!.file(`${UUID_G1}.json`, JSON.stringify(groupDto));
      
      const chatMeta = createValidChatMetaDto({ id: UUID_C1, title: 'Old Title', groupId: UUID_G1 });
      zip.file('chat_metas.json', JSON.stringify({ entries: [chatMeta] }));
      zip.folder('chat_contents')!.file(`${UUID_C1}.json`, JSON.stringify({ root: { items: [] } }));

      await service.executeImport(await zip.generateAsync({ type: 'blob' }), {
        data: { mode: 'append', chatTitlePrefix: '[Chat] ', chatGroupNamePrefix: '[Group] ' },
        settings: { endpoint: 'none', model: 'none', titleModel: 'none', systemPrompt: 'none', lmParameters: 'none', providerProfiles: 'none' }
      });

      const generator = mockStorage.restore.mock.calls[0]![0];
      const chunks = [];
      for await (const chunk of generator) { chunks.push(chunk); }

      expect(chunks.find(c => c.type === 'chat_group')?.data.name).toBe('[Group] General');
      expect(chunks.find(c => c.type === 'chat')?.data.title).toBe('[Chat] Old Title');
    });
  });

  describe('Settings Merge - Edge Cases', () => {
    it('correctly merges complex lmParameters objects', async () => {
      const zip = new JSZip();
      zip.file('export_manifest.json', '{}');
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

      expect(mockStorage.saveSettings).toHaveBeenCalledWith(expect.objectContaining({
        lmParameters: {
          temperature: 0.1,
          stop: ['ZIP']
        }
      }));
    });

    it('regenerates IDs for provider profiles when using append strategy', async () => {
      const zip = new JSZip();
      zip.file('export_manifest.json', '{}');
      zip.file('settings.json', JSON.stringify(createValidSettingsDto({
        providerProfiles: [{ id: UUID_G1, name: 'Imported', endpoint: { type: 'ollama' } } as any]
      })));

      mockStorage.loadSettings.mockResolvedValue({
        endpointType: 'ollama',
        storageType: 'local',
        providerProfiles: [{ id: '018d476a-7b3a-73fd-8000-000000000009', name: 'Existing', endpoint: { type: 'openai' } }]
      } as any);

      await service.executeImport(await zip.generateAsync({ type: 'blob' }), {
        data: { mode: 'replace' },
        settings: { endpoint: 'none', model: 'none', titleModel: 'none', systemPrompt: 'none', lmParameters: 'none', providerProfiles: 'append' }
      });

      expect(mockStorage.saveSettings).toHaveBeenCalledWith(expect.objectContaining({
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
      zip.file('export_manifest.json', '{}');
      const zipBlob = await zip.generateAsync({ type: 'blob' });
      const preview = await service.analyze(zipBlob);
      expect(preview.stats.chatsCount).toBe(0);
      expect(preview.stats.hasSettings).toBe(false);
    });

    it('correctly builds complex hierarchy and counts while skipping malformed entries', async () => {
      const zip = new JSZip();
      const now = Date.now();
      zip.file('export_manifest.json', JSON.stringify({ app_version: '1.0' }));
      
      zip.folder('chat_groups')!.file(`${UUID_G1}.json`, JSON.stringify({ id: UUID_G1, name: 'G1', order: 0, updatedAt: now, isCollapsed: false }));
      zip.file('chat_metas.json', JSON.stringify({ entries: [
        { id: UUID_C1, title: 'C1', groupId: UUID_G1, order: 0, updatedAt: now, createdAt: now },
        { id: UUID_C2, title: 'C2', groupId: null, order: 1, updatedAt: now, createdAt: now },
        { id: 'invalid-uuid', title: 'Broken' }
      ] }));
      
      const preview = await service.analyze(await zip.generateAsync({ type: 'blob' }));
      
      expect(preview.stats.chatsCount).toBe(2); // Broken is skipped
      expect(preview.items).toHaveLength(2); // Group 1 and Root Chat C2
      const groupItem = preview.items.find(i => i.type === 'chat_group');
      if (groupItem?.type === 'chat_group') {
        expect(groupItem.data.items).toHaveLength(1);
        expect(groupItem.data.items[0]!.title).toBe('C1');
      }
    });
  });
});