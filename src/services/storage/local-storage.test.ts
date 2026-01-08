import { describe, it, expect, beforeEach, vi } from 'vitest';
import { LocalStorageProvider } from './local-storage';
import type { Chat } from '../../models/types';
import { v4 as uuidv4 } from 'uuid';

describe('LocalStorageProvider', () => {
  let provider: LocalStorageProvider;
  
  beforeEach(() => {
    provider = new LocalStorageProvider();
    localStorage.clear();
    vi.clearAllMocks();
  });

  const mockChat: Chat = {
    id: uuidv4(),
    title: 'Test Chat',
    messages: [],
    modelId: 'gpt-3.5',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  it('should save and load a chat', async () => {
    await provider.saveChat(mockChat);
    const loaded = await provider.loadChat(mockChat.id);
    expect(loaded).toEqual(mockChat);
  });

  it('should update index when saving chat', async () => {
    await provider.saveChat(mockChat);
    const index = await provider.listChats();
    expect(index).toHaveLength(1);
    expect(index[0]?.id).toBe(mockChat.id);
    expect(index[0]?.title).toBe(mockChat.title);
  });

  it('should delete a chat', async () => {
    await provider.saveChat(mockChat);
    await provider.deleteChat(mockChat.id);
    const loaded = await provider.loadChat(mockChat.id);
    expect(loaded).toBeNull();
    const index = await provider.listChats();
    expect(index).toHaveLength(0);
  });

  it('should validate schema', async () => {
    const invalidChat = { ...mockChat, id: 'not-a-uuid' };
    await expect(provider.saveChat(invalidChat as any)).rejects.toThrow();
  });
});
