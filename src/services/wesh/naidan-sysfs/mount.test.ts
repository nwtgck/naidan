import { describe, expect, it } from 'vitest'
import { createNaidanSysfsMount } from './mount'

describe('createNaidanSysfsMount', () => {
  it('returns a naidan sysfs mount for opfs storage', () => {
    expect(createNaidanSysfsMount({
      storageType: 'opfs',
      visibility: 'current_chat_only',
      currentChatId: 'chat-1',
      currentChatGroupId: 'chat-group-1',
    })).toEqual({
      type: 'naidan_sysfs',
      path: '/sys/fs/naidan',
      readOnly: true,
      storageType: 'opfs',
      visibility: 'current_chat_only',
      currentChatId: 'chat-1',
      currentChatGroupId: 'chat-group-1',
    })
  })

  it('returns undefined when current chat id is missing', () => {
    expect(createNaidanSysfsMount({
      storageType: 'opfs',
      visibility: 'current_chat_with_chat_group',
      currentChatId: undefined,
      currentChatGroupId: 'chat-group-1',
    })).toBeUndefined()
  })

  it('throws for local storage', () => {
    expect(() => createNaidanSysfsMount({
      storageType: 'local',
      visibility: 'all_chats',
      currentChatId: 'chat-1',
      currentChatGroupId: undefined,
    })).toThrow('/sys/fs/naidan requires opfs storage, received: local')
  })

  it('throws for memory storage', () => {
    expect(() => createNaidanSysfsMount({
      storageType: 'memory',
      visibility: 'all_chats',
      currentChatId: 'chat-1',
      currentChatGroupId: undefined,
    })).toThrow('/sys/fs/naidan requires opfs storage, received: memory')
  })
})
