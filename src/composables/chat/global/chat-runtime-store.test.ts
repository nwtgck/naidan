import { toChatId } from '@/01-models/ids';
import { describe, expect, it } from 'vitest';
import { createChatRuntimeStore } from './chat-runtime-store';

describe('createChatRuntimeStore', () => {
  it('counts foreground work across chats without counting title or model-list tasks', () => {
    const store = createChatRuntimeStore();
    const chatId = toChatId({ raw: 'activity' });
    store.startTask({ key: { kind: 'title', chatId } });
    store.startTask({ key: { kind: 'fetch', chatId } });
    expect(store.hasForegroundTasks()).toBe(false);
    store.startTask({ key: { kind: 'process', chatId } });
    expect(store.hasForegroundTasks()).toBe(true);
    store.finishTask({ key: { kind: 'process', chatId } });
    expect(store.hasForegroundTasks()).toBe(false);
    const other = toChatId({ raw: 'other' });
    store.setExternalGeneration({ chatId: other });
    expect(store.hasForegroundTasks()).toBe(true);
    store.deleteExternalGeneration({ chatId: other });
    expect(store.hasForegroundTasks()).toBe(false);
  });

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

  it('releases overlapping owned tasks idempotently', () => {
    const store = createChatRuntimeStore();
    const key = { kind: 'title' as const, chatId: toChatId({ raw: 'overlap' }) };
    const first = store.startTask({ key });
    const second = store.startTask({ key });
    expect(store.getTaskCount({ key })).toBe(2);
    first(); first();
    expect(store.getTaskCount({ key })).toBe(1);
    second(); second();
    expect(store.getTaskCount({ key })).toBe(0);
  });

  it.each(['task', 'chat', 'all'] as const)('ignores late release after clearing %s tasks', clearing => {
    const store = createChatRuntimeStore();
    const chatId = toChatId({ raw: 'clear' });
    const key = { kind: 'title' as const, chatId };
    const stale = store.startTask({ key });
    switch (clearing) {
    case 'task': store.clearTask({ key }); break;
    case 'chat': store.clearTasksForChat({ chatId }); break;
    case 'all': store.clearActiveTaskCounts(); break;
    default: { const exhaustive: never = clearing; throw new Error(String(exhaustive)); }
    }
    const current = store.startTask({ key });
    stale(); stale();
    expect(store.getTaskCount({ key })).toBe(1);
    current();
    expect(store.getTaskCount({ key })).toBe(0);
  });

  it('captures a task key rather than reading a later caller mutation on release', () => {
    const store = createChatRuntimeStore();
    const firstId = toChatId({ raw: 'first' });
    const key = { kind: 'title' as const, chatId: firstId };
    const first = store.startTask({ key });
    key.chatId = toChatId({ raw: 'second' });
    const second = store.startTask({ key });
    first();
    expect(store.getTaskCount({ key: { kind: 'title', chatId: firstId } })).toBe(0);
    expect(store.getTaskCount({ key })).toBe(1);
    second();
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
