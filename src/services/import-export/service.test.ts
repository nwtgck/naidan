import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ImportExportService, type IImportExportStorage } from './service';
import JSZip from 'jszip';
import { ChatSchemaDto } from '@/models/dto';
import type { SettingsDto, ChatMetaDto, ChatGroupDto, MigrationChunkDto } from '@/models/dto';
import type { ExportOptions, ImportConfig } from './types';
import type { Mocked } from 'vitest';
import type { Settings, ChatMeta } from '@/models/types';
import { toChatGroupId, toChatId, toMessageId } from '@/models/ids';
import { IMAGE_BLOCK_LANG } from '@/utils/image-generation';

const UUID_G1 = '018d476a-7b3a-73fd-8000-000000000001';
const UUID_C1 = '018d476a-7b3a-73fd-8000-000000000002';
const UUID_C2 = '018d476a-7b3a-73fd-8000-000000000003';
const UUID_A1 = '018d476a-7b3a-73fd-8000-000000000004';
const UUID_A2 = '018d476a-7b3a-73fd-8000-000000000007';
const UUID_A3 = '018d476a-7b3a-73fd-8000-000000000008';
const UUID_A4 = '018d476a-7b3a-73fd-8000-00000000000a';
const UUID_A5 = '018d476a-7b3a-73fd-8000-00000000000b';
const UUID_M1 = '018d476a-7b3a-73fd-8000-000000000005';
const UUID_M2 = '018d476a-7b3a-73fd-8000-000000000006';
const UUID_M3 = '018d476a-7b3a-73fd-8000-000000000009';
const UUID_M4 = '018d476a-7b3a-73fd-8000-00000000000c';
const UUID_M5 = '018d476a-7b3a-73fd-8000-00000000000d';
const UUID_M6 = '018d476a-7b3a-73fd-8000-00000000000e';
const NEW_UUID = '018d476a-7b3a-73fd-8000-ffffffffffff';

vi.mock('../../utils/id', () => ({
  generateId: vi.fn(() => NEW_UUID),
}));

vi.stubGlobal('crypto', {
  randomUUID: vi.fn(() => NEW_UUID),
});

