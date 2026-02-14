import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useChat } from './useChat';
import { storageService } from '../services/storage';

// --- Shared Mocks ---
const mockAddToast = vi.fn();

vi.mock('../services/storage', () => ({
  storageService: {
    init: vi.fn(),
    listChats: vi.fn().mockResolvedValue([]),
    loadChat: vi.fn(),
    saveChat: vi.fn(),
    updateChatMeta: vi.fn().mockResolvedValue(undefined),
    loadChatMeta: vi.fn(),
    updateChatContent: vi.fn().mockImplementation((_id, updater) => Promise.resolve(updater(null))),
    updateHierarchy: vi.fn().mockImplementation((updater) => Promise.resolve(updater({ items: [] }))),
    loadHierarchy: vi.fn().mockResolvedValue({ items: [] }),
    deleteChat: vi.fn().mockResolvedValue(undefined),
    updateChatGroup: vi.fn().mockResolvedValue(undefined),
    listChatGroups: vi.fn().mockResolvedValue([]),
    getSidebarStructure: vi.fn().mockResolvedValue([]),
    subscribeToChanges: vi.fn().mockReturnValue(() => {}),
    notify: vi.fn(),
  },
}));

vi.mock('./useSettings', () => ({
  useSettings: () => ({
    settings: { value: {} },
    isOnboardingDismissed: { value: true },
    onboardingDraft: { value: null },
  }),
}));

vi.mock('./useToast', () => ({
  useToast: () => ({
    addToast: mockAddToast,
    removeToast: vi.fn(),
  }),
}));

describe('useChat Delete Undo Logic', () => {
  const chatStore = useChat();
  const { deleteChat, __testOnly } = chatStore;
  const { activeGenerations } = __testOnly;

  let capturedOnClose: ((reason: any) => void) | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    capturedOnClose = undefined;

    mockAddToast.mockImplementation((options: any) => {
      capturedOnClose = options.onClose;
      return 'toast-id';
    });
  });

  it('should delay storage deletion and abort until toast is closed', async () => {
    const chatId = 'test-chat-id';
    const mockAbort = vi.fn();

    // 1. Mock an active generation
    activeGenerations.set(chatId, {
      controller: { abort: mockAbort } as any,
      chat: { id: chatId } as any
    });

    // 2. Mock chat data in storage
    vi.mocked(storageService.loadChat).mockResolvedValue({
      id: chatId,
      title: 'Test Chat',
      root: { items: [] }
    } as any);

    // 3. Trigger delete
    await deleteChat(chatId);

    // VERIFY: Toast was shown and returned truthy ID
    expect(mockAddToast).toHaveBeenCalled();

    // VERIFY: Hierarchy is updated, but cleanup (Abort/Delete) is NOT done yet
    expect(vi.mocked(storageService.updateHierarchy)).toHaveBeenCalled();
    expect(mockAbort).not.toHaveBeenCalled();
    expect(vi.mocked(storageService.deleteChat)).not.toHaveBeenCalled();
    expect(capturedOnClose).toBeDefined();

    // 4. Simulate toast timeout/dismiss
    if (capturedOnClose) await capturedOnClose('timeout');

    // VERIFY: Now cleanup is executed
    expect(mockAbort).toHaveBeenCalled();
    expect(vi.mocked(storageService.deleteChat)).toHaveBeenCalledWith(chatId);
    expect(activeGenerations.has(chatId)).toBe(false);
  });

  it('should NOT execute cleanup if Undo is clicked', async () => {
    const chatId = 'test-chat-id';
    const mockAbort = vi.fn();

    activeGenerations.set(chatId, {
      controller: { abort: mockAbort } as any,
      chat: { id: chatId } as any
    });

    vi.mocked(storageService.loadChat).mockResolvedValue({
      id: chatId,
      title: 'Test Chat',
      root: { items: [] }
    } as any);

    await deleteChat(chatId);

    // 4. Simulate Undo click (reason: action)
    if (capturedOnClose) await capturedOnClose('action');

    // VERIFY: Cleanup is skipped
    expect(mockAbort).not.toHaveBeenCalled();
    expect(vi.mocked(storageService.deleteChat)).not.toHaveBeenCalled();
    expect(activeGenerations.has(chatId)).toBe(true);
  });
});