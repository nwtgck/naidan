import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useChat } from './useChat';
import { storageService } from '../services/storage';
import { SENTINEL_IMAGE_PENDING } from '../utils/image-generation';
import { toRaw } from 'vue';

// Mock LLM
const mockOllamaChat = vi.fn();
const mockOllamaGenerateImage = vi.fn().mockResolvedValue(new Blob(['test'], { type: 'image/png' }));

vi.mock('../services/llm', () => {
  return {
    OllamaProvider: class {
      chat = mockOllamaChat;
      generateImage = mockOllamaGenerateImage;
    },
    OpenAIProvider: class {
      chat = vi.fn();
    },
  };
});

// Mock storage
vi.mock('../services/storage', () => ({
  storageService: {
    init: vi.fn(),
    listChats: vi.fn().mockResolvedValue([]),
    loadChat: vi.fn().mockImplementation(async (id) => ({ id, root: { items: [] } })),
    saveChat: vi.fn(),
    updateChatMeta: vi.fn(),
    updateChatContent: vi.fn().mockImplementation((id, updater) => Promise.resolve(updater({ id, root: { items: [] } }))),
    updateHierarchy: vi.fn().mockImplementation(async (updater) => updater({ items: [] })),
    loadHierarchy: vi.fn().mockResolvedValue({ items: [] }),
    listChatGroups: vi.fn().mockResolvedValue([]),
    getSidebarStructure: vi.fn().mockResolvedValue([]),
    subscribeToChanges: vi.fn().mockReturnValue(() => {}),
    notify: vi.fn(),
    getFile: vi.fn().mockResolvedValue(new Blob([])),
    canPersistBinary: true,
  },
}));

// Mock settings
vi.mock('./useSettings', () => ({
  useSettings: () => ({
    settings: { value: { endpointType: 'ollama', endpointUrl: 'http://localhost', storageType: 'local', defaultModelId: 'llama3' } },
    setIsOnboardingDismissed: vi.fn(),
    setOnboardingDraft: vi.fn(),
  }),
}));

