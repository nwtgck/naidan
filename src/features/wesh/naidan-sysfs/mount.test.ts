import { toChatGroupId, toChatId } from '@/01-models/ids';
import { describe, expect, it } from 'vitest';
import { createNaidanSysfsMount } from './mount';

describe('createNaidanSysfsMount', () => {
  it('returns a naidan sysfs mount for opfs storage', () => {
    expect(createNaidanSysfsMount({
      storageType: 'opfs',
      visibility: 'current_chat_only',
      binaryObjectAccess: 'data',
      currentChatId: toChatId({ raw: 'chat-1' }),
      currentChatGroupId: toChatGroupId({ raw: 'chat-group-1' }),
    })).toEqual({
      type: 'naidan_sysfs',
      path: '/sys/fs/naidan',
      readOnly: true,
      storageType: 'opfs',
      visibility: 'current_chat_only',
      binaryObjectAccess: 'data',
      currentChatId: toChatId({ raw: 'chat-1' }),
      currentChatGroupId: toChatGroupId({ raw: 'chat-group-1' }),
    });
  });

  it('returns undefined when current chat id is missing', () => {
    expect(createNaidanSysfsMount({
      storageType: 'opfs',
      visibility: 'current_chat_with_chat_group',
      binaryObjectAccess: 'data',
      currentChatId: undefined,
      currentChatGroupId: toChatGroupId({ raw: 'chat-group-1' }),
    })).toBeUndefined();
  });

  it('returns a naidan sysfs mount for local storage', () => {
    expect(createNaidanSysfsMount({
      storageType: 'local',
      visibility: 'main_chats',
      binaryObjectAccess: 'data',
      currentChatId: toChatId({ raw: 'chat-1' }),
      currentChatGroupId: undefined,
    })).toEqual({
      type: 'naidan_sysfs',
      path: '/sys/fs/naidan',
      readOnly: true,
      storageType: 'local',
      visibility: 'main_chats',
      binaryObjectAccess: 'data',
      currentChatId: toChatId({ raw: 'chat-1' }),
      currentChatGroupId: undefined,
    });
  });

  it('returns a naidan sysfs mount for memory storage', () => {
    expect(createNaidanSysfsMount({
      storageType: 'memory',
      visibility: 'main_chats',
      binaryObjectAccess: 'data',
      currentChatId: toChatId({ raw: 'chat-1' }),
      currentChatGroupId: undefined,
    })).toEqual({
      type: 'naidan_sysfs',
      path: '/sys/fs/naidan',
      readOnly: true,
      storageType: 'memory',
      visibility: 'main_chats',
      binaryObjectAccess: 'data',
      currentChatId: toChatId({ raw: 'chat-1' }),
      currentChatGroupId: undefined,
    });
  });
});
