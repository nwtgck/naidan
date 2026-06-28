import { describe, it, expect, vi, beforeEach } from 'vitest';

const chats = new Map<string, any>();
let hierarchy = { items: [] as any[] };

vi.unmock('../services/lm/openai');
vi.unmock('../services/lm/ollama');
vi.unmock('../services/storage');

describe('useChat Persistence Timing', () => {
  let persistMock: any;
  let persistedMock: any;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    chats.clear();
    hierarchy = { items: [] };

    vi.doMock('../services/lm/openai', () => ({
      OpenAIProvider: class {
        chat = vi.fn().mockImplementation((params: { onChunk: (params: { chunk: string }) => void }) => {
          params.onChunk({ chunk: 'Done' });
          return Promise.resolve();
        });
        listModels = vi.fn().mockResolvedValue(['gpt-4']);
      },
    }));

    vi.doMock('../services/lm/ollama', () => ({
      OllamaProvider: class {
        chat = vi.fn();
        listModels = vi.fn().mockResolvedValue(['gpt-4']);
      },
    }));

    vi.doMock('../services/storage', () => ({
      storageService: {
        getSidebarStructure: vi.fn().mockResolvedValue([]),
        saveChat: vi.fn().mockImplementation((chat) => {
          chats.set(chat.id, chat);
          return Promise.resolve();
        }),
        loadChat: vi.fn().mockImplementation(({ id }: { id: string }) => Promise.resolve(chats.get(id) ?? null)),
        loadChatMeta: vi.fn().mockImplementation(({ id }: { id: string }) => Promise.resolve(chats.get(id) ?? null)),
        updateChatContent: vi.fn().mockImplementation(({ id, updater }) => {
          const existing = chats.get(id) || null;
          const current = existing ? { root: existing.root, currentLeafId: existing.currentLeafId } : null;
          const updated = updater({ current: current });
          if (existing) chats.set(id, { ...existing, ...updated });
          return Promise.resolve(updated);
        }),
        updateChatMeta: vi.fn().mockImplementation(({ id, updater }) => {
          const existing = chats.get(id) || null;
          const updated = updater({ current: existing });
          if (updated) chats.set(id, { ...existing, ...updated });
          return Promise.resolve(updated);
        }),
        updateHierarchy: vi.fn().mockImplementation(({ updater }) => {
          hierarchy = updater({ current: hierarchy });
          return Promise.resolve(hierarchy);
        }),
        loadHierarchy: vi.fn().mockImplementation(() => Promise.resolve(hierarchy)),
        listChats: vi.fn().mockResolvedValue([]),
        listChatGroups: vi.fn().mockResolvedValue([]),
        updateSettings: vi.fn().mockResolvedValue({}),
        loadSettings: vi.fn().mockResolvedValue({}),
        loadChatGroup: vi.fn().mockResolvedValue(null),
        getFile: vi.fn().mockResolvedValue(new Blob([])),
        notify: vi.fn(),
        subscribeToChanges: vi.fn(),
        getCurrentType: vi.fn().mockReturnValue('local'),
        canPersistBinary: false,
        init: vi.fn().mockResolvedValue(undefined),
      },
    }));

    persistMock = vi.fn().mockResolvedValue(true);
    persistedMock = vi.fn().mockResolvedValue(false);

    Object.defineProperty(global.navigator, 'storage', {
      value: {
        persist: persistMock,
        persisted: persistedMock,
      },
      configurable: true,
      writable: true,
    });

    const { useSettings } = await import('./useSettings');
    const settings = useSettings();
    await settings.save({
      patch: {
        endpointType: 'openai',
        endpointUrl: 'http://localhost:11434',
        defaultModelId: 'gpt-4',
        autoTitleEnabled: false,
        storageType: 'local',
        providerProfiles: [],
      } as any,
      modelRefresh: 'await',
    });
  });

  it('should call navigator.storage.persist after the first assistant response', async () => {
    const { useChat } = await import('./useChat');
    const chatStore = useChat();
    const { sendMessage, createNewChat } = chatStore;

    await createNewChat({ groupId: undefined, modelId: undefined, systemPrompt: undefined });

    // First message (User -> Assistant)
    await sendMessage({ content: 'Hello' });
    // Wait for the persistence side effect directly; broad shard runs can leave
    // streaming state transitions interleaved with other module-isolation tests.
    await vi.waitUntil(() => persistMock.mock.calls.length === 1);

    expect(persistMock).toHaveBeenCalledTimes(1);
  }, 30000);

  it('should NOT call navigator.storage.persist after the second assistant response in the same chat', async () => {
    const { useChat } = await import('./useChat');
    const chatStore = useChat();
    const { sendMessage, createNewChat } = chatStore;

    await createNewChat({ groupId: undefined, modelId: undefined, systemPrompt: undefined });

    // First message
    await sendMessage({ content: 'Message 1' });
    await vi.waitUntil(() => persistMock.mock.calls.length === 1);
    expect(persistMock).toHaveBeenCalledTimes(1);

    // Second message
    await sendMessage({ content: 'Message 2' });
    await vi.waitUntil(() => !chatStore.streaming.value);
    expect(persistMock).toHaveBeenCalledTimes(1); // Still 1
  });

  it('should NOT call navigator.storage.persist for a new chat if already called in the session', async () => {
    const { useChat } = await import('./useChat');
    const chatStore = useChat();
    const { sendMessage, createNewChat } = chatStore;

    // Chat 1
    await createNewChat({ groupId: undefined, modelId: undefined, systemPrompt: undefined });
    await sendMessage({ content: 'Chat 1 Message 1' });
    await vi.waitUntil(() => persistMock.mock.calls.length === 1);
    expect(persistMock).toHaveBeenCalledTimes(1);

    // Chat 2
    await createNewChat({ groupId: undefined, modelId: undefined, systemPrompt: undefined });
    await sendMessage({ content: 'Chat 2 Message 1' });
    await vi.waitUntil(() => !chatStore.streaming.value);
    expect(persistMock).toHaveBeenCalledTimes(1); // Should still be 1 because of module-level session flag
  });
});
