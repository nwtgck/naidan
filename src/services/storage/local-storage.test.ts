import { describe, it, expect, beforeEach } from 'vitest';
import { LocalStorageProvider } from './local-storage';
import type { Chat } from '../../models/types';

import { STORAGE_KEY_PREFIX } from '../../models/constants';

const KEY_INDEX = `${STORAGE_KEY_PREFIX}lsp:index`;

describe('LocalStorageProvider', () => {
  let provider: LocalStorageProvider;

  beforeEach(() => {
    localStorage.clear();
    provider = new LocalStorageProvider();
  });

  it('should use object-based structure in localStorage internally', async () => {
    const mockChat: Chat = {
      id: '123e4567-e89b-12d3-a456-426614174000',
      title: 'Test Chat',
      root: { items: [] },
      modelId: 'gpt-3.5-turbo',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      systemPrompt: undefined,
      debugEnabled: false,
    };

    await provider.saveChat(mockChat, 0);
    
    // 1. Verify Index (Should NOT contain root/messages)
    const rawIndex = localStorage.getItem(KEY_INDEX);
    expect(rawIndex).not.toBeNull();
    const indexJson = JSON.parse(rawIndex!);
    expect(indexJson.entries[0].id).toBe(mockChat.id);
    expect(indexJson.entries[0].root).toBeUndefined();

    // 2. Verify Content (Should contain root/messages)
    const rawContent = localStorage.getItem(`${STORAGE_KEY_PREFIX}lsp:chat:${mockChat.id}`);
    expect(rawContent).not.toBeNull();
    const contentJson = JSON.parse(rawContent!);
    expect(contentJson.root).toBeDefined();
    expect(contentJson.root.items).toBeDefined();
  });

  it('should save and load a chat', async () => {
    const mockChat: Chat = {
      id: '123e4567-e89b-12d3-a456-426614174000',
      title: 'Test Chat',
      root: { items: [] },
      modelId: 'gpt-3.5-turbo',
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
      modelId: 'gpt-3.5-turbo',
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
      modelId: 'gpt-3.5-turbo',
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

  it('should validate chat DTO schema on save', async () => {
    const invalidChat = {
      id: 'invalid-uuid',
      title: 'Test Chat',
    };

    await expect(provider.saveChat(invalidChat as unknown as Chat, 0)).rejects.toThrow();
  });
});
