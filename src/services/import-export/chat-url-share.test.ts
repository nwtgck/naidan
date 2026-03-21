import { describe, it, expect, vi, beforeEach } from 'vitest';
import { generateChatShareURL } from './chat-url-share';
import { storageService } from '@/services/storage';
import { EMPTY_LM_PARAMETERS } from '@/models/types';

// Define global constants that Vite normally provides
(global as any).__APP_VERSION__ = '0.0.0-test';

vi.mock('../storage', () => ({
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
    autoTitleEnabled: true,
    storageType: 'local' as const,
    endpointType: 'openai' as const,
    providerProfiles: [],
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

    const url = await generateChatShareURL({ chatId: 'chat-1' });

    expect(storageService.loadChat).toHaveBeenCalledWith('chat-1');
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
            content: 'Here is an image',
            timestamp: Date.now(),
            attachments: [
              {
                id: 'att-1',
                binaryObjectId: 'bin-1',
                originalName: 'image.png',
                mimeType: 'image/png',
                size: 100,
                uploadedAt: Date.now(),
                status: 'persisted' as const
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
      createdAt: Date.now()
    });
    (storageService.loadSettings as any).mockResolvedValue(validSettings);

    const url = await generateChatShareURL({ chatId: 'chat-1' });

    expect(storageService.getFile).toHaveBeenCalledWith('bin-1');
    expect(url).toContain('data-zip=');
  });
});
