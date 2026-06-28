import { describe, it, expect, beforeEach, vi } from 'vitest';
import { reactive } from 'vue';
import { getEffectiveToolConfigsForChat, useChatTools } from './useChatTools';
import type { Chat, ChatMeta } from '@/01-models/types';
import type { ChatId } from '@/01-models/ids';
import { toChatGroupId, toChatId } from '@/01-models/ids';
import { currentChatRef, liveChatRegistry, rootItems } from '@/composables/chat/global/chat-core-singletons';
import { useSettings } from '../../../composables/useSettings';
import { storageService } from '@/00-storage/service';

vi.mock('@/00-storage/service', () => ({
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
    TEST_ONLY._runtimeToolConfigChangesByChat.value = new Map();
    currentChatRef.value = null;
    liveChatRegistry.clear();
    rootItems.value = [];
    vi.mocked(storageService.updateChatMeta).mockClear();
    vi.mocked(storageService.updateChatMeta).mockImplementation(async ({ id, updater }) => {
      await updater({ current: liveChatRegistry.get(id) ?? null });
    });
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
        endpoint: { type: 'openai', url: '' },
        experimental: {
          toolConfigPersistence: persistence,
        },
      },
    });
  }

  function createTestChat({
    id,
    toolConfigs,
    groupId,
  }: {
    id: ChatId,
    toolConfigs?: Chat['toolConfigs'],
    groupId?: Chat['groupId'],
  }): Chat {
    return reactive({
      id,
      title: null,
      root: { items: [] },
      createdAt: 0,
      updatedAt: 0,
      debugEnabled: false,
      toolConfigs,
      groupId,
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
      setCurrentChatId({ chatId: toChatId({ raw: 'chat-1' }) });
      expect(isToolEnabled({ name: 'calculator' })).toBe(false);
    });

    it('returns true after enabling a tool in the current chat', () => {
      const { setCurrentChatId, setToolEnabled, isToolEnabled } = useChatTools();
      setCurrentChatId({ chatId: toChatId({ raw: 'chat-1' }) });
      setToolEnabled({ name: 'calculator', enabled: true });
      expect(isToolEnabled({ name: 'calculator' })).toBe(true);
    });

    it('uses a runtime overlay before persisted live chat toolConfigs', () => {
      const { setCurrentChatId, setToolEnabled, isToolEnabled } = useChatTools();
      setCurrentChatId({ chatId: toChatId({ raw: 'chat-1' }) });
      setToolEnabled({ name: 'calculator', enabled: true });

      liveChatRegistry.set(toChatId({ raw: 'chat-1' }), createTestChat({ id: toChatId({ raw: 'chat-1' }), toolConfigs: undefined }));

      expect(isToolEnabled({ name: 'calculator' })).toBe(true);
    });

    it('updates the runtime overlay without mutating live chat metadata when persistence is disabled', () => {
      const { setCurrentChatId, setToolEnabled, isToolEnabled, TEST_ONLY } = useChatTools();
      const chat = createTestChat({ id: toChatId({ raw: 'chat-1' }), toolConfigs: undefined });
      liveChatRegistry.set(toChatId({ raw: 'chat-1' }), chat);
      setCurrentChatId({ chatId: toChatId({ raw: 'chat-1' }) });

      setToolEnabled({ name: 'calculator', enabled: true });

      expect(isToolEnabled({ name: 'calculator' })).toBe(true);
      expect(chat.toolConfigs).toBeUndefined();
      expect(TEST_ONLY._runtimeToolConfigChangesByChat.value
        .get(toChatId({ raw: 'chat-1' }))
        ?.get('builtin.calculator')).toEqual({
        behavior: 'set',
        config: { key: 'builtin.calculator', status: 'enabled' },
      });
      expect(storageService.updateChatMeta).not.toHaveBeenCalled();
    });

    it('keeps runtime disables effective even when persisted config still contains the tool', () => {
      const { setCurrentChatId, setToolEnabled, isToolEnabled, TEST_ONLY } = useChatTools();
      const chat = createTestChat({ id: toChatId({ raw: 'chat-1' }), toolConfigs: [{ key: 'builtin.calculator', status: 'enabled' }] });
      liveChatRegistry.set(toChatId({ raw: 'chat-1' }), chat);
      setCurrentChatId({ chatId: toChatId({ raw: 'chat-1' }) });

      expect(isToolEnabled({ name: 'calculator' })).toBe(true);

      setToolEnabled({ name: 'calculator', enabled: false });

      expect(isToolEnabled({ name: 'calculator' })).toBe(false);
      expect(chat.toolConfigs).toEqual([{ key: 'builtin.calculator', status: 'enabled' }]);
      expect(TEST_ONLY._runtimeToolConfigChangesByChat.value
        .get(toChatId({ raw: 'chat-1' }))
        ?.get('builtin.calculator')).toEqual({
        behavior: 'set',
        config: { key: 'builtin.calculator', status: 'disabled' },
      });
      expect(storageService.updateChatMeta).not.toHaveBeenCalled();
    });

    it('discards runtime overlays when persistence is enabled and does not restore them after disabling it again', () => {
      const { setCurrentChatId, setToolEnabled, isToolEnabled, TEST_ONLY } = useChatTools();
      const chatId = toChatId({ raw: 'chat-1' });
      const chat = createTestChat({
        id: chatId,
        toolConfigs: [{ key: 'builtin.calculator', status: 'enabled' }],
      });
      liveChatRegistry.set(chatId, chat);
      setCurrentChatId({ chatId });

      setToolEnabled({ name: 'calculator', enabled: false });
      expect(isToolEnabled({ name: 'calculator' })).toBe(false);
      expect(TEST_ONLY._runtimeToolConfigChangesByChat.value.size).toBe(1);

      setToolConfigPersistence({ persistence: 'enabled' });
      expect(TEST_ONLY._runtimeToolConfigChangesByChat.value.size).toBe(0);
      expect(isToolEnabled({ name: 'calculator' })).toBe(true);

      setToolConfigPersistence({ persistence: 'disabled' });
      expect(isToolEnabled({ name: 'calculator' })).toBe(true);
    });

    it('persists tool changes into chat metadata when persistence is enabled', async () => {
      setToolConfigPersistence({ persistence: 'enabled' });
      const { setCurrentChatId, setToolEnabled } = useChatTools();
      const chat = createTestChat({ id: toChatId({ raw: 'chat-1' }), toolConfigs: undefined });
      liveChatRegistry.set(toChatId({ raw: 'chat-1' }), chat);
      setCurrentChatId({ chatId: toChatId({ raw: 'chat-1' }) });

      await setToolEnabled({ name: 'calculator', enabled: true });

      expect(chat.toolConfigs).toEqual([{ key: 'builtin.calculator', status: 'enabled' }]);
      expect(storageService.updateChatMeta).toHaveBeenCalledWith({
        id: toChatId({ raw: 'chat-1' }),
        updater: expect.any(Function),
      });
    });
  });

  it('rebases runtime changes onto externally updated persisted configs', () => {
    const { setCurrentChatId, setToolEnabled, isToolEnabled } = useChatTools();
    const chatId = toChatId({ raw: 'chat-1' });
    const chat = createTestChat({
      id: chatId,
      toolConfigs: [{ key: 'builtin.calculator', status: 'enabled' }],
    });
    liveChatRegistry.set(chatId, chat);
    setCurrentChatId({ chatId });

    void setToolEnabled({ name: 'calculator', enabled: false });
    chat.toolConfigs = [
      { key: 'builtin.calculator', status: 'enabled' },
      { key: 'builtin.choices', status: 'enabled' },
    ];

    expect(isToolEnabled({ name: 'calculator' })).toBe(false);
    expect(isToolEnabled({ name: 'choices' })).toBe(true);
  });

  it('rejects persistence failures without mutating live chat metadata', async () => {
    setToolConfigPersistence({ persistence: 'enabled' });
    const { setCurrentChatId, setToolEnabled } = useChatTools();
    const chatId = toChatId({ raw: 'chat-1' });
    const chat = createTestChat({ id: chatId, toolConfigs: undefined });
    liveChatRegistry.set(chatId, chat);
    setCurrentChatId({ chatId });
    vi.mocked(storageService.updateChatMeta).mockRejectedValueOnce(new Error('storage failed'));

    await expect(setToolEnabled({ name: 'calculator', enabled: true }))
      .rejects.toThrow('storage failed');
    expect(chat.toolConfigs).toBeUndefined();
  });

  it('serializes persisted updates against the latest saved tool layer', async () => {
    setToolConfigPersistence({ persistence: 'enabled' });
    const { setCurrentChatId, setToolEnabled } = useChatTools();
    const chatId = toChatId({ raw: 'chat-1' });
    const chat = createTestChat({ id: chatId, toolConfigs: undefined });
    liveChatRegistry.set(chatId, chat);
    setCurrentChatId({ chatId });
    let persisted: ChatMeta = { ...chat };
    vi.mocked(storageService.updateChatMeta).mockImplementation(async ({ updater }) => {
      persisted = await updater({ current: persisted });
    });

    const first = setToolEnabled({ name: 'calculator', enabled: true });
    const second = setToolEnabled({ name: 'choices', enabled: true });
    await Promise.all([first, second]);

    expect(persisted.toolConfigs).toEqual([
      { key: 'builtin.calculator', status: 'enabled' },
      { key: 'builtin.choices', status: 'enabled' },
    ]);
    expect(chat.toolConfigs).toEqual(persisted.toolConfigs);
  });

  it('merges a saved Tool Config after an unrelated newer live-chat update', async () => {
    setToolConfigPersistence({ persistence: 'enabled' });
    const { setCurrentChatId, setToolEnabled } = useChatTools();
    const chatId = toChatId({ raw: 'chat-1' });
    const chat = createTestChat({ id: chatId, toolConfigs: undefined });
    liveChatRegistry.set(chatId, chat);
    setCurrentChatId({ chatId });
    let persisted: ChatMeta = { ...chat };
    let unrelatedUpdatedAt: number | undefined;
    vi.mocked(storageService.updateChatMeta).mockImplementation(async ({ updater }) => {
      persisted = await updater({ current: persisted });
      unrelatedUpdatedAt = persisted.updatedAt + 1;
      chat.updatedAt = unrelatedUpdatedAt;
    });

    await setToolEnabled({ name: 'calculator', enabled: true });

    expect(chat.toolConfigs).toEqual([
      { key: 'builtin.calculator', status: 'enabled' },
    ]);
    expect(chat.updatedAt).toBe(unrelatedUpdatedAt);
  });

  describe('hierarchical resolution', () => {
    it('uses the supplied chat group even when the chat is not registered as live', () => {
      const groupId = toChatGroupId({ raw: 'group-1' });
      rootItems.value = [{
        id: 'chat_group:group-1',
        type: 'chat_group',
        chatGroup: {
          id: groupId,
          name: 'Group 1',
          isCollapsed: false,
          updatedAt: 0,
          items: [],
          toolConfigs: [{ key: 'builtin.calculator', status: 'enabled' }],
        },
      }];
      const chat = createTestChat({
        id: toChatId({ raw: 'detached-chat' }),
        groupId,
      });

      const resolved = getEffectiveToolConfigsForChat({ chat });

      expect(resolved.find(config => config.key === 'builtin.calculator')).toEqual({
        key: 'builtin.calculator',
        status: 'enabled',
      });
    });

    it('inherits Global Settings when the chat group has no override', () => {
      useSettings().TEST_ONLY.__testOnlySetSettings({
        newSettings: {
          autoTitleEnabled: true,
          providerProfiles: [],
          mounts: [],
          heavyContentAlertDismissed: false,
          storageType: 'local',
          endpoint: { type: 'openai', url: '' },
          experimental: {
            toolConfigPersistence: 'enabled',
            toolConfigs: [{ key: 'builtin.calculator', status: 'enabled' }],
          },
        },
      });
      const groupId = toChatGroupId({ raw: 'group-1' });
      rootItems.value = [{
        id: 'chat_group:group-1',
        type: 'chat_group',
        chatGroup: {
          id: groupId,
          name: 'Group 1',
          isCollapsed: false,
          updatedAt: 0,
          items: [],
        },
      }];
      const chatId = toChatId({ raw: 'chat-1' });
      liveChatRegistry.set(chatId, createTestChat({ id: chatId, groupId }));

      const { setCurrentChatId, isToolEnabled, getToolInheritanceLabel } = useChatTools();
      setCurrentChatId({ chatId });

      expect(isToolEnabled({ name: 'calculator' })).toBe(true);
      expect(getToolInheritanceLabel({ name: 'calculator' })).toBe('Use global');
    });

    it('uses the Chat Group override and does not expose a direct Global inheritance choice', async () => {
      useSettings().TEST_ONLY.__testOnlySetSettings({
        newSettings: {
          autoTitleEnabled: true,
          providerProfiles: [],
          mounts: [],
          heavyContentAlertDismissed: false,
          storageType: 'local',
          endpoint: { type: 'openai', url: '' },
          experimental: {
            toolConfigPersistence: 'enabled',
            toolConfigs: [{ key: 'builtin.calculator', status: 'enabled' }],
          },
        },
      });
      const groupId = toChatGroupId({ raw: 'group-1' });
      rootItems.value = [{
        id: 'chat_group:group-1',
        type: 'chat_group',
        chatGroup: {
          id: groupId,
          name: 'Group 1',
          isCollapsed: false,
          updatedAt: 0,
          items: [],
          toolConfigs: [{ key: 'builtin.calculator', status: 'disabled' }],
        },
      }];
      const chatId = toChatId({ raw: 'chat-1' });
      const chat = createTestChat({ id: chatId, groupId });
      liveChatRegistry.set(chatId, chat);

      const {
        setCurrentChatId,
        isToolEnabled,
        getToolInheritanceLabel,
        setToolStatus,
        resetToolToInherited,
      } = useChatTools();
      setCurrentChatId({ chatId });

      expect(isToolEnabled({ name: 'calculator' })).toBe(false);
      expect(getToolInheritanceLabel({ name: 'calculator' })).toBe('Use group');

      await setToolStatus({ name: 'calculator', status: 'enabled' });
      expect(isToolEnabled({ name: 'calculator' })).toBe(true);
      expect(chat.toolConfigs).toEqual([{ key: 'builtin.calculator', status: 'enabled' }]);

      await resetToolToInherited({ name: 'calculator' });
      expect(isToolEnabled({ name: 'calculator' })).toBe(false);
      expect(chat.toolConfigs).toBeUndefined();
    });
  });

  describe('per-chat isolation', () => {
    it('enabling a tool in one chat does not affect another chat', () => {
      const { setCurrentChatId, setToolEnabled, isToolEnabled } = useChatTools();

      setCurrentChatId({ chatId: toChatId({ raw: 'chat-1' }) });
      setToolEnabled({ name: 'calculator', enabled: true });
      setToolEnabled({ name: 'shell_execute', enabled: true });

      setCurrentChatId({ chatId: toChatId({ raw: 'chat-2' }) });
      expect(isToolEnabled({ name: 'calculator' })).toBe(false);
      expect(isToolEnabled({ name: 'shell_execute' })).toBe(false);
    });

    it('each chat independently retains its own tool state', () => {
      const { setCurrentChatId, setToolEnabled, isToolEnabled } = useChatTools();

      setCurrentChatId({ chatId: toChatId({ raw: 'chat-1' }) });
      setToolEnabled({ name: 'calculator', enabled: true });

      setCurrentChatId({ chatId: toChatId({ raw: 'chat-2' }) });
      setToolEnabled({ name: 'shell_execute', enabled: true });

      setCurrentChatId({ chatId: toChatId({ raw: 'chat-1' }) });
      expect(isToolEnabled({ name: 'calculator' })).toBe(true);
      expect(isToolEnabled({ name: 'shell_execute' })).toBe(false);

      setCurrentChatId({ chatId: toChatId({ raw: 'chat-2' }) });
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
      setCurrentChatId({ chatId: toChatId({ raw: 'chat-1' }) });
      setToolEnabled({ name: 'calculator', enabled: true });
      setToolEnabled({ name: 'calculator', enabled: false });
      expect(isToolEnabled({ name: 'calculator' })).toBe(false);
    });
  });

  describe('toggleTool', () => {
    it('toggles a tool on and off within the current chat', () => {
      const { setCurrentChatId, toggleTool, isToolEnabled } = useChatTools();
      setCurrentChatId({ chatId: toChatId({ raw: 'chat-1' }) });

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
      setCurrentChatId({ chatId: toChatId({ raw: 'chat-1' }) });
      setToolEnabled({ name: 'calculator', enabled: true });
      setToolEnabled({ name: 'shell_execute', enabled: true });
      expect(enabledToolNames.value).toContain('calculator');
      expect(enabledToolNames.value).toContain('shell_execute');
    });

    it('reflects only the current chat tools after switching', () => {
      const { setCurrentChatId, setToolEnabled, enabledToolNames } = useChatTools();

      setCurrentChatId({ chatId: toChatId({ raw: 'chat-1' }) });
      setToolEnabled({ name: 'calculator', enabled: true });

      setCurrentChatId({ chatId: toChatId({ raw: 'chat-2' }) });
      expect(enabledToolNames.value).toEqual([]);
    });
  });
});
