import { describe, it, expect, beforeEach, vi } from 'vitest';
import { reactive } from 'vue';
import { useChatTools } from './useChatTools';
import type { Chat } from '@/models/types';
import { currentChatRef, liveChatRegistry } from '@/composables/chat/global/chat-core-singletons';
import { useSettings } from './useSettings';
import { storageService } from '@/services/storage';

vi.mock('@/services/storage', () => ({
  storageService: {
    subscribeToChanges: vi.fn().mockReturnValue(() => {}),
    updateChatMeta: vi.fn().mockResolvedValue(undefined),
    updateSettings: vi.fn().mockResolvedValue(undefined),
    getCurrentType: vi.fn().mockReturnValue('local'),
  },
}));

describe('useChatTools', () => {
  beforeEach(() => {
    const { setCurrentChatId, TEST_ONLY } = useChatTools();
    setCurrentChatId({ chatId: null });
    TEST_ONLY._runtimeToolConfigsByChat.value = new Map();
    currentChatRef.value = null;
    liveChatRegistry.clear();
    vi.mocked(storageService.updateChatMeta).mockClear();
    useSettings().TEST_ONLY.__testOnlyReset();
  });

  function setToolConfigPersistence({ persistence }: { persistence: 'disabled' | 'enabled' }) {
    useSettings().TEST_ONLY.__testOnlySetSettings({
      newSettings: {
        autoTitleEnabled: true,
        providerProfiles: [],
        mounts: [],
        heavyContentAlertDismissed: false,
        storageType: 'local',
        endpointType: 'openai',
        experimental: {
          toolConfigPersistence: persistence,
        },
      },
    });
  }

  function createTestChat({
    id,
    toolConfigs,
  }: {
    id: string;
    toolConfigs?: Chat['toolConfigs'];
  }): Chat {
    return reactive({
      id,
      title: null,
      root: { items: [] },
      createdAt: 0,
      updatedAt: 0,
      debugEnabled: false,
      toolConfigs,
    }) as Chat;
  }

  describe('isToolEnabled', () => {
    it('returns false when no current chat is set', () => {
      const { isToolEnabled } = useChatTools();
      expect(isToolEnabled({ name: 'calculator' })).toBe(false);
      expect(isToolEnabled({ name: 'shell_execute' })).toBe(false);
    });

    it('returns false for a tool that has not been enabled in the current chat', () => {
      const { setCurrentChatId, isToolEnabled } = useChatTools();
      setCurrentChatId({ chatId: 'chat-1' });
      expect(isToolEnabled({ name: 'calculator' })).toBe(false);
    });

    it('returns true after enabling a tool in the current chat', () => {
      const { setCurrentChatId, setToolEnabled, isToolEnabled } = useChatTools();
      setCurrentChatId({ chatId: 'chat-1' });
      setToolEnabled({ name: 'calculator', enabled: true });
      expect(isToolEnabled({ name: 'calculator' })).toBe(true);
    });

    it('uses a runtime overlay before persisted live chat toolConfigs', () => {
      const { setCurrentChatId, setToolEnabled, isToolEnabled } = useChatTools();
      setCurrentChatId({ chatId: 'chat-1' });
      setToolEnabled({ name: 'calculator', enabled: true });

      liveChatRegistry.set('chat-1', createTestChat({ id: 'chat-1', toolConfigs: undefined }));

      expect(isToolEnabled({ name: 'calculator' })).toBe(true);
    });

    it('updates the runtime overlay without mutating live chat metadata when persistence is disabled', () => {
      const { setCurrentChatId, setToolEnabled, isToolEnabled, TEST_ONLY } = useChatTools();
      const chat = createTestChat({ id: 'chat-1', toolConfigs: undefined });
      liveChatRegistry.set('chat-1', chat);
      setCurrentChatId({ chatId: 'chat-1' });

      setToolEnabled({ name: 'calculator', enabled: true });

      expect(isToolEnabled({ name: 'calculator' })).toBe(true);
      expect(chat.toolConfigs).toBeUndefined();
      expect(TEST_ONLY._runtimeToolConfigsByChat.value.get('chat-1')).toEqual([{ key: 'builtin.calculator' }]);
      expect(storageService.updateChatMeta).not.toHaveBeenCalled();
    });

    it('keeps runtime disables effective even when persisted config still contains the tool', () => {
      const { setCurrentChatId, setToolEnabled, isToolEnabled, TEST_ONLY } = useChatTools();
      const chat = createTestChat({ id: 'chat-1', toolConfigs: [{ key: 'builtin.calculator' }] });
      liveChatRegistry.set('chat-1', chat);
      setCurrentChatId({ chatId: 'chat-1' });

      expect(isToolEnabled({ name: 'calculator' })).toBe(true);

      setToolEnabled({ name: 'calculator', enabled: false });

      expect(isToolEnabled({ name: 'calculator' })).toBe(false);
      expect(chat.toolConfigs).toEqual([{ key: 'builtin.calculator' }]);
      expect(TEST_ONLY._runtimeToolConfigsByChat.value.get('chat-1')).toEqual([]);
      expect(storageService.updateChatMeta).not.toHaveBeenCalled();
    });

    it('persists tool changes into chat metadata when persistence is enabled', () => {
      setToolConfigPersistence({ persistence: 'enabled' });
      const { setCurrentChatId, setToolEnabled } = useChatTools();
      const chat = createTestChat({ id: 'chat-1', toolConfigs: undefined });
      liveChatRegistry.set('chat-1', chat);
      setCurrentChatId({ chatId: 'chat-1' });

      setToolEnabled({ name: 'calculator', enabled: true });

      expect(chat.toolConfigs).toEqual([{ key: 'builtin.calculator' }]);
      expect(storageService.updateChatMeta).toHaveBeenCalledWith({
        id: 'chat-1',
        updater: expect.any(Function),
      });
    });
  });

  describe('per-chat isolation', () => {
    it('enabling a tool in one chat does not affect another chat', () => {
      const { setCurrentChatId, setToolEnabled, isToolEnabled } = useChatTools();

      setCurrentChatId({ chatId: 'chat-1' });
      setToolEnabled({ name: 'calculator', enabled: true });
      setToolEnabled({ name: 'shell_execute', enabled: true });

      setCurrentChatId({ chatId: 'chat-2' });
      expect(isToolEnabled({ name: 'calculator' })).toBe(false);
      expect(isToolEnabled({ name: 'shell_execute' })).toBe(false);
    });

    it('each chat independently retains its own tool state', () => {
      const { setCurrentChatId, setToolEnabled, isToolEnabled } = useChatTools();

      setCurrentChatId({ chatId: 'chat-1' });
      setToolEnabled({ name: 'calculator', enabled: true });

      setCurrentChatId({ chatId: 'chat-2' });
      setToolEnabled({ name: 'shell_execute', enabled: true });

      setCurrentChatId({ chatId: 'chat-1' });
      expect(isToolEnabled({ name: 'calculator' })).toBe(true);
      expect(isToolEnabled({ name: 'shell_execute' })).toBe(false);

      setCurrentChatId({ chatId: 'chat-2' });
      expect(isToolEnabled({ name: 'calculator' })).toBe(false);
      expect(isToolEnabled({ name: 'shell_execute' })).toBe(true);
    });
  });

  describe('setToolEnabled', () => {
    it('does nothing when no current chat is set', () => {
      const { setToolEnabled, isToolEnabled } = useChatTools();
      setToolEnabled({ name: 'calculator', enabled: true });
      expect(isToolEnabled({ name: 'calculator' })).toBe(false);
    });

    it('can disable a previously enabled tool', () => {
      const { setCurrentChatId, setToolEnabled, isToolEnabled } = useChatTools();
      setCurrentChatId({ chatId: 'chat-1' });
      setToolEnabled({ name: 'calculator', enabled: true });
      setToolEnabled({ name: 'calculator', enabled: false });
      expect(isToolEnabled({ name: 'calculator' })).toBe(false);
    });
  });

  describe('toggleTool', () => {
    it('toggles a tool on and off within the current chat', () => {
      const { setCurrentChatId, toggleTool, isToolEnabled } = useChatTools();
      setCurrentChatId({ chatId: 'chat-1' });

      toggleTool({ name: 'calculator' });
      expect(isToolEnabled({ name: 'calculator' })).toBe(true);

      toggleTool({ name: 'calculator' });
      expect(isToolEnabled({ name: 'calculator' })).toBe(false);
    });
  });

  describe('enabledToolNames', () => {
    it('returns empty array when no current chat is set', () => {
      const { enabledToolNames } = useChatTools();
      expect(enabledToolNames.value).toEqual([]);
    });

    it('returns enabled tool names for the current chat', () => {
      const { setCurrentChatId, setToolEnabled, enabledToolNames } = useChatTools();
      setCurrentChatId({ chatId: 'chat-1' });
      setToolEnabled({ name: 'calculator', enabled: true });
      setToolEnabled({ name: 'shell_execute', enabled: true });
      expect(enabledToolNames.value).toContain('calculator');
      expect(enabledToolNames.value).toContain('shell_execute');
    });

    it('reflects only the current chat tools after switching', () => {
      const { setCurrentChatId, setToolEnabled, enabledToolNames } = useChatTools();

      setCurrentChatId({ chatId: 'chat-1' });
      setToolEnabled({ name: 'calculator', enabled: true });

      setCurrentChatId({ chatId: 'chat-2' });
      expect(enabledToolNames.value).toEqual([]);
    });
  });
});
