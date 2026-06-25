import { beforeEach, describe, expect, it, vi } from 'vitest';
import { reactive } from 'vue';
import { useChatWeshPreferences } from './useChatWeshPreferences';
import { useChatTools } from './useChatTools';
import type { Chat } from '@/models/types';
import type { ChatId } from '@/models/ids';
import { toChatId } from '@/models/ids';
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

describe('useChatWeshPreferences', () => {
  beforeEach(() => {
    useChatTools().TEST_ONLY._runtimeToolConfigChangesByChat.value = new Map();
    currentChatRef.value = null;
    liveChatRegistry.clear();
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
    id: ChatId;
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

  it('defaults to none when a chat has no explicit selection', () => {
    const { getNaidanSysfsAccessScope } = useChatWeshPreferences();
    expect(getNaidanSysfsAccessScope({ chatId: toChatId({ raw: 'chat-1' }) })).toBe('none');
  });

  it('stores access scope per chat in memory', () => {
    const { getNaidanSysfsAccessScope, setNaidanSysfsAccessScope } = useChatWeshPreferences();

    setNaidanSysfsAccessScope({ chatId: toChatId({ raw: 'chat-1' }), accessScope: 'current_chat_only' });
    setNaidanSysfsAccessScope({ chatId: toChatId({ raw: 'chat-2' }), accessScope: 'main_chats' });

    expect(getNaidanSysfsAccessScope({ chatId: toChatId({ raw: 'chat-1' }) })).toBe('current_chat_only');
    expect(getNaidanSysfsAccessScope({ chatId: toChatId({ raw: 'chat-2' }) })).toBe('main_chats');
  });

  it('returns none when chatId is undefined', () => {
    const { getNaidanSysfsAccessScope } = useChatWeshPreferences();
    expect(getNaidanSysfsAccessScope({ chatId: undefined })).toBe('none');
  });

  it('uses a runtime overlay before persisted live chat toolConfigs', () => {
    const { getNaidanSysfsAccessScope, setNaidanSysfsAccessScope } = useChatWeshPreferences();
    setNaidanSysfsAccessScope({ chatId: toChatId({ raw: 'chat-1' }), accessScope: 'main_chats' });
    liveChatRegistry.set(toChatId({ raw: 'chat-1' }), createTestChat({ id: toChatId({ raw: 'chat-1' }), toolConfigs: undefined }));

    expect(getNaidanSysfsAccessScope({ chatId: toChatId({ raw: 'chat-1' }) })).toBe('main_chats');
  });

  it('updates the runtime overlay without mutating live chat metadata when persistence is disabled', () => {
    const { getNaidanSysfsAccessScope, setNaidanSysfsAccessScope } = useChatWeshPreferences();
    const chat = createTestChat({ id: toChatId({ raw: 'chat-1' }), toolConfigs: undefined });
    liveChatRegistry.set(toChatId({ raw: 'chat-1' }), chat);

    setNaidanSysfsAccessScope({ chatId: toChatId({ raw: 'chat-1' }), accessScope: 'current_chat_only' });

    expect(getNaidanSysfsAccessScope({ chatId: toChatId({ raw: 'chat-1' }) })).toBe('current_chat_only');
    expect(chat.toolConfigs).toBeUndefined();
    expect(useChatTools().TEST_ONLY._runtimeToolConfigChangesByChat.value
      .get(toChatId({ raw: 'chat-1' }))
      ?.get('builtin.wesh')).toEqual({
      behavior: 'set',
      config: {
        key: 'builtin.wesh',
        status: 'enabled',
        naidanSysfs: {
          accessScope: 'current_chat_only',
        },
      },
    });
    expect(storageService.updateChatMeta).not.toHaveBeenCalled();
  });

  it('persists access scope into chat metadata when persistence is enabled', async () => {
    setToolConfigPersistence({ persistence: 'enabled' });
    const { setNaidanSysfsAccessScope } = useChatWeshPreferences();
    const chat = createTestChat({ id: toChatId({ raw: 'chat-1' }), toolConfigs: undefined });
    liveChatRegistry.set(toChatId({ raw: 'chat-1' }), chat);

    await setNaidanSysfsAccessScope({ chatId: toChatId({ raw: 'chat-1' }), accessScope: 'current_chat_only' });

    expect(chat.toolConfigs).toEqual([{
      key: 'builtin.wesh',
      status: 'enabled',
      naidanSysfs: {
        accessScope: 'current_chat_only',
      },
    }]);
    expect(storageService.updateChatMeta).toHaveBeenCalledWith({
      id: toChatId({ raw: 'chat-1' }),
      updater: expect.any(Function),
    });
  });

});