vi.mock('../../composables/useGlobalEvents', () => ({
  useGlobalEvents: () => ({
    addErrorEvent: vi.fn(),
  }),
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
      updateSettings: vi.fn().mockImplementation(async ({ updater }) => {
        const current = await mockStorage.loadSettings();
        await updater({ current: current });
      }),
      listChats: vi.fn(),
      listChatGroups: vi.fn(),
      loadHierarchy: vi.fn().mockResolvedValue({ items: [] }),
    } as any;
    service = new ImportExportService({ storage: mockStorage });
  });

  const createValidSettingsDto = (overrides: Partial<SettingsDto> = {}): SettingsDto => ({
    endpoint: { type: 'ollama', url: 'http://localhost:11434', httpHeaders: undefined },
    storageType: 'local',
    autoTitleEnabled: true,
    providerProfiles: [],
    experimental: undefined,
    defaultModelId: undefined,
    titleModelId: undefined,
    heavyContentAlertDismissed: undefined,
    systemPrompt: undefined,
    lmParameters: undefined,
    mounts: [],
    ...overrides,
  });

  const createValidSettings = (overrides: Partial<Settings> = {}): Settings => ({
    endpoint: { type: 'ollama', url: 'http://localhost:11434' },
    storageType: 'local',
    autoTitleEnabled: true,
    providerProfiles: [],
    defaultModelId: undefined,
    titleModelId: undefined,
    heavyContentAlertDismissed: undefined,
    systemPrompt: undefined,
    lmParameters: undefined,
    mounts: [],
    ...overrides,
  });

  const createValidChatMetaDto = (overrides: Partial<ChatMetaDto> = {}): ChatMetaDto => ({
    id: UUID_C1,
    title: 'Test Chat',
    updatedAt: 1000,
    createdAt: 1000,
    debugEnabled: false,
    currentLeafId: undefined,
    endpoint: undefined,
    modelId: undefined,
    autoTitleEnabled: undefined,
    titleModelId: undefined,
    originChatId: undefined,
    originMessageId: undefined,
    systemPrompt: undefined,
    lmParameters: undefined,
    mounts: undefined,
    ...overrides,
  });

  const createValidChatMeta = (overrides: Partial<ChatMeta> = {}): ChatMeta => ({
    id: toChatId({ raw: UUID_C1 }),
    title: 'Test Chat',
    updatedAt: 1000,
    createdAt: 1000,
    debugEnabled: false,
    currentLeafId: undefined,
    endpoint: undefined,
    modelId: undefined,
    autoTitleEnabled: undefined,
    titleModelId: undefined,
    originChatId: undefined,
    originMessageId: undefined,
    systemPrompt: undefined,
    lmParameters: undefined,
    ...overrides,
  });

  describe('exportData', () => {
    it('rejects conflicting exclusions before starting the export producer', async () => {
      const invalidExclude = ['chat', 'chat_history'] as unknown as ExportOptions['exclude'];

      await expect(service.exportData({ exclude: invalidExclude }))
        .rejects.toThrow('Chat and chat history exclusions cannot be used together.');

      expect(mockStorage.dumpWithoutLock).not.toHaveBeenCalled();
    });

    it('handles empty storage gracefully and uses dumpWithoutLock', async () => {
      mockStorage.dumpWithoutLock.mockResolvedValue({
        structure: {
          settings: {
            endpoint: { type: 'openai', url: '' },
            autoTitleEnabled: true,
            storageType: 'local',
            providerProfiles: [],
          } as any,
          hierarchy: { items: [] },
          chatMetas: [],
          chatGroups: [],
        },
        contentStream: (async function* () {})(),
      });
      const { filename } = await service.exportData({});
      expect(filename).toMatch(/^naidan-data-\d{4}-\d{2}-\d{2}\.zip$/);
      expect(mockStorage.dumpWithoutLock).toHaveBeenCalled();
    });

    it('respects exclusion flags and filters hierarchy', async () => {
      mockStorage.dumpWithoutLock.mockResolvedValue({
        structure: {
          settings: {
            endpoint: { type: 'openai', url: '' },
            autoTitleEnabled: true,
            storageType: 'local',
            providerProfiles: [],
          } as any,
          hierarchy: {
            items: [
              { type: 'chat_group', id: toChatGroupId({ raw: UUID_G1}), chat_ids: [toChatId({ raw: UUID_C1 })] },
              { type: 'chat', id: toChatId({ raw: UUID_C2 })},
            ],
          },
          chatMetas: [
            { id: toChatId({ raw: UUID_C1 }), title: 'Test 1', updatedAt: 1000, createdAt: 1000, debugEnabled: false },
            { id: toChatId({ raw: UUID_C2 }), title: 'Test 2', updatedAt: 1000, createdAt: 1000, debugEnabled: false },
          ],
          chatGroups: [{ id: toChatGroupId({ raw: UUID_G1 }), name: 'Group', updatedAt: 1000, isCollapsed: false, items: [] }],
        },
        contentStream: (async function* () {
          yield { type: 'chat', data: { id: UUID_C1, title: 'Test 1', updatedAt: 1000, createdAt: 1000, root: { items: [] } } as any };
          yield { type: 'chat', data: { id: UUID_C2, title: 'Test 2', updatedAt: 1000, createdAt: 1000, root: { items: [] } } as any };
          yield { type: 'binary_object', id: UUID_A1, name: 'file.txt', mimeType: 'text/plain', size: 10, createdAt: 1000, blob: new Blob(['hello']) };
        })(),
      });

      const { stream } = await service.exportData({ exclude: ['chat', 'binary_object'] });

      const chunks: Uint8Array[] = [];
      const reader = stream.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value!);
      }
      const zip = await JSZip.loadAsync(new Blob(chunks as BlobPart[]));

      const files = Object.keys(zip.files);
      const rootFolder = files.find(f => f.startsWith('naidan-data-'))!;

      // Structural preservation: hierarchy.json and chat-groups should be there
      expect(files).toContain(`${rootFolder}hierarchy.json`);
      expect(files.some(f => f.includes('chat-groups/'))).toBe(true);

      // Exclusion: chat-metas, chat-contents, and binary-objects should be gone
      expect(files).not.toContain(`${rootFolder}chat-metas.json`);
      expect(files.some(f => f.includes('chat-contents/'))).toBe(false);
      expect(files.some(f => f.includes('binary-objects/'))).toBe(false);

      // Verify hierarchy is filtered: only Group remains, and its chat_ids are empty
      const hierarchy = JSON.parse(await zip.file(`${rootFolder}hierarchy.json`)!.async('string'));
      expect(hierarchy.items).toHaveLength(1);
      expect(hierarchy.items[0].type).toBe('chat_group');
      expect(hierarchy.items[0].chat_ids).toHaveLength(0);

      // Settings should always be included
      expect(files).toContain(`${rootFolder}settings.json`);
    });

    it('excludes ONLY binary objects while keeping chat structure', async () => {
      mockStorage.dumpWithoutLock.mockResolvedValue({
        structure: {
          settings: {
            endpoint: { type: 'openai', url: '' },
            autoTitleEnabled: true,
            storageType: 'local',
            providerProfiles: [],
          } as any,
          hierarchy: { items: [{ type: 'chat', id: toChatId({ raw: UUID_C1 }) }] },
          chatMetas: [{ id: toChatId({ raw: UUID_C1 }), title: 'Test', updatedAt: 1000, createdAt: 1000, debugEnabled: false }],
          chatGroups: [],
        },
        contentStream: (async function* () {
          yield { type: 'chat', data: { id: UUID_C1, title: 'Test', updatedAt: 1000, createdAt: 1000, root: { items: [] } } as any };
          yield { type: 'binary_object', id: UUID_A1, name: 'file.txt', mimeType: 'text/plain', size: 10, createdAt: 1000, blob: new Blob(['hello']) };
        })(),
      });

      const { stream } = await service.exportData({ exclude: ['binary_object'] });

      const chunks: Uint8Array[] = [];
      const reader = stream.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value!);
      }
      const zip = await JSZip.loadAsync(new Blob(chunks as BlobPart[]));

      const files = Object.keys(zip.files);
      const rootFolder = files.find(f => f.startsWith('naidan-data-'))!;

      // Chats should be there
      expect(files).toContain(`${rootFolder}hierarchy.json`);
      expect(files).toContain(`${rootFolder}chat-metas.json`);
      expect(files.some(f => f.includes('chat-contents/'))).toBe(true);

      // Binary objects should be gone
      expect(files.some(f => f.includes('binary-objects/'))).toBe(false);
    });

    it('excludes ONLY chats while keeping binary objects', async () => {
      mockStorage.dumpWithoutLock.mockResolvedValue({
        structure: {
          settings: {
            endpoint: { type: 'openai', url: '' },
            autoTitleEnabled: true,
            storageType: 'local',
            providerProfiles: [],
          } as any,
          hierarchy: { items: [{ type: 'chat', id: toChatId({ raw: UUID_C1 }) }] },
          chatMetas: [{ id: toChatId({ raw: UUID_C1 }), title: 'Test', updatedAt: 1000, createdAt: 1000, debugEnabled: false }],
          chatGroups: [],
        },
        contentStream: (async function* () {
          yield { type: 'chat', data: { id: UUID_C1, title: 'Test', updatedAt: 1000, createdAt: 1000, root: { items: [] } } as any };
          yield { type: 'binary_object', id: UUID_A1, name: 'file.txt', mimeType: 'text/plain', size: 10, createdAt: 1000, blob: new Blob(['hello']) };
        })(),
      });

      const { stream } = await service.exportData({ exclude: ['chat'] });

      const chunks: Uint8Array[] = [];
      const reader = stream.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value!);
      }
      const zip = await JSZip.loadAsync(new Blob(chunks as BlobPart[]));

      const files = Object.keys(zip.files);
      const rootFolder = files.find(f => f.startsWith('naidan-data-'))!;

      // Chats should be gone
      expect(files).not.toContain(`${rootFolder}chat-metas.json`);
      expect(files.some(f => f.includes('chat-contents/'))).toBe(false);

      // Binary objects should STILL BE THERE (though orphaned)
      expect(files.some(f => f.includes('binary-objects/'))).toBe(true);
    });

    it('exports every chat with only its current thread and referenced binary objects', async () => {
      mockStorage.dumpWithoutLock.mockResolvedValue({
        structure: {
          settings: createValidSettings(),
          hierarchy: {
            items: [{
              type: 'chat_group',
              id: toChatGroupId({ raw: UUID_G1 }),
              chat_ids: [toChatId({ raw: UUID_C1 }), toChatId({ raw: UUID_C2 })],
            }],
          },
          chatMetas: [
            createValidChatMeta({ id: toChatId({ raw: UUID_C1 }), currentLeafId: toMessageId({ raw: UUID_M3 }) }),
            createValidChatMeta({
              id: toChatId({ raw: UUID_C2 }),
              title: 'Other Chat',
              currentLeafId: toMessageId({ raw: UUID_M5 }),
            }),
          ],
          chatGroups: [{
            id: toChatGroupId({ raw: UUID_G1 }),
            name: 'Group',
            updatedAt: 1000,
            isCollapsed: false,
            items: [],
          }],
        },
        contentStream: (async function* (): AsyncGenerator<MigrationChunkDto> {
          for (const id of [UUID_A1, UUID_A2, UUID_A3, UUID_A4, UUID_A5]) {
            yield {
              type: 'binary_object' as const,
              id,
              name: `${id}.bin`,
              mimeType: 'application/octet-stream',
              size: 1,
              createdAt: 1000,
              blob: new Blob([id]),
            };
          }
          yield {
            type: 'chat' as const,
            data: ChatSchemaDto.parse({
              ...createValidChatMetaDto({ id: UUID_C1, currentLeafId: UUID_M3 }),
              root: {
                items: [{
                  id: UUID_M1,
                  role: 'user',
                  content: 'root',
                  attachments: [{ id: 'attachment-1', binaryObjectId: UUID_A1, name: 'a.txt', status: 'persisted' }],
                  timestamp: 1,
                  replies: {
                    items: [
                      {
                        id: UUID_M2,
                        role: 'assistant',
                        content: 'current',
                        timestamp: 2,
                        replies: {
                          items: [{
                            id: UUID_M3,
                            role: 'tool',
                            results: [{
                              toolCallId: 'current-tool-call',
                              status: 'success',
                              content: { type: 'binary_object', id: UUID_A2 },
                            }],
                            timestamp: 3,
                            replies: { items: [] },
                          }],
                        },
                      },
                      {
                        id: 'alternate-message',
                        role: 'user',
                        content: 'alternate',
                        attachments: [{ id: 'attachment-3', binaryObjectId: UUID_A3, name: 'alternate.txt', status: 'persisted' }],
                        timestamp: 4,
                        replies: { items: [] },
                      },
                    ],
                  },
                }],
              },
            }),
          };
          yield {
            type: 'chat' as const,
            data: ChatSchemaDto.parse({
              ...createValidChatMetaDto({ id: UUID_C2, title: 'Other Chat', currentLeafId: UUID_M5 }),
              root: {
                items: [{
                  id: UUID_M4,
                  role: 'user',
                  content: 'other root',
                  attachments: [{ id: 'attachment-4', binaryObjectId: UUID_A4, name: 'other.txt', status: 'persisted' }],
                  timestamp: 5,
                  replies: {
                    items: [
                      {
                        id: UUID_M5,
                        role: 'assistant',
                        content: 'other current',
                        timestamp: 6,
                        replies: { items: [] },
                      },
                      {
                        id: UUID_M6,
                        role: 'user',
                        content: 'other alternate',
                        attachments: [{ id: 'attachment-5', binaryObjectId: UUID_A5, name: 'other-alternate.txt', status: 'persisted' }],
                        timestamp: 7,
                        replies: { items: [] },
                      },
                    ],
                  },
                }],
              },
            }),
          };
        })(),
      });

      const { stream } = await service.exportData({ exclude: ['chat_history'] });
      const chunks: Uint8Array[] = [];
      const reader = stream.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value!);
      }
      const zip = await JSZip.loadAsync(new Blob(chunks as BlobPart[]));
      const rootFolder = Object.keys(zip.files).find(file => file.startsWith('naidan-data-'))!;
      const hierarchy = JSON.parse(await zip.file(`${rootFolder}hierarchy.json`)!.async('string'));
      const metas = JSON.parse(await zip.file(`${rootFolder}chat-metas.json`)!.async('string'));
      const firstChat = JSON.parse(await zip.file(`${rootFolder}chat-contents/${UUID_C1}.json`)!.async('string'));
      const secondChat = JSON.parse(await zip.file(`${rootFolder}chat-contents/${UUID_C2}.json`)!.async('string'));
      const files = Object.keys(zip.files);

      expect(hierarchy.items).toEqual([{ type: 'chat_group', id: UUID_G1, chat_ids: [UUID_C1, UUID_C2] }]);
      expect(metas.entries.map((entry: ChatMetaDto) => entry.id)).toEqual([UUID_C1, UUID_C2]);
      expect(zip.file(`${rootFolder}chat-groups/${UUID_G1}.json`)).not.toBeNull();
      expect(firstChat.root.items[0].replies.items).toHaveLength(1);
      expect(firstChat.root.items[0].replies.items[0].id).toBe(UUID_M2);
      expect(firstChat.root.items[0].replies.items[0].replies.items[0].id).toBe(UUID_M3);
      expect(firstChat.root.items[0].replies.items[0].replies.items[0].replies.items).toEqual([]);
      expect(secondChat.root.items[0].replies.items).toHaveLength(1);
      expect(secondChat.root.items[0].replies.items[0].id).toBe(UUID_M5);
      expect(secondChat.root.items[0].replies.items[0].replies.items).toEqual([]);
      expect(files.some(file => file.endsWith(`${UUID_A1}.bin`))).toBe(true);
      expect(files.some(file => file.endsWith(`${UUID_A2}.bin`))).toBe(true);
      expect(files.some(file => file.endsWith(`${UUID_A3}.bin`))).toBe(false);
      expect(files.some(file => file.endsWith(`${UUID_A4}.bin`))).toBe(true);
      expect(files.some(file => file.endsWith(`${UUID_A5}.bin`))).toBe(false);
    });

    it('preserves current-thread DTO fields and generated-image binary references', async () => {
      const generatedImageContent = `\
\`\`\`${IMAGE_BLOCK_LANG}
${JSON.stringify({
    binaryObjectId: UUID_A2,
    displayWidth: 512,
    displayHeight: 512,
  })}
\`\`\``;

      mockStorage.dumpWithoutLock.mockResolvedValue({
        structure: {
          settings: createValidSettings(),
          hierarchy: { items: [{ type: 'chat', id: toChatId({ raw: UUID_C1 }) }] },
          chatMetas: [createValidChatMeta({
            id: toChatId({ raw: UUID_C1 }),
            currentLeafId: toMessageId({ raw: UUID_M2 }),
          })],
          chatGroups: [],
        },
        contentStream: (async function* (): AsyncGenerator<MigrationChunkDto> {
          for (const id of [UUID_A1, UUID_A2, UUID_A3]) {
            yield {
              type: 'binary_object',
              id,
              name: `${id}.bin`,
              mimeType: 'application/octet-stream',
              size: 1,
              createdAt: 1000,
              blob: new Blob([id]),
            };
          }

          yield {
            type: 'chat',
            data: ChatSchemaDto.parse({
              ...createValidChatMetaDto({ id: UUID_C1, currentLeafId: UUID_M2 }),
              root: {
                experimental: {},
                items: [{
                  id: UUID_M1,
                  role: 'user',
                  experimental: {},
                  content: 'root',
                  attachments: [{
                    id: UUID_A1,
                    experimental: {},
                    originalName: 'legacy.txt',
                    mimeType: 'text/plain',
                    size: 1,
                    uploadedAt: 1000,
                    status: 'persisted',
                  }],
                  timestamp: 1,
                  replies: {
                    experimental: {},
                    items: [
                      {
                        id: UUID_M2,
                        role: 'assistant',
                        experimental: {},
                        content: generatedImageContent,
                        timestamp: 2,
                        replies: { experimental: {}, items: [] },
                      },
                      {
                        id: UUID_M3,
                        role: 'user',
                        content: 'alternate',
                        attachments: [{
                          id: 'alternate-attachment',
                          binaryObjectId: UUID_A3,
                          name: 'alternate.txt',
                          status: 'persisted',
                        }],
                        timestamp: 3,
                        replies: { items: [] },
                      },
                    ],
                  },
                }],
              },
            }),
          };
        })(),
      });

      const { stream } = await service.exportData({ exclude: ['chat_history'] });
      const chunks: Uint8Array[] = [];
      const reader = stream.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value!);
      }

      const zip = await JSZip.loadAsync(new Blob(chunks as BlobPart[]));
      const rootFolder = Object.keys(zip.files).find(file => file.startsWith('naidan-data-'))!;
      const chat = JSON.parse(await zip.file(`${rootFolder}chat-contents/${UUID_C1}.json`)!.async('string'));
      const files = Object.keys(zip.files);
      const rootNode = chat.root.items[0];
      const currentNode = rootNode.replies.items[0];

      expect(chat.root.experimental).toEqual({});
      expect(rootNode.experimental).toEqual({});
      expect(rootNode.replies.experimental).toEqual({});
      expect(rootNode.attachments[0]).toEqual({
        id: UUID_A1,
        experimental: {},
        originalName: 'legacy.txt',
        mimeType: 'text/plain',
        size: 1,
        uploadedAt: 1000,
        status: 'persisted',
      });
      expect(currentNode.experimental).toEqual({});
      expect(currentNode.replies.experimental).toEqual({});
      expect(files.some(file => file.endsWith(`${UUID_A1}.bin`))).toBe(true);
      expect(files.some(file => file.endsWith(`${UUID_A2}.bin`))).toBe(true);
      expect(files.some(file => file.endsWith(`${UUID_A3}.bin`))).toBe(false);
    });

    it('keeps an undefined current leaf while using the fallback current thread', async () => {
      mockStorage.dumpWithoutLock.mockResolvedValue({
        structure: {
          settings: createValidSettings(),
          hierarchy: { items: [{ type: 'chat', id: toChatId({ raw: UUID_C1 }) }] },
          chatMetas: [createValidChatMeta({ id: toChatId({ raw: UUID_C1 }) })],
          chatGroups: [],
        },
        contentStream: (async function* (): AsyncGenerator<MigrationChunkDto> {
          yield {
            type: 'chat',
            data: ChatSchemaDto.parse({
              ...createValidChatMetaDto({ id: UUID_C1, currentLeafId: undefined }),
              root: {
                items: [
                  {
                    id: UUID_M1,
                    role: 'user',
                    content: 'first root',
                    timestamp: 1,
                    replies: { items: [] },
                  },
                  {
                    id: UUID_M2,
                    role: 'user',
                    content: 'fallback root',
                    timestamp: 2,
                    replies: {
                      items: [{
                        id: UUID_M3,
                        role: 'assistant',
                        content: 'fallback leaf',
                        timestamp: 3,
                        replies: { items: [] },
                      }],
                    },
                  },
                ],
              },
            }),
          };
        })(),
      });

      const { stream } = await service.exportData({ exclude: ['chat_history'] });
      const chunks: Uint8Array[] = [];
      const reader = stream.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value!);
      }

      const zip = await JSZip.loadAsync(new Blob(chunks as BlobPart[]));
      const rootFolder = Object.keys(zip.files).find(file => file.startsWith('naidan-data-'))!;
      const chat = JSON.parse(await zip.file(`${rootFolder}chat-contents/${UUID_C1}.json`)!.async('string'));

      expect(chat.currentLeafId).toBeUndefined();
      expect(chat.root.items).toHaveLength(1);
      expect(chat.root.items[0].id).toBe(UUID_M2);
      expect(chat.root.items[0].replies.items[0].id).toBe(UUID_M3);
    });

    it('includes all data by default (no exclusion)', async () => {
      mockStorage.dumpWithoutLock.mockResolvedValue({
        structure: {
          settings: {
            endpoint: { type: 'openai', url: 'http://localhost:11434' },
            autoTitleEnabled: true,
            storageType: 'local',
            providerProfiles: [],
          } as any,
          hierarchy: { items: [{ type: 'chat', id: toChatId({ raw: UUID_C1 }) }] },
          chatMetas: [{ id: toChatId({ raw: UUID_C1 }), title: 'Test', updatedAt: 1000, createdAt: 1000, debugEnabled: false }],
          chatGroups: [{ id: toChatGroupId({ raw: UUID_G1 }), name: 'Group', updatedAt: 1000, isCollapsed: false, items: [] }],
        },
        contentStream: (async function* () {
          yield { type: 'chat', data: { id: UUID_C1, title: 'Test', updatedAt: 1000, createdAt: 1000, root: { items: [] } } as any };
          yield { type: 'binary_object', id: UUID_A1, name: 'file.txt', mimeType: 'text/plain', size: 10, createdAt: 1000, blob: new Blob(['hello']) };
        })(),
      });

      const { stream } = await service.exportData({});

      const chunks: Uint8Array[] = [];
      const reader = stream.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value!);
      }
      const zip = await JSZip.loadAsync(new Blob(chunks as BlobPart[]));

      const files = Object.keys(zip.files);
      const rootFolder = files.find(f => f.startsWith('naidan-data-'))!;

      expect(files).toContain(`${rootFolder}hierarchy.json`);
      expect(files).toContain(`${rootFolder}chat-metas.json`);
      expect(files.some(f => f.includes('chat-groups/'))).toBe(true);
      expect(files.some(f => f.includes('chat-contents/'))).toBe(true);
      expect(files.some(f => f.includes('binary-objects/'))).toBe(true);
      expect(files).toContain(`${rootFolder}settings.json`);
    });

    it('exports complex message attributes (thinking, toolCalls, results)', async () => {
      const complexChat = {
        id: UUID_C1,
        title: 'Complex',
        updatedAt: 1000,
        createdAt: 1000,
        root: {
          items: [
            {
              id: UUID_M1,
              role: 'assistant',
              content: 'Result',
              thinking: 'I am thinking...',
              modelId: 'gpt-4',
              toolCalls: [{ id: 'tc-1', type: 'function', function: { name: 'get_weather', arguments: '{}' } }],
              replies: {
                items: [{
                  id: UUID_M2,
                  role: 'tool',
                  results: [{ toolCallId: 'tc-1', status: 'success', content: { type: 'text', text: 'Sunny' } }],
                  timestamp: 1100,
                  replies: { items: [] },
                }],
              },
            },
          ],
        },
      };

      mockStorage.dumpWithoutLock.mockResolvedValue({
        structure: {
          settings: {
            endpoint: { type: 'ollama', url: 'http://localhost:11434' },
            autoTitleEnabled: true,
            storageType: 'local',
            providerProfiles: [],
          } as any,
          hierarchy: { items: [{ type: 'chat', id: toChatId({ raw: UUID_C1 }) }] },
          chatMetas: [createValidChatMeta({ id: toChatId({ raw: UUID_C1 }) })],
          chatGroups: [],
        },
        contentStream: (async function* () {
          yield { type: 'chat', data: complexChat as any };
        })(),
      });

      const { stream } = await service.exportData({});
      const chunks: Uint8Array[] = [];
      const reader = stream.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value!);
      }
      const zip = await JSZip.loadAsync(new Blob(chunks as BlobPart[]));
      const rootFolder = Object.keys(zip.files).find(f => f.startsWith('naidan-data-'))!;
      const content = JSON.parse(await zip.file(`${rootFolder}chat-contents/${UUID_C1}.json`)!.async('string'));

      expect(content.root.items[0].thinking).toBe('I am thinking...');
      expect(content.root.items[0].modelId).toBe('gpt-4');
      expect(content.root.items[0].toolCalls).toHaveLength(1);
      expect(content.root.items[0].replies.items[0].results[0].content.text).toBe('Sunny');
    });

    it('exports transformers_js endpoint settings', async () => {
      mockStorage.dumpWithoutLock.mockResolvedValue({
        structure: {
          settings: {
            endpoint: { type: 'transformers_js' },
            autoTitleEnabled: true,
            storageType: 'local',
            providerProfiles: [],
          } as any,
          hierarchy: { items: [] },
          chatMetas: [],
          chatGroups: [],
        },
        contentStream: (async function* () {})(),
      });

      const { stream } = await service.exportData({});
      const chunks: Uint8Array[] = [];
      const reader = stream.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value!);
      }
      const zip = await JSZip.loadAsync(new Blob(chunks as BlobPart[]));
      const rootFolder = Object.keys(zip.files).find(f => f.startsWith('naidan-data-'))!;
      const settings = JSON.parse(await zip.file(`${rootFolder}settings.json`)!.async('string'));

      expect(settings.endpoint.type).toBe('transformers_js');
    });

    it('sanitizes and truncates export filenames', async () => {
      mockStorage.dumpWithoutLock.mockResolvedValue({
        structure: {
          settings: createValidSettings(),
          hierarchy: { items: [] },
          chatMetas: [],
          chatGroups: [],
        },
        contentStream: (async function* () {})(),
      });

      const longName = 'A'.repeat(300); // Exceeds typical OS limits
      const { filename } = await service.exportData({ fileNameSegment: `Illegal/Name:${longName}` });

      expect(filename).not.toContain('/');
      expect(filename).not.toContain(':');
      // Byte length check (naidan-data- + sanitized_segment + -YYYY-MM-DD.zip)
      // textEncoder helps verify actual byte length rather than just string length
      expect(new TextEncoder().encode(filename).length).toBeLessThanOrEqual(255);
    });

    it('exports tool execution results with errors and binary references', async () => {
      const toolChat = {
        id: UUID_C1,
        title: 'Tool Test',
        updatedAt: 1000,
        createdAt: 1000,
        root: {
          items: [{
            id: UUID_M1,
            role: 'tool',
            results: [
              {
                toolCallId: 'tc-err',
                status: 'error',
                error: { code: 'execution_failed', message: { type: 'text', text: 'Crash' } },
              },
              {
                toolCallId: 'tc-bin',
                status: 'success',
                content: { type: 'binary_object', id: UUID_A1 },
              },
            ],
            timestamp: 1000,
            replies: { items: [] },
          }],
        },
      };
      mockStorage.dumpWithoutLock.mockResolvedValue({
        structure: {
          settings: createValidSettings(),
          hierarchy: { items: [{ type: 'chat', id: toChatId({ raw: UUID_C1 }) }] },
          chatMetas: [createValidChatMeta({ id: toChatId({ raw: UUID_C1 }) })],
          chatGroups: [],
        },
        contentStream: (async function* () {
          yield { type: 'chat', data: toolChat as any };
        })(),
      });

      const { stream } = await service.exportData({});
      const chunks: Uint8Array[] = [];
      const reader = stream.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value!);
      }
      const zip = await JSZip.loadAsync(new Blob(chunks as BlobPart[]));
      const rootFolder = Object.keys(zip.files).find(f => f.startsWith('naidan-data-'))!;
      const content = JSON.parse(await zip.file(`${rootFolder}chat-contents/${UUID_C1}.json`)!.async('string'));

      expect(content.root.items[0].results[0].status).toBe('error');
      expect(content.root.items[0].results[0].error.code).toBe('execution_failed');
      expect(content.root.items[0].results[1].content.type).toBe('binary_object');
      expect(content.root.items[0].results[1].content.id).toBe(UUID_A1);
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
        settings: { endpoint: 'none', model: 'none', titleModel: 'none', systemPrompt: 'none', lmParameters: 'none', providerProfiles: 'none' },
      };

      mockStorage.loadSettings.mockResolvedValue(null);
      await service.executeImport({ zipFile: zipBlob, config });

      expect(mockStorage.clearAll).toHaveBeenCalled();
      expect(mockStorage.restore).toHaveBeenCalledWith(expect.anything());
    });

    it('ignores binary object metadata keys omitted by the DTO schema', async () => {
      const retainedBinaryObjectId = 'binary-object-1';
      const omittedBinaryObjectId = '__proto__';
      const zip = new JSZip();
      zip.file('export-manifest.json', '{}');

      const binFolder = zip.folder('binary-objects')!.folder('prototype-keys')!;
      const objects = Object.fromEntries([
        retainedBinaryObjectId,
        omittedBinaryObjectId,
      ].map(binaryObjectId => {
        binFolder.file(`${binaryObjectId}.bin`, new Blob([`binary ${binaryObjectId}`]));
        return [binaryObjectId, {
          id: binaryObjectId,
          mimeType: 'application/octet-stream',
          size: 11,
          createdAt: 1000,
          name: `${binaryObjectId}.bin`,
        }];
      }));
      binFolder.file('index.json', JSON.stringify({ objects }));

      mockStorage.loadSettings.mockResolvedValue(null);
      await service.executeImport({
        zipFile: await zip.generateAsync({ type: 'blob' }),
        config: {
          data: { mode: 'replace' },
          settings: {
            endpoint: 'none',
            model: 'none',
            titleModel: 'none',
            systemPrompt: 'none',
            lmParameters: 'none',
            providerProfiles: 'none',
          },
        },
      });

      const snapshot = mockStorage.restore.mock.calls[0]![0].snapshot;
      const chunks = [];
      for await (const chunk of snapshot.contentStream) {
        chunks.push(chunk);
      }

      expect(chunks).toContainEqual(expect.objectContaining({
        type: 'binary_object',
        id: retainedBinaryObjectId,
        name: `${retainedBinaryObjectId}.bin`,
      }));
      expect(chunks).not.toContainEqual(expect.objectContaining({
        type: 'binary_object',
        id: omittedBinaryObjectId,
      }));
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
      await service.executeImport({ zipFile: zipBlob, config: { data: { mode: 'append' }, settings: { endpoint: 'none', model: 'none', titleModel: 'none', systemPrompt: 'none', lmParameters: 'none', providerProfiles: 'none' } } });

      const calls = mockStorage.restore.mock.calls;
      const snapshot = calls[0]![0].snapshot;
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
            id: UUID_M1, role: 'assistant', content: 'hello', timestamp: now,
            replies: {
              items: [{
                id: UUID_M2, role: 'user', content: 'response', timestamp: now + 100,
                attachments: [{
                  id: UUID_A1, binaryObjectId: UUID_A1, name: 'img.png', status: 'persisted',
                }],
                replies: { items: [] },
              }],
            },
          }],
        },
      };
      zip.folder('chat-contents')!.file(`${UUID_C1}.json`, JSON.stringify(content));

      const shard = UUID_A1.slice(-2);
      const binFolder = zip.folder('binary-objects')!.folder(shard);
      binFolder!.file(`${UUID_A1}.bin`, new Blob(['...']));
      binFolder!.file('index.json', JSON.stringify({
        objects: {
          [UUID_A1]: { id: UUID_A1, mimeType: 'image/png', size: 100, createdAt: now, name: 'img.png' },
        },
      }));

      await service.executeImport({ zipFile: await zip.generateAsync({ type: 'blob' }), config: {
        data: { mode: 'append' },
        settings: { endpoint: 'none', model: 'none', titleModel: 'none', systemPrompt: 'none', lmParameters: 'none', providerProfiles: 'none' },
      } });

      const calls = mockStorage.restore.mock.calls;
      const snapshot = calls[0]![0].snapshot;
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

    it('should remap and convert V1 attachments to V2 during append import', async () => {
      const zip = new JSZip();
      zip.file('export-manifest.json', '{}');
      const chatMeta = createValidChatMetaDto({ id: UUID_C1 });
      zip.file('chat-metas.json', JSON.stringify({ entries: [chatMeta] }));

      // V1 style content
      const content = {
        root: {
          items: [{
            id: UUID_M1, role: 'user', content: 'v1 test', timestamp: 1000,
            attachments: [{
              id: UUID_A1,
              originalName: 'old.png',
              mimeType: 'image/png',
              size: 50,
              uploadedAt: 1000,
              status: 'persisted',
            }],
            replies: { items: [] },
          }],
        },
      };
      zip.folder('chat-contents')!.file(`${UUID_C1}.json`, JSON.stringify(content));

      // Sharded binary object
      const shard = UUID_A1.slice(-2);
      const binFolder = zip.folder('binary-objects')!.folder(shard);
      binFolder!.file(`${UUID_A1}.bin`, new Blob(['...']));
      binFolder!.file('index.json', JSON.stringify({
        objects: {
          [UUID_A1]: { id: UUID_A1, mimeType: 'image/png', size: 50, createdAt: 1000, name: 'old.png' },
        },
      }));

      await service.executeImport({ zipFile: await zip.generateAsync({ type: 'blob' }), config: {
        data: { mode: 'append' },
        settings: { endpoint: 'none', model: 'none', titleModel: 'none', systemPrompt: 'none', lmParameters: 'none', providerProfiles: 'none' },
      } });

      const calls = mockStorage.restore.mock.calls;
      const snapshot = calls[0]![0].snapshot;
      const chunks = [];
      for await (const chunk of snapshot.contentStream) {
        chunks.push(chunk);
      }

      const chatChunk = chunks.find(c => c.type === 'chat');
      if (chatChunk?.type === 'chat' && chatChunk.data.root) {
        const node = chatChunk.data.root.items[0]!;
        const att = node.attachments![0]!;
        // Check V2 conversion
        expect((att as any).binaryObjectId).toBe(NEW_UUID);
        expect((att as any).name).toBe('old.png');
        expect((att as any).originalName).toBeUndefined();
        expect((att as any).mimeType).toBeUndefined();
      }
    });

    it('remaps currentLeafId, originChatId and originMessageId during append import', async () => {
      const zip = new JSZip();
      zip.file('export-manifest.json', '{}');

      const ORIGINAL_CHAT_ID = UUID_C1;
      const ORIGINAL_MSG_ID = UUID_M1;

      // Forked chat (origin is itself for this test case simplicity)
      const chatMeta = createValidChatMetaDto({
        id: ORIGINAL_CHAT_ID,
        currentLeafId: ORIGINAL_MSG_ID,
        originChatId: ORIGINAL_CHAT_ID,
        originMessageId: ORIGINAL_MSG_ID,
      });
      zip.file('chat-metas.json', JSON.stringify({ entries: [chatMeta] }));

      const content = {
        root: {
          items: [{
            id: ORIGINAL_MSG_ID, role: 'user', content: 'hello', timestamp: 1000,
            replies: { items: [] },
          }],
        },
      };
      zip.folder('chat-contents')!.file(`${ORIGINAL_CHAT_ID}.json`, JSON.stringify(content));

      await service.executeImport({ zipFile: await zip.generateAsync({ type: 'blob' }), config: {
        data: { mode: 'append' },
        settings: { endpoint: 'none', model: 'none', titleModel: 'none', systemPrompt: 'none', lmParameters: 'none', providerProfiles: 'none' },
      } });

      const calls = mockStorage.restore.mock.calls;
      const snapshot = calls[0]![0].snapshot;
      const chunks = [];
      for await (const chunk of snapshot.contentStream) {
        chunks.push(chunk);
      }

      const chatChunk = chunks.find(c => c.type === 'chat');
      if (chatChunk?.type === 'chat') {
        const newMsgId = chatChunk.data.root!.items[0]!.id;
        expect(chatChunk.data.id).toBe(NEW_UUID);
        expect(chatChunk.data.currentLeafId).toBe(newMsgId);
        expect(chatChunk.data.originChatId).toBe(NEW_UUID);
        expect(chatChunk.data.originMessageId).toBe(newMsgId);
      }
    });

    it('applies prefixes to both chat titles and group names', async () => {
      const zip = new JSZip();
      zip.file('export-manifest.json', '{}');

      const groupDto: ChatGroupDto = {
        id: UUID_G1,
        name: 'General',
        updatedAt: 1000,
        isCollapsed: false,
        endpoint: undefined,
        modelId: undefined,
        autoTitleEnabled: undefined,
        titleModelId: undefined,
        systemPrompt: undefined,
        lmParameters: undefined,
        mounts: undefined,
      };
      zip.folder('chat-groups')!.file(`${UUID_G1}.json`, JSON.stringify(groupDto));

      const chatMeta = createValidChatMetaDto({ id: UUID_C1, title: 'Old Title' });
      zip.file('chat-metas.json', JSON.stringify({ entries: [chatMeta] }));
      zip.folder('chat-contents')!.file(`${UUID_C1}.json`, JSON.stringify({ root: { items: [] }, currentLeafId: undefined }));

      await service.executeImport({ zipFile: await zip.generateAsync({ type: 'blob' }), config: {
        data: { mode: 'append', chatTitlePrefix: '[Chat] ', chatGroupNamePrefix: '[Group] ' },
        settings: { endpoint: 'none', model: 'none', titleModel: 'none', systemPrompt: 'none', lmParameters: 'none', providerProfiles: 'none' },
      } });

      const calls = mockStorage.restore.mock.calls;
      const snapshot = calls[0]![0].snapshot;
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

      await service.executeImport({ zipFile: zipBlob, config: {
        data: { mode: 'append' },
        settings: { endpoint: 'none', model: 'none', titleModel: 'none', systemPrompt: 'none', lmParameters: 'none', providerProfiles: 'none' },
      } });

      expect(mockStorage.clearAll).not.toHaveBeenCalled();

      // Verify that the hierarchy sent to restore contains the existing item
      const snapshot = mockStorage.restore.mock.calls[0]![0].snapshot;
      expect(snapshot.structure.hierarchy.items).toContainEqual({ type: 'chat', id: 'existing-chat' });
    });

    it('handles ZIP with only groups (chats excluded) in append mode', async () => {
      const zip = new JSZip();
      zip.file('export-manifest.json', '{}');
      // Filtered hierarchy: only group, no chats
      zip.file('hierarchy.json', JSON.stringify({ items: [{ type: 'chat_group', id: UUID_G1, chat_ids: [] }] }));
      zip.folder('chat-groups')!.file(`${UUID_G1}.json`, JSON.stringify({ id: UUID_G1, name: 'Empty Group', updatedAt: 1000, isCollapsed: false }));

      await service.executeImport({ zipFile: await zip.generateAsync({ type: 'blob' }), config: {
        data: { mode: 'append' },
        settings: { endpoint: 'none', model: 'none', titleModel: 'none', systemPrompt: 'none', lmParameters: 'none', providerProfiles: 'none' },
      } });

      const snapshot = mockStorage.restore.mock.calls[0]![0].snapshot;
      expect(snapshot.structure.chatGroups).toHaveLength(1);
      expect(snapshot.structure.chatGroups[0]!.name).toBe('Empty Group');
      expect(snapshot.structure.chatMetas).toHaveLength(0);
    });

    it('correctly imports system prompts with append behavior', async () => {
      const zip = new JSZip();
      zip.file('export-manifest.json', '{}');
      const chatMeta = createValidChatMetaDto({
        id: UUID_C1,
        systemPrompt: { behavior: 'append', content: 'Extra context' },
      });
      zip.file('chat-metas.json', JSON.stringify({ entries: [chatMeta] }));
      zip.folder('chat-contents')!.file(`${UUID_C1}.json`, JSON.stringify({ root: { items: [] } }));

      await service.executeImport({ zipFile: await zip.generateAsync({ type: 'blob' }), config: {
        data: { mode: 'append' },
        settings: { endpoint: 'none', model: 'none', titleModel: 'none', systemPrompt: 'none', lmParameters: 'none', providerProfiles: 'none' },
      } });

      const snapshot = mockStorage.restore.mock.calls[0]![0].snapshot;
      expect(snapshot.structure.chatMetas[0]!.systemPrompt).toEqual({
        behavior: 'append',
        content: 'Extra context',
      });
    });
  });

  describe('Settings Merge - Edge Cases', () => {
    it('correctly merges complex lmParameters objects', async () => {
      const zip = new JSZip();
      zip.file('export-manifest.json', '{}');
      zip.file('settings.json', JSON.stringify(createValidSettingsDto({
        lmParameters: {
          temperature: 0.1,
          stop: ['ZIP'],
          topP: undefined,
          maxCompletionTokens: undefined,
          presencePenalty: undefined,
          frequencyPenalty: undefined,
          reasoning: undefined,
        },
      })));

      const zipBlob = await zip.generateAsync({ type: 'blob' });
      mockStorage.loadSettings.mockResolvedValue({
        endpoint: { type: 'ollama', url: 'http://localhost:11434' },
        lmParameters: { temperature: 0.9, maxCompletionTokens: 500, stop: ['OLD'] },
      } as any);

      const config: ImportConfig = {
        data: { mode: 'append' },
        settings: { endpoint: 'none', model: 'none', titleModel: 'none', systemPrompt: 'none', lmParameters: 'replace', providerProfiles: 'none' },
      };

      await service.executeImport({ zipFile: zipBlob, config });

      expect(mockStorage.updateSettings).toHaveBeenCalled();
      const updater = mockStorage.updateSettings.mock.calls[0]![0].updater;
      const result = await updater({ current: await mockStorage.loadSettings() });
      expect(result).toEqual(expect.objectContaining({
        lmParameters: {
          temperature: 0.1,
          stop: ['ZIP'],
          reasoning: { effort: undefined },
        },
      }));
    });

    it('correctly imports reasoning effort in lmParameters', async () => {
      const zip = new JSZip();
      zip.file('export-manifest.json', '{}');
      zip.file('settings.json', JSON.stringify(createValidSettingsDto({
        lmParameters: {
          temperature: 0.7,
          reasoning: { effort: 'high' },
        } as any,
      })));

      mockStorage.loadSettings.mockResolvedValue(createValidSettingsDto({
        lmParameters: { reasoning: { effort: undefined } } as any,
      }) as any);

      const zipBlob = await zip.generateAsync({ type: 'blob' });
      const config: ImportConfig = {
        data: { mode: 'replace' },
        settings: { endpoint: 'none', model: 'none', titleModel: 'none', systemPrompt: 'none', lmParameters: 'replace', providerProfiles: 'none' },
      };

      await service.executeImport({ zipFile: zipBlob, config });

      expect(mockStorage.updateSettings).toHaveBeenCalled();
      const updater = mockStorage.updateSettings.mock.calls[0]![0].updater;
      const result = await updater({ current: await mockStorage.loadSettings() });
      expect(result.lmParameters).toEqual({
        temperature: 0.7,
        reasoning: { effort: 'high' },
      });
    });

    it('imports UI flags', async () => {
      const zip = new JSZip();
      zip.file('export-manifest.json', '{}');
      zip.file('settings.json', JSON.stringify(createValidSettingsDto({
        heavyContentAlertDismissed: true,
        endpoint: { type: 'openai', url: 'http://imported', httpHeaders: [['X-Test', 'imported']] },
      })));

      mockStorage.loadSettings.mockResolvedValue(createValidSettings());

      const zipBlob = await zip.generateAsync({ type: 'blob' });
      const config: ImportConfig = {
        data: { mode: 'replace' },
        settings: { endpoint: 'replace', model: 'none', titleModel: 'none', systemPrompt: 'none', lmParameters: 'none', providerProfiles: 'none' },
      };

      await service.executeImport({ zipFile: zipBlob, config });

      expect(mockStorage.updateSettings).toHaveBeenCalled();
      const updater = mockStorage.updateSettings.mock.calls[0]![0].updater;
      const result = await updater({ current: await mockStorage.loadSettings() });
      expect(result.heavyContentAlertDismissed).toBe(true);
      expect(result.endpoint).toEqual({
        type: 'openai',
        url: 'http://imported',
        httpHeaders: [['X-Test', 'imported']],
      });
    });

    it('regenerates IDs for provider profiles when using append strategy', async () => {
      const zip = new JSZip();
      zip.file('export-manifest.json', '{}');
      zip.file('settings.json', JSON.stringify(createValidSettingsDto({
        providerProfiles: [{ id: UUID_G1, name: 'Imported', endpoint: { type: 'ollama', url: 'http://localhost:11434' } } as any],
      })));

      mockStorage.loadSettings.mockResolvedValue({
        endpoint: { type: 'ollama', url: 'http://localhost:11434' },
        storageType: 'local',
        providerProfiles: [{
          id: '018d476a-7b3a-73fd-8000-000000000009',
          name: 'Existing',
          endpoint: { type: 'openai', url: '' },
        }],
      } as any);

      await service.executeImport({ zipFile: await zip.generateAsync({ type: 'blob' }), config: {
        data: { mode: 'replace' },
        settings: { endpoint: 'none', model: 'none', titleModel: 'none', systemPrompt: 'none', lmParameters: 'none', providerProfiles: 'append' },
      } });

      expect(mockStorage.updateSettings).toHaveBeenCalled();
      const updater = mockStorage.updateSettings.mock.calls[0]![0].updater;
      const result = await updater({ current: await mockStorage.loadSettings() });
      expect(result).toEqual(expect.objectContaining({
        providerProfiles: [
          expect.objectContaining({ id: '018d476a-7b3a-73fd-8000-000000000009' }),
          expect.objectContaining({ id: NEW_UUID, name: 'Imported' }),
        ],
      }));
    });
  });

  describe('analyze() - Preview', () => {
    it('returns empty stats for empty ZIP', async () => {
      const zip = new JSZip();
      zip.file('export-manifest.json', '{}');
      const zipBlob = await zip.generateAsync({ type: 'blob' });
      const preview = await service.analyze({ zipFile: zipBlob });
      expect(preview.stats.chatsCount).toBe(0);
      expect(preview.stats.hasSettings).toBe(false);
    });

    it('handles ZIP with only groups (chats excluded)', async () => {
      const zip = new JSZip();
      zip.file('export-manifest.json', '{}');
      zip.file('hierarchy.json', JSON.stringify({ items: [{ type: 'chat_group', id: UUID_G1, chat_ids: [] }] }));
      zip.folder('chat-groups')!.file(`${UUID_G1}.json`, JSON.stringify({ id: UUID_G1, name: 'Empty Group', updatedAt: 1000, isCollapsed: false }));

      const preview = await service.analyze({ zipFile: await zip.generateAsync({ type: 'blob' }) });

      expect(preview.stats.chatGroupsCount).toBe(1);
      expect(preview.stats.chatsCount).toBe(0);
      expect(preview.items).toHaveLength(1);
      const firstItem = preview.items[0];
      expect(firstItem).toBeDefined();
      expect(firstItem!.type).toBe('chat_group');
      if (firstItem!.type === 'chat_group') {
        expect(firstItem!.data.name).toBe('Empty Group');
      }
    });

    it('correctly builds complex hierarchy and counts while skipping malformed entries', async () => {
      const zip = new JSZip();
      const now = Date.now();
      zip.file('export-manifest.json', JSON.stringify({ app_version: '1.0' }));

      zip.folder('chat-groups')!.file(`${UUID_G1}.json`, JSON.stringify({ id: UUID_G1, name: 'G1', updatedAt: now, isCollapsed: false }));
      zip.file('chat-metas.json', JSON.stringify({ entries: [
        { id: UUID_C1, title: 'C1', groupId: UUID_G1, updatedAt: now, createdAt: now },
        { id: UUID_C2, title: 'C2', groupId: null, updatedAt: now, createdAt: now },
        { id: 'invalid-uuid', title: 'Broken' },
      ] }));

      // Add a binary object in a shard
      const shard = UUID_A1.slice(-2);
      zip.folder('binary-objects')!.folder(shard)!.file(`${UUID_A1}.bin`, new Blob(['...']));

      const preview = await service.analyze({ zipFile: await zip.generateAsync({ type: 'blob' }) });

      expect(preview.stats.chatsCount).toBe(2); // Broken is skipped
      expect(preview.stats.attachmentsCount).toBe(1);
      expect(preview.items).toHaveLength(2); // Group 1 and Root Chat C2
      const groupItem = preview.items.find(i => i.type === 'chat_group');
      if (groupItem?.type === 'chat_group') {
        expect(groupItem.data.items).toHaveLength(1);
        expect(groupItem.data.items[0]!.title).toBe('C1');
      }
    });

    it('assembles legacy hierarchy when hierarchy.json is missing', async () => {
      const zip = new JSZip();
      zip.file('export-manifest.json', '{}');
      // No hierarchy.json
      zip.folder('chat-groups')!.file(`${UUID_G1}.json`, JSON.stringify({ id: UUID_G1, name: 'G1', updatedAt: 1000, isCollapsed: false }));
      zip.file('chat-metas.json', JSON.stringify({ entries: [
        { id: UUID_C1, title: 'C1', groupId: UUID_G1, updatedAt: 1000, createdAt: 1000 },
      ] }));

      const preview = await service.analyze({ zipFile: await zip.generateAsync({ type: 'blob' }) });

      expect(preview.items).toHaveLength(1);
      expect(preview.items[0]!.type).toBe('chat_group');
      if (preview.items[0]!.type === 'chat_group') {
        expect(preview.items[0]!.data.items).toHaveLength(1);
        expect(preview.items[0]!.data.items[0]!.title).toBe('C1');
      }
    });
  });
});
