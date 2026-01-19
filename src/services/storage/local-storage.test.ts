import { describe, it, expect, beforeEach } from 'vitest';
import { LocalStorageProvider } from './local-storage';
import type { Chat } from '../../models/types';

import { STORAGE_KEY_PREFIX } from '../../models/constants';

const KEY_HIERARCHY = `${STORAGE_KEY_PREFIX}lsp:hierarchy`;
const KEY_META_PREFIX = `${STORAGE_KEY_PREFIX}lsp:chat_meta:`;

describe('LocalStorageProvider', () => {
  let provider: LocalStorageProvider;

  beforeEach(() => {
    localStorage.clear();
    provider = new LocalStorageProvider();
  });

  it('should use individual keys in localStorage', async () => {
    const mockChat: Chat = {
      id: '123e4567-e89b-12d3-a456-426614174000',
      title: 'Test Chat',
      root: { items: [] },
      createdAt: Date.now(),
      updatedAt: Date.now(),
      systemPrompt: undefined,
      debugEnabled: false,
    };

    await provider.saveChat(mockChat, 0);
    
    // 1. Verify Meta (Should exist at its own key)
    const rawMeta = localStorage.getItem(`${KEY_META_PREFIX}${mockChat.id}`);
    expect(rawMeta).not.toBeNull();
    const metaJson = JSON.parse(rawMeta!);
    expect(metaJson.id).toBe(mockChat.id);
    expect(metaJson.root).toBeUndefined();

    // 2. Verify Content (Should exist at its own key)
    const rawContent = localStorage.getItem(`${STORAGE_KEY_PREFIX}lsp:chat_content:${mockChat.id}`);
    expect(rawContent).not.toBeNull();
    const contentJson = JSON.parse(rawContent!);
    expect(contentJson.root).toBeDefined();
  });

  it('should save and load a chat', async () => {
    const mockChat: Chat = {
      id: '123e4567-e89b-12d3-a456-426614174000',
      title: 'Test Chat',
      root: { items: [] },
      createdAt: Date.now(),
      updatedAt: Date.now(),
      systemPrompt: undefined,
      debugEnabled: false,
    };

    await provider.saveChat(mockChat, 0);
    const loaded = await provider.loadChat(mockChat.id);
    expect(loaded).toEqual(mockChat);
  });

  it('should list saved chats', async () => {
    const mockChat: Chat = {
      id: '123e4567-e89b-12d3-a456-426614174000',
      title: 'Test Chat',
      root: { items: [] },
      createdAt: Date.now(),
      updatedAt: Date.now(),
      systemPrompt: undefined,
      debugEnabled: false,
    };

    await provider.saveChat(mockChat, 0);
    const list = await provider.listChats();
    expect(list).toHaveLength(1);
    expect(list[0]?.id).toBe(mockChat.id);
  });

  it('should delete a chat', async () => {
    const mockChat: Chat = {
      id: '123e4567-e89b-12d3-a456-426614174000',
      title: 'Test Chat',
      root: { items: [] },
      createdAt: Date.now(),
      updatedAt: Date.now(),
      systemPrompt: undefined,
      debugEnabled: false,
    };

    await provider.saveChat(mockChat, 0);
    await provider.deleteChat(mockChat.id);
    const loaded = await provider.loadChat(mockChat.id);
    expect(loaded).toBeNull();
  });

  it('should validate chat DTO schema on saveMeta', async () => {
    const invalidChat = {
      id: 'invalid-uuid',
      title: 'Test Chat',
    };

    await expect(provider.saveChatMeta(invalidChat as any)).rejects.toThrow();
  });
});