describe('useChat Image Generation', () => {
  const chatStore = useChat();

  beforeEach(() => {
    vi.clearAllMocks();
    chatStore.availableModels.value = ['llama3', 'x/z-image-turbo:v1'];
    chatStore.__testOnly.clearLiveChatRegistry();
  });

  it('sendMessage in image mode adds sentinel markers', async () => {
    const chat = { id: 'chat-1', modelId: 'llama3', groupId: null, root: { items: [] } } as any;
    chatStore.registerLiveInstance(chat);
    chatStore.toggleImageMode({ chatId: 'chat-1' });

    const success = await chatStore.sendMessage('draw a cat', null, [], chat);
    expect(success).toBe(true);

    const userMessage = chat.root.items[0];
    const assistantMessage = userMessage.replies.items[0];

    // Initially it should be pending
    expect(userMessage.content).toContain('<!-- naidan_experimental_image_request');
    expect(assistantMessage.content).toBe(SENTINEL_IMAGE_PENDING);
  });

  it('sendImageRequest triggers message sending with correct parameters', async () => {
    const chat = { id: 'chat-1', modelId: 'llama3', groupId: null, root: { items: [] }, currentLeafId: 'leaf-1' } as any;
    chatStore.registerLiveInstance(chat);
    await chatStore.openChat('chat-1');
    
    // Verify currentChat is set
    expect(toRaw(chatStore.currentChat.value)).toMatchObject({ id: 'chat-1' });

    const updateSpy = vi.spyOn(storageService, 'updateChatContent');

    const success = await chatStore.sendImageRequest({
      prompt: 'a cat',
      width: 1024,
      height: 1024,
      attachments: []
    });

    expect(success).toBe(true);
    expect(updateSpy).toHaveBeenCalled();
    // Check if the content updated by storageService contains the image request
    const updater = updateSpy.mock.calls[0]![1];
    const result = (await updater({ id: 'chat-1', root: { items: [] } } as any)) as any;
    expect(result.root.items[0].content).toContain('<!-- naidan_experimental_image_request {"width":1024,"height":1024,"model":"x/z-image-turbo:v1"} -->a cat');
  });

  it('sendImageRequest with attachments passes them to sendMessage', async () => {
    const chat = { id: 'chat-attachments', modelId: 'llama3', groupId: null, root: { items: [] }, currentLeafId: 'leaf-1' } as any;
    chatStore.registerLiveInstance(chat);
    await chatStore.openChat('chat-attachments');
    
    const updateSpy = vi.spyOn(storageService, 'updateChatContent');
    const mockAttachment = { id: 'att-1', originalName: 'test.png', mimeType: 'image/png', status: 'memory', blob: new Blob(['test'], { type: 'image/png' }) } as any;

    const success = await chatStore.sendImageRequest({
      prompt: 'remix this image',
      width: 1024,
      height: 1024,
      attachments: [mockAttachment]
    });

    expect(success).toBe(true);
    // Check if the content updated by storageService contains the image request and attachments
    const updater = updateSpy.mock.calls[0]![1];
    const result = (await updater({ id: 'chat-attachments', root: { items: [] } } as any)) as any;
    expect(result.root.items[0].attachments).toHaveLength(1);
    expect(result.root.items[0].attachments[0].id).toBe('att-1');
  });

  it('generateChatTitle strips sentinels from content', async () => {
    const chat = { 
      id: 'chat-title-test', 
      title: 'New Chat',
      root: { 
        items: [{ 
          id: '1', role: 'user', content: '<!-- naidan_experimental_image_request {"w":512} -->A beautiful landscape', replies: { items: [] } 
        }] 
      } 
    } as any;
    chatStore.registerLiveInstance(chat);
    
    await chatStore.generateChatTitle('chat-title-test');

    expect(mockOllamaChat).toHaveBeenCalledWith(expect.objectContaining({
      messages: expect.arrayContaining([
        expect.objectContaining({ content: expect.stringContaining('A beautiful landscape') })
      ])
    }));
    
    // Ensure the sentinel is NOT in the prompt sent to LLM
    const sentPrompt = mockOllamaChat.mock.calls[0]![0].messages.find((m: any) => m.role === 'user')?.content;
    expect(sentPrompt).not.toContain('naidan_experimental');
  });

  it('forking a chat preserves image requests and allows regeneration', async () => {
    const chat = { 
      id: 'chat-fork', 
      root: { 
        items: [{ 
          id: 'u1', role: 'user', content: '<!-- naidan_experimental_image_request {"width":256,"height":256,"model":"x/z-image-turbo:v1"} -->small cat', 
          replies: { items: [{ id: 'a1', role: 'assistant', content: 'Failed', replies: { items: [] } }] } 
        }] 
      } 
    } as any;
    chatStore.registerLiveInstance(chat);
    
    // Mock loadChat to return the chat structure so forkChat can work
    vi.mocked(storageService.loadChat).mockResolvedValue(chat);

    // Fork from assistant message 'a1'
    const forkedChatId = await chatStore.forkChat('a1', 'chat-fork');
    
    expect(forkedChatId).toBeDefined();
    const forkedChat = chatStore.getLiveChat({ id: forkedChatId! } as any) as any;
    expect(forkedChat).toBeDefined();
    expect(forkedChat.root.items[0].content).toContain('naidan_experimental_image_request');
    
    // Regerenerating on the forked chat should trigger image generation again
    const updateSpy = vi.spyOn(storageService, 'updateChatContent');
    await chatStore.regenerateMessage('a1');
    
    expect(updateSpy).toHaveBeenCalled();
  });

  it('image mode and resolution are isolated between chats', () => {
    const chatA = 'chat-a';
    const chatB = 'chat-b';

    chatStore.toggleImageMode({ chatId: chatA });
    chatStore.updateResolution({ chatId: chatA, width: 1024, height: 1024 });

    expect(chatStore.isImageMode({ chatId: chatA })).toBe(true);
    expect(chatStore.getResolution({ chatId: chatA })).toEqual({ width: 1024, height: 1024 });

    expect(chatStore.isImageMode({ chatId: chatB })).toBe(false);
    expect(chatStore.getResolution({ chatId: chatB })).toEqual({ width: 512, height: 512 });
  });

  it('handleImageGeneration successfully processes a request', async () => {
    const chat = { 
      id: 'chat-img-process', 
      modelId: 'llama3', 
      root: { 
        items: [{ 
          id: 'u1', role: 'user', content: '<!-- naidan_experimental_image_request {"width":256,"height":256,"model":"x/z-image-turbo:v1"} -->cat', 
          replies: { items: [{ id: 'a1', role: 'assistant', content: '', replies: { items: [] } }] } 
        }] 
      } 
    } as any;
    chatStore.registerLiveInstance(chat);
    
    const updateSpy = vi.spyOn(storageService, 'updateChatContent');
    
    // Directly call regenerateMessage to trigger background generation
    await chatStore.regenerateMessage('a1');
    
    // It should trigger updateChatContent at least once (for pending)
    await vi.waitFor(() => {
      expect(updateSpy).toHaveBeenCalled();
    }, { timeout: 2000 });
  });
});
