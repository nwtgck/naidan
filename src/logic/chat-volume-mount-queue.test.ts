import { describe, expect, it, vi } from 'vitest';
import { toChatId } from '@/01-models/ids';
import { queueChatVolumeMount } from './chat-volume-mount-queue';

describe('queueChatVolumeMount', () => {
  it('serializes one chat while allowing a different chat to assign its mount', async () => {
    const firstChat = toChatId({ raw: 'mount-chat-first' });
    const otherChat = toChatId({ raw: 'mount-chat-other' });
    const started = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    using release = {
      [Symbol.dispose]() {
        finish.resolve();
      },
    };
    const events: string[] = [];
    const first = queueChatVolumeMount({
      chatId: firstChat,
      operation: async () => {
        events.push('first-start');
        started.resolve();
        await finish.promise;
        events.push('first-finish');
      },
    });
    const secondOperation = vi.fn(async () => {
      events.push('second');
    });
    const second = queueChatVolumeMount({ chatId: firstChat, operation: secondOperation });
    await started.promise;
    await queueChatVolumeMount({
      chatId: otherChat,
      operation: async () => {
        events.push('other');
      },
    });
    expect(events).toEqual(['first-start', 'other']);
    expect(secondOperation).not.toHaveBeenCalled();
    finish.resolve();
    await first;
    await second;
    expect(events).toEqual(['first-start', 'other', 'first-finish', 'second']);
    void release;
  });

  it('reports a failed assignment without poisoning queued or future assignments', async () => {
    const chatId = toChatId({ raw: 'mount-chat-failure' });
    const failure = new Error('Metadata write failed');
    const firstResult = queueChatVolumeMount({
      chatId,
      operation: async () => {
        throw failure;
      },
    }).catch(error => error);
    const next = vi.fn(async () => {});
    await queueChatVolumeMount({ chatId, operation: next });
    expect(await firstResult).toBe(failure);
    expect(next).toHaveBeenCalledOnce();
    const later = vi.fn(async () => {});
    await queueChatVolumeMount({ chatId, operation: later });
    expect(later).toHaveBeenCalledOnce();
  });
});
