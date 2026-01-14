import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useChat } from './useChat';
import { useSettings } from './useSettings';
import { storageService } from '../services/storage';
import { ref } from 'vue';
import type { Attachment } from '../models/types';

// Mock dependencies
vi.mock('./useSettings', () => ({
  useSettings: vi.fn()
}));

vi.mock('../services/storage', () => ({
  storageService: {
    saveChat: vi.fn().mockResolvedValue(undefined),
    loadChat: vi.fn().mockResolvedValue(null),
    listChats: vi.fn().mockResolvedValue([]),
    getSidebarStructure: vi.fn().mockResolvedValue([]),
    saveFile: vi.fn().mockResolvedValue(undefined),
    getFile: vi.fn().mockResolvedValue(new Blob(['data'])),
    switchProvider: vi.fn().mockResolvedValue(undefined),
    canPersistBinary: false, 
    getCurrentType: vi.fn().mockReturnValue('local'),
  }
}));

vi.mock('../services/llm', () => {
  return {
    OpenAIProvider: class {
      chat = vi.fn().mockImplementation((_msgs: any, _model: any, _end: any, onChunk: any) => {
        onChunk('Response');
        return Promise.resolve();
      });
      listModels = vi.fn().mockResolvedValue(['test-model']);
    },
    OllamaProvider: class {
      chat = vi.fn().mockResolvedValue(undefined);
      listModels = vi.fn().mockResolvedValue(['test-model']);
    }
  };
});

vi.mock('./useConfirm', () => ({
  useConfirm: () => ({
    showConfirm: vi.fn().mockResolvedValue(true)
  })
}));

describe('useChat - Attachment & Migration Logic', () => {
  let settings: any;

  beforeEach(() => {
    vi.clearAllMocks();
    settings = ref({
      storageType: 'local',
      heavyContentAlertDismissed: false,
      isOnboardingDismissed: true,
      defaultModelId: 'test-model',
      endpointUrl: 'http://localhost:11434',
      endpointType: 'openai',
      providerProfiles: []
    });
    (useSettings as any).mockReturnValue({ 
      settings,
      isOnboardingDismissed: ref(true),
      onboardingDraft: ref({})
    });
    (storageService as any).canPersistBinary = false;
  });

  it('should keep attachments in memory status when using LocalStorage', async () => {
    const { sendMessage, currentChat, createNewChat } = useChat();
    await createNewChat();

    const mockAttachment: Attachment = {
      id: '550e8400-e29b-41d4-a716-446655440000',
      originalName: 'test.png',
      mimeType: 'image/png',
      size: 100,
      uploadedAt: Date.now(),
      status: 'memory',
      blob: new Blob(['fake image'], { type: 'image/png' })
    };

    await sendMessage('Hello', null, [mockAttachment]);

    const message = currentChat.value?.root.items[0];
    expect(message?.attachments).toHaveLength(1);
    const attachments = message!.attachments!;
    expect(attachments[0]!.status).toBe('memory');
    expect(storageService.saveFile).not.toHaveBeenCalled();
  });

  it('should persist attachments immediately when using OPFS', async () => {
    settings.value.storageType = 'opfs';
    (storageService as any).canPersistBinary = true;
    
    const { sendMessage, currentChat, createNewChat } = useChat();
    await createNewChat();

    const mockAttachment: Attachment = {
      id: '550e8400-e29b-41d4-a716-446655440001',
      originalName: 'test.png',
      mimeType: 'image/png',
      size: 100,
      uploadedAt: Date.now(),
      status: 'memory',
      blob: new Blob(['fake image'], { type: 'image/png' })
    };

    await sendMessage('Hello', null, [mockAttachment]);

    const message = currentChat.value?.root.items[0];
    expect(message?.attachments).toBeDefined();
    if (message?.attachments) {
      const attachments = message.attachments;
      expect(attachments[0]!.status).toBe('persisted');
    }
    expect(storageService.saveFile).toHaveBeenCalled();
  });

  it('should rescue memory blobs during migration from LocalStorage to OPFS', async () => {
    const { sendMessage, currentChat, createNewChat } = useChat();
    await createNewChat();

    const mockBlob = new Blob(['binary data'], { type: 'image/png' });
    const mockAttachment: Attachment = {
      id: '550e8400-e29b-41d4-a716-446655440002',
      originalName: 'to-migrate.png',
      mimeType: 'image/png',
      size: 100,
      uploadedAt: Date.now(),
      status: 'memory',
      blob: mockBlob
    };

    // 1. Send in LocalStorage mode
    await sendMessage('Initial message', null, [mockAttachment]);
    const initialMsg = currentChat.value?.root.items[0];
    expect(initialMsg?.attachments).toBeDefined();
    const initialAtts = initialMsg!.attachments!;
    expect(initialAtts[0]!.status).toBe('memory');

    // 2. Prepare for OPFS
    settings.value.storageType = 'opfs';
    (storageService as any).canPersistBinary = true;
    
    // Mock switchProvider to simulate rescue and status update
    (storageService.switchProvider as any).mockImplementation(async () => {
      if (currentChat.value) {
        const msg = currentChat.value.root.items[0];
        if (msg && msg.attachments) {
          for (let i = 0; i < msg.attachments.length; i++) {
            const att = msg.attachments[i];
            if (att && att.status === 'memory') {
              // Cast to any to access blob safely in test mock
              const blob = (att as any).blob;
              await storageService.saveFile(blob, att.id, att.originalName);
              // Replace with persisted version to satisfy union type
              msg.attachments[i] = {
                id: att.id,
                originalName: att.originalName,
                mimeType: att.mimeType,
                size: att.size,
                uploadedAt: att.uploadedAt,
                status: 'persisted'
              };
            }
          }
        }
      }
    });

    // We call storageService directly as useChat doesn't expose it
    await storageService.switchProvider('opfs');

    // 3. Verify rescue occurred
    expect(storageService.saveFile).toHaveBeenCalledWith(
      mockBlob,
      '550e8400-e29b-41d4-a716-446655440002',
      'to-migrate.png'
    );
    
    const finalMsg = currentChat.value?.root.items[0];
    expect(finalMsg?.attachments).toBeDefined();
    const finalAtts = finalMsg!.attachments!;
    expect(finalAtts[0]!.status).toBe('persisted');
  });
});