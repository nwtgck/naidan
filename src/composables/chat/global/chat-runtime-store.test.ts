import { toChatId } from '@/models/ids';
import { describe, expect, it } from 'vitest';
import { createChatRuntimeStore } from './chat-runtime-store';

describe('createChatRuntimeStore', () => {
  it('tracks chat-scoped tasks and processing state', () => {
    const store = createChatRuntimeStore();

    store.startTask({
      key: {
        kind: 'process',
        chatId: toChatId({ raw: 'chat-1' }),
      },
    });

    expect(store.isProcessing({ chatId: toChatId({ raw: 'chat-1' }) })).toBe(true);
    expect(store.isTaskRunning({ chatId: toChatId({ raw: 'chat-1' }) })).toBe(true);

    store.finishTask({
      key: {
        kind: 'process',
        chatId: toChatId({ raw: 'chat-1' }),
      },
    });

    expect(store.isProcessing({ chatId: toChatId({ raw: 'chat-1' }) })).toBe(false);
    expect(store.isTaskRunning({ chatId: toChatId({ raw: 'chat-1' }) })).toBe(false);
  });

  it('clears all tasks for one chat without touching another chat', () => {
    const store = createChatRuntimeStore();

    store.startTask({
      key: {
        kind: 'title',
        chatId: toChatId({ raw: 'chat-a' }),
      },
    });
    store.startTask({
      key: {
        kind: 'fetch',
        chatId: toChatId({ raw: 'chat-a' }),
      },
    });
    store.startTask({
      key: {
        kind: 'process',
        chatId: toChatId({ raw: 'chat-b' }),
      },
    });

    store.clearTasksForChat({ chatId: toChatId({ raw: 'chat-a' }) });

    expect(store.getTaskCount({ key: { kind: 'title', chatId: toChatId({ raw: 'chat-a' }) } })).toBe(0);
    expect(store.getTaskCount({ key: { kind: 'fetch', chatId: toChatId({ raw: 'chat-a' }) } })).toBe(0);
    expect(store.getTaskCount({ key: { kind: 'process', chatId: toChatId({ raw: 'chat-b' }) } })).toBe(1);
  });
});
