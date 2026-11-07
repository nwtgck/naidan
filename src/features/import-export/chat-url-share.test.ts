import { installSecretEqualityTester } from '@/utils/secret.test-support';
import { Secret } from '@/utils/secret';
import { toProviderProfileId } from '@/01-models/ids';
import { toChatId, toMessageId, toBinaryObjectId, toToolCallId, toAttachmentId } from '@/01-models/ids';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { generateChatShareURL } from './chat-url-share';
import { storageService } from '@/00-storage/service';
import { EMPTY_LM_PARAMETERS, type Chat, type Settings } from '@/01-models/types';

import JSZip from 'jszip';
import { IMAGE_BLOCK_LANG } from '@/utils/image-generation';

installSecretEqualityTester();

// Define global constants that Vite normally provides
(global as any).__APP_VERSION__ = '0.0.0-test';

vi.mock('../../00-storage/service', () => ({
  storageService: {
    loadChat: vi.fn(),
    loadSettings: vi.fn(),
    getFile: vi.fn(),
    getBinaryObject: vi.fn(),
  },
}));

describe('generateChatShareURL', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Mock window.location.href
    Object.defineProperty(window, 'location', {
      value: {
        href: 'http://localhost/',
      },
      writable: true,
      configurable: true,
    });
  });

  const validSettings = {
    titleGeneration: { endpoint: 'same_scope', model: 'same_scope', lmParameters: { temperature: undefined, topP: undefined, maxCompletionTokens: undefined, presencePenalty: undefined, frequencyPenalty: undefined, stop: undefined, reasoning: { effort: undefined } } },
    storageType: 'local' as const,
    endpoint: { type: 'openai' as const, url: '' },
    providerProfiles: [],
    mounts: [],
  };

  it('should generate a share URL for a chat (using real MemoryStorageProvider and ImportExportService)', async () => {
    const mockChat = {
      id: 'chat-1',
      title: 'Shared Chat',
      root: { items: [] },
      createdAt: Date.now(),
      updatedAt: Date.now(),
      debugEnabled: false,
      lmParameters: EMPTY_LM_PARAMETERS,
    };

    (storageService.loadChat as any).mockResolvedValue(mockChat);
    (storageService.loadSettings as any).mockResolvedValue(validSettings);

    const url = await generateChatShareURL({ chatId: toChatId({ raw: 'chat-1' }) });

    expect(storageService.loadChat).toHaveBeenCalledWith({ id: 'chat-1' });
    expect(url).toContain('data-zip=');
  });

  it('should include attachments in the export', async () => {
    const mockChat = {
      id: 'chat-1',
      title: 'Chat with Attachment',
      root: {
        items: [
          {
            id: 'node-1',
            role: 'user' as const,
            createdAt: Date.now(),
            modelId: undefined,
            parts: [
              { type: 'text', text: 'Here is an image', completeness: 'complete' },
              {
                type: 'attachment',
                attachment: {
                  id: 'att-1',
                  binaryObjectId: 'bin-1',
                  originalName: 'image.png',
                  mimeType: 'image/png',
                  size: 100,
                  uploadedAt: Date.now(),
                  status: 'persisted' as const,
                },
              },
            ],
            replies: { items: [] },
            lmParameters: EMPTY_LM_PARAMETERS,
          },
        ],
      },
      createdAt: Date.now(),
      updatedAt: Date.now(),
      debugEnabled: false,
      lmParameters: EMPTY_LM_PARAMETERS,
    };

    (storageService.loadChat as any).mockResolvedValue(mockChat);
    (storageService.getFile as any).mockResolvedValue(new Blob(['fake-image-data'], { type: 'image/png' }));
    (storageService.getBinaryObject as any).mockResolvedValue({
      id: 'bin-1',
      name: 'image.png',
      mimeType: 'image/png',
      size: 100,
      createdAt: Date.now(),
    });
    (storageService.loadSettings as any).mockResolvedValue(validSettings);

    const url = await generateChatShareURL({ chatId: toChatId({ raw: 'chat-1' }) });

    expect(storageService.getFile).toHaveBeenCalledWith({ binaryObjectId: 'bin-1' });
    expect(url).toContain('data-zip=');
  });
});

