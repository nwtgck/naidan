import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { useSampleChat } from './useSampleChat';
import { useChat } from './useChat';
import { storageService } from '@/services/storage';

// Mock dependencies
vi.mock('./useChat', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    useChat: vi.fn(),
  };
});

vi.mock('../services/storage', () => ({
  storageService: {
    init: vi.fn(),
    subscribeToChanges: vi.fn().mockReturnValue(() => {}),
    updateChatContent: vi.fn(),
    updateChatMeta: vi.fn(),
    updateHierarchy: vi.fn(),
  },
}));

describe('useSampleChat', () => {
  const mockLoadChats = vi.fn();
  const mockOpenChat = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    (useChat as unknown as Mock).mockReturnValue({
      loadChats: mockLoadChats,
      openChat: mockOpenChat,
    });
    // Mock updateHierarchy to just call the callback
    vi.mocked(storageService.updateHierarchy).mockImplementation(async (updater) => {
      await updater({ items: [] });
    });
  });

  it('creates a sample chat with rich markdown, thinking process, and branches', async () => {
    const { createSampleChat } = useSampleChat();
    await createSampleChat();

    // Verify storage calls
    const contentCall = vi.mocked(storageService.updateChatContent).mock.calls[0];
    expect(contentCall).toBeDefined();
    const content = await contentCall![1](null);

    const metaCall = vi.mocked(storageService.updateChatMeta).mock.calls[0];
    expect(metaCall).toBeDefined();
    const meta = await metaCall![1](null);
    const chatId = metaCall![0];

    expect(chatId).toBeDefined();
    expect(meta.title).toBe('🚀 Sample: Tree Showcase');
    expect(meta.debugEnabled).toBe(true);

    expect(storageService.updateHierarchy).toHaveBeenCalled();

    // 1. Verify Structure (m1 -> [m2, m3])
    const rootItems = content.root.items;
    expect(rootItems).toHaveLength(1);
    const m1 = rootItems[0]!;
    expect(m1.role).toBe('user');
    expect(m1.replies.items).toHaveLength(2);

    const m2 = m1.replies.items[0]!;
    const m3 = m1.replies.items[1]!;
    expect(m2.role).toBe('assistant');
    expect(m3.role).toBe('assistant');

    // 2. Verify Thinking Process Extraction (m2 should have thinking)
    expect(m2.thinking).toBeDefined();
    expect(m2.thinking?.length).toBeGreaterThan(0);
    expect(m2.content).not.toContain('<think>'); // Should be stripped

    // 3. Verify Markdown Features in m2 content
    expect(m2.content).toContain('```python');   // Code blocks
    expect(m2.content).toContain('$$');          // Math
    expect(m2.content).toContain('```mermaid');  // Diagrams
    expect(m2.content).toContain('|');           // Tables
    expect(m2.content).toContain('- [x]');       // Task lists

    // 4. Verify Branching/Versioning demo in m3
    expect(m3.content).toContain('alternative response');
    expect(m3.content).toContain('arrows');

    expect(mockLoadChats).toHaveBeenCalled();
    expect(mockOpenChat).toHaveBeenCalledWith(chatId);
  });

  it('creates a long sample chat for navigation stress testing without large fixtures', async () => {
    const { createLongSampleChat } = useSampleChat();
    await createLongSampleChat();

    const contentCall = vi.mocked(storageService.updateChatContent).mock.calls[0];
    expect(contentCall).toBeDefined();
    const content = await contentCall![1](null);

    const metaCall = vi.mocked(storageService.updateChatMeta).mock.calls[0];
    expect(metaCall).toBeDefined();
    const meta = await metaCall![1](null);
    const chatId = metaCall![0];

    expect(meta.title).toBe('Long Sample: Outline Stress Test');
    expect(meta.debugEnabled).toBe(false);

    const messages: Array<{ id: string; role: string; content: string | undefined }> = [];
    let current = content.root.items[0];
    while (current) {
      messages.push({ id: current.id, role: current.role, content: current.content });
      current = current.replies.items[0];
    }

    expect(messages).toHaveLength(36);
    expect(messages[0]?.role).toBe('user');
    expect(messages[1]?.role).toBe('assistant');
    expect(messages[0]?.content?.length).toBeGreaterThan(600);
    expect(messages[1]?.content?.length).toBeGreaterThan(900);
    expect(content.currentLeafId).toBe(messages[messages.length - 1]?.id);
    expect(mockLoadChats).toHaveBeenCalled();
    expect(mockOpenChat).toHaveBeenCalledWith(chatId);
  });
});
