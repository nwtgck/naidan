import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useChat } from './useChat';
import { useSettings } from './useSettings';
import { storageService } from '../services/storage';
import { ref, reactive } from 'vue';
import type { Attachment } from '../models/types';

// Mock dependencies
const chats = new Map<string, any>();
let hierarchy = { items: [] as any[] };

vi.mock('./useSettings', () => ({
  useSettings: vi.fn().mockReturnValue({
    settings: {
      value: {
        endpointUrl: 'http://localhost:11434',
        endpointType: 'openai',
        defaultModelId: 'test-model'
      }
    },
    isOnboardingDismissed: { value: true },
    onboardingDraft: { value: null }
  })
}));

vi.mock('../services/storage', () => ({
  storageService: {
    init: vi.fn(),
    subscribeToChanges: vi.fn().mockReturnValue(() => {}),
    saveChat: vi.fn().mockImplementation((chat) => {
      chats.set(chat.id, chat);
      return Promise.resolve();
    }),
    updateChatMeta: vi.fn().mockImplementation((id, updater) => {
      const existing = chats.get(id) || { id, root: { items: [] } };
      const updated = updater(existing);
      const merged = { ...existing, ...updated };
      chats.set(id, merged);
      return Promise.resolve();
    }),
    loadChatMeta: vi.fn().mockImplementation((id) => Promise.resolve(chats.get(id))),
    updateChatContent: vi.fn().mockImplementation((id, updater) => {
      const existing = chats.get(id) || { id, root: { items: [] } };
      const updated = updater({ root: existing.root, currentLeafId: existing.currentLeafId });
      const merged = { ...existing, ...updated };
      chats.set(id, merged);
      return Promise.resolve();
    }),
    updateHierarchy: vi.fn().mockImplementation((updater) => {
      hierarchy = updater(hierarchy);
      return Promise.resolve();
    }),
    loadHierarchy: vi.fn().mockImplementation(() => Promise.resolve(hierarchy)),
    loadChat: vi.fn().mockImplementation((id) => {
      const chat = chats.get(id);
      if (!chat) return Promise.resolve(null);
      return Promise.resolve(chat);
    }),
    listChats: vi.fn().mockImplementation(() => Promise.resolve(Array.from(chats.values()))),
    listChatGroups: vi.fn().mockImplementation(() => {
      return Promise.resolve(hierarchy.items.filter(i => i.type === 'chat_group').map(i => i.chatGroup));
    }),
    getSidebarStructure: vi.fn().mockImplementation(() => {
      return Promise.resolve(Array.from(chats.values()).map(c => ({
        id: `chat:${c.id}`,
        type: 'chat',
        chat: { id: c.id, title: c.title, updatedAt: c.updatedAt, groupId: c.groupId }
      })));
    }),
    saveFile: vi.fn().mockResolvedValue(undefined),
    getFile: vi.fn().mockResolvedValue(new Blob(['data'])),
    switchProvider: vi.fn().mockResolvedValue(undefined),
    notify: vi.fn(),
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
      chat = vi.fn().mockImplementation((_msgs: any, _model: any, _end: any, onChunk: any) => {
        onChunk('Response');
        return Promise.resolve();
      });
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
  const chatStore = useChat();

  beforeEach(() => {
    vi.clearAllMocks();
    chats.clear();
    hierarchy = { items: [] };
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
      onboardingDraft: ref({}),
      setHeavyContentAlertDismissed: (val: boolean) => { settings.value.heavyContentAlertDismissed = val; },
      setOnboardingDraft: vi.fn(),
      setIsOnboardingDismissed: vi.fn(),
    });
    (storageService as any).canPersistBinary = false;
  });

  it('should keep attachments in memory status when using LocalStorage', async () => {
    const { sendMessage, createNewChat, openChat } = chatStore;
    const newChat = await createNewChat();
    const chatObj = await openChat(newChat!.id);

    const mockAttachment: Attachment = {
      id: '550e8400-e29b-41d4-a716-446655440000',
      originalName: 'test.png',
      mimeType: 'image/png',
      size: 100,
      uploadedAt: Date.now(),
      status: 'memory',
      blob: new Blob(['fake image'], { type: 'image/png' })
    };

    await sendMessage('Hello', null, [mockAttachment], chatObj!);

    const chat = await storageService.loadChat(newChat!.id);
    const message = chat?.root.items[0];
    expect(message?.attachments).toHaveLength(1);
    const attachments = message!.attachments!;
    expect(attachments[0]!.status).toBe('memory');
    expect(storageService.saveFile).not.toHaveBeenCalled();
  });

  it('should persist attachments immediately when using OPFS', async () => {
    settings.value.storageType = 'opfs';
    (storageService as any).canPersistBinary = true;
    
    const { sendMessage, createNewChat, openChat } = chatStore;
    const newChat = await createNewChat();
    const chatObj = await openChat(newChat!.id);

    const mockAttachment: Attachment = {
      id: '550e8400-e29b-41d4-a716-446655440001',
      originalName: 'test.png',
      mimeType: 'image/png',
      size: 100,
      uploadedAt: Date.now(),
      status: 'memory',
      blob: new Blob(['fake image'], { type: 'image/png' })
    };

    await sendMessage('Hello', null, [mockAttachment], chatObj!);

    const chat = await storageService.loadChat(newChat!.id);
    const message = chat?.root.items[0];
    expect(message?.attachments).toBeDefined();
    if (message?.attachments) {
      const attachments = message.attachments;
      expect(attachments[0]!.status).toBe('persisted');
    }
    expect(storageService.saveFile).toHaveBeenCalled();
  });

  it('should rescue memory blobs during migration from LocalStorage to OPFS', async () => {
    const { sendMessage, __testOnly, registerLiveInstance } = chatStore;
    const { __testOnlySetCurrentChat } = __testOnly;
    const chatObj = reactive({
      id: 'rescue-chat',
      title: 'Rescue',
      root: { items: [] },
      createdAt: Date.now(),
      updatedAt: Date.now(),
      debugEnabled: false,
      modelId: 'm1'
    }) as any;
    __testOnlySetCurrentChat(chatObj);
    registerLiveInstance(chatObj);

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
    await sendMessage('Initial message', null, [mockAttachment], chatObj);
    const initialMsg = chatObj.root.items[0];
    expect(initialMsg?.attachments).toBeDefined();
    const initialAtts = initialMsg!.attachments!;
    expect(initialAtts[0]!.status).toBe('memory');

    // 2. Prepare for OPFS
    settings.value.storageType = 'opfs';
    (storageService as any).canPersistBinary = true;
    
    // Mock switchProvider to simulate rescue and status update
    (storageService.switchProvider as any).mockImplementation(async () => {
      const msg = chatObj.root.items[0];
      if (msg && msg.attachments) {
        for (let i = 0; i < msg.attachments.length; i++) {
          const att = msg.attachments[i];
          if (att && att.status === 'memory') {
            const blob = (att as any).blob;
            await storageService.saveFile(blob, att.id, att.originalName);
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
    });

    await storageService.switchProvider('opfs');

    // 3. Verify rescue occurred
    expect(storageService.saveFile).toHaveBeenCalledWith(
      mockBlob,
      '550e8400-e29b-41d4-a716-446655440002',
      'to-migrate.png'
    );
    
    const chat = await storageService.loadChat('rescue-chat');
    const finalMsg = chat!.root.items[0];
    expect(finalMsg?.attachments).toBeDefined();
    const finalAtts = finalMsg!.attachments!;
    expect(finalAtts[0]!.status).toBe('persisted');
  });
});