describe('parts sharing binary references', () => {
  it('shares generated images, tool success/error references and memory attachments from every branch', async () => {
    vi.clearAllMocks();
    const imageText = `\`\`\`${IMAGE_BLOCK_LANG}\n{"binaryObjectId":"image","displayWidth":4,"displayHeight":4}\n\`\`\``;
    const attachment = { id: toAttachmentId({ raw: 'att' }), binaryObjectId: toBinaryObjectId({ raw: 'memory' }), originalName: 'memory.png', mimeType: 'image/png', size: 4, uploadedAt: 1, status: 'memory' as const, blob: new Blob(['memo']) };
    const content: Chat = {
      id: toChatId({ raw: 'share' }),
      title: 'Shared',
      createdAt: 1,
      updatedAt: 1,
      debugEnabled: false,
      root: {
        items: [
          {
            id: toMessageId({ raw: 'assistant' }),
            role: 'assistant',
            createdAt: 1,
            modelId: undefined,
            lmParameters: undefined,
            interruption: { type: 'cancelled' },
            parts: [{ type: 'reasoning', text: imageText.replace('image', 'not-a-reference'), completeness: 'complete' }, { type: 'text', text: imageText, completeness: 'partial' }],
            replies: {
              items: [{
                id: toMessageId({ raw: 'tool' }),
                role: 'tool',
                createdAt: 2,
                modelId: undefined,
                lmParameters: undefined,
                parts: [
                  { type: 'tool_result', result: { toolCallId: toToolCallId({ raw: 'c' }), status: 'success', content: { type: 'binary_object', id: toBinaryObjectId({ raw: 'good' }) } } },
                  { type: 'tool_result', result: { toolCallId: toToolCallId({ raw: 'c2' }), status: 'error', error: { code: 'other', message: { type: 'binary_object', id: toBinaryObjectId({ raw: 'error' }) } } } },
                ],
                replies: { items: [] },
              }],
            },
          },
          { id: toMessageId({ raw: 'other' }), role: 'user', createdAt: 3, modelId: undefined, lmParameters: EMPTY_LM_PARAMETERS, parts: [{ type: 'attachment', attachment }], replies: { items: [] } },
        ],
      },
    };
    const settings: Settings = { endpoint: { type: 'openai', url: '' }, storageType: 'local', providerProfiles: [], mounts: [], titleGeneration: { endpoint: 'same_scope', model: 'same_scope', lmParameters: EMPTY_LM_PARAMETERS } };
    vi.mocked(storageService.loadChat).mockResolvedValue(content);
    vi.mocked(storageService.loadSettings).mockResolvedValue(settings);
    vi.mocked(storageService.getFile).mockImplementation(async ({ binaryObjectId }) => new Blob([String(binaryObjectId)]));
    vi.mocked(storageService.getBinaryObject).mockImplementation(async ({ binaryObjectId }) => ({ id: binaryObjectId, name: String(binaryObjectId), mimeType: 'application/octet-stream', size: String(binaryObjectId).length, createdAt: 1 }));
    const url = new URL(await generateChatShareURL({ chatId: content.id }));
    const data = new URLSearchParams(url.hash.slice(url.hash.indexOf('?') + 1)).get('data-zip');
    if (!data) {
      throw new Error('Missing ZIP data.');
    }
    const zip = await JSZip.loadAsync(data, { base64: true });
    for (const id of ['image', 'good', 'error', 'memory']) {
      expect(Object.keys(zip.files).some(name => name.endsWith(`/${id}.bin`))).toBe(true);
    }
    expect(vi.mocked(storageService.getFile).mock.calls.map(([arg]) => String(arg.binaryObjectId)).sort()).toEqual(['error', 'good', 'image']);
    const jsonPath = Object.keys(zip.files).find(name => name.endsWith('/chat-contents/share.json'))!;
    const serialized = await zip.file(jsonPath)!.async('string');
    expect(serialized).toContain('reasoning');
    expect(serialized).toContain('cancelled');
    expect(serialized).toContain('partial');
    expect(content.root.items[0]!.parts[1]).toMatchObject({ text: imageText });
  });

  it('preserves original credentials in the existing share ZIP including nested title and profile settings', async () => {
    const makeEndpoint = ({ value }: { value: string }): import('@/01-models/types').HttpEndpoint => ({ type: 'openai', url: 'https://example.invalid/v1', httpHeaders: [['X-Credential', Secret.from({ value })]] });
    const settings: Settings = {
      storageType: 'local',
      mounts: [],
      endpoint: makeEndpoint({ value: 'global-original' }),
      titleGeneration: { endpoint: makeEndpoint({ value: 'global-title-original' }), model: { id: 'title-model' }, lmParameters: EMPTY_LM_PARAMETERS },
      providerProfiles: [{ id: toProviderProfileId({ raw: 'profile-share' }), name: 'Shared profile', endpoint: makeEndpoint({ value: 'profile-original' }) }],
    };
    const chat: Chat = {
      id: toChatId({ raw: 'chat-share-secrets' }),
      title: 'Shared',
      root: { items: [] },
      createdAt: 1,
      updatedAt: 2,
      debugEnabled: false,
      endpoint: makeEndpoint({ value: 'chat-original' }),
      titleGeneration: { endpoint: makeEndpoint({ value: 'chat-title-original' }), model: { id: 'title-model' }, lmParameters: EMPTY_LM_PARAMETERS },
    };
    vi.mocked(storageService.loadSettings).mockResolvedValue(settings);
    vi.mocked(storageService.loadChat).mockResolvedValue(chat);
    const url = new URL(await generateChatShareURL({ chatId: chat.id }));
    const encoded = new URLSearchParams(url.hash.slice(url.hash.indexOf('?') + 1)).get('data-zip');
    expect(encoded).not.toBeNull();
    const zip = await JSZip.loadAsync(encoded!, { base64: true });
    const settingsEntry = Object.values(zip.files).find(entry => entry.name.endsWith('/settings.json'));
    const metasEntry = Object.values(zip.files).find(entry => entry.name.endsWith('/chat-metas.json'));
    expect(settingsEntry).toBeDefined();
    expect(metasEntry).toBeDefined();
    const exportedSettings = await settingsEntry!.async('string');
    const exportedMetas = await metasEntry!.async('string');
    for (const value of ['global-original', 'global-title-original', 'profile-original']) {
      expect(exportedSettings).toContain(value);
    }
    for (const value of ['chat-original', 'chat-title-original']) {
      expect(exportedMetas).toContain(value);
    }
    expect(exportedSettings).not.toContain('[masked]');
    expect(exportedMetas).not.toContain('[masked]');
    expect(JSON.stringify({ settings, chat })).not.toContain('original');
  });
});
