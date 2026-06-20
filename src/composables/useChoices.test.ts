import { afterEach, describe, expect, it } from 'vitest';
import { toChatId } from '@/models/ids';
import { useChoices } from './useChoices';

async function flushChoiceQueue(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('useChoices', () => {
  const choices = useChoices();

  afterEach(() => {
    choices.TEST_ONLY.clearAll();
  });

  it('shows an active request and resolves the selected index', async () => {
    const resultPromise = choices.requestChoice({
      chatId: toChatId({ raw: 'chat-a' }),
      prompt: 'Select one',
      choices: ['Alpha', 'Beta'],
      signal: undefined,
    });

    await flushChoiceQueue();

    const activeRequest = choices.getActiveChoiceRequest({
      chatId: toChatId({ raw: 'chat-a' }),
    }).value;
    expect(activeRequest).toMatchObject({
      chatId: toChatId({ raw: 'chat-a' }),
      prompt: 'Select one',
      choices: ['Alpha', 'Beta'],
    });
    expect(activeRequest?.requestId).toEqual(expect.any(String));

    choices.resolveChoiceRequest({
      requestId: activeRequest!.requestId,
      index: 1,
    });

    await expect(resultPromise).resolves.toEqual({ index: 1 });
    expect(choices.getActiveChoiceRequest({
      chatId: toChatId({ raw: 'chat-a' }),
    }).value).toBeUndefined();
  });

  it('serializes requests within the same chat', async () => {
    const firstResultPromise = choices.requestChoice({
      chatId: toChatId({ raw: 'chat-a' }),
      prompt: 'First',
      choices: ['A', 'B'],
      signal: undefined,
    });
    const secondResultPromise = choices.requestChoice({
      chatId: toChatId({ raw: 'chat-a' }),
      prompt: 'Second',
      choices: ['C', 'D'],
      signal: undefined,
    });

    await flushChoiceQueue();

    const firstRequest = choices.getActiveChoiceRequest({
      chatId: toChatId({ raw: 'chat-a' }),
    }).value;
    expect(firstRequest?.prompt).toBe('First');

    choices.resolveChoiceRequest({
      requestId: firstRequest!.requestId,
      index: 0,
    });
    await expect(firstResultPromise).resolves.toEqual({ index: 0 });
    await flushChoiceQueue();

    const secondRequest = choices.getActiveChoiceRequest({
      chatId: toChatId({ raw: 'chat-a' }),
    }).value;
    expect(secondRequest?.prompt).toBe('Second');

    choices.resolveChoiceRequest({
      requestId: secondRequest!.requestId,
      index: 1,
    });
    await expect(secondResultPromise).resolves.toEqual({ index: 1 });
  });

  it('allows different chats to wait for choices concurrently', async () => {
    const chatA = toChatId({ raw: 'chat-a' });
    const chatB = toChatId({ raw: 'chat-b' });
    const resultPromiseA = choices.requestChoice({
      chatId: chatA,
      prompt: 'First chat',
      choices: ['A1', 'A2'],
      signal: undefined,
    });
    const resultPromiseB = choices.requestChoice({
      chatId: chatB,
      prompt: 'Second chat',
      choices: ['B1', 'B2'],
      signal: undefined,
    });

    await flushChoiceQueue();

    const requestA = choices.getActiveChoiceRequest({ chatId: chatA }).value;
    const requestB = choices.getActiveChoiceRequest({ chatId: chatB }).value;
    expect(requestA?.prompt).toBe('First chat');
    expect(requestB?.prompt).toBe('Second chat');

    choices.resolveChoiceRequest({
      requestId: requestB!.requestId,
      index: 1,
    });
    choices.resolveChoiceRequest({
      requestId: requestA!.requestId,
      index: 0,
    });

    await expect(resultPromiseA).resolves.toEqual({ index: 0 });
    await expect(resultPromiseB).resolves.toEqual({ index: 1 });
  });

  it('clears the active request when generation is aborted', async () => {
    const controller = new AbortController();
    const resultPromise = choices.requestChoice({
      chatId: toChatId({ raw: 'chat-a' }),
      prompt: 'Select one',
      choices: ['Alpha', 'Beta'],
      signal: controller.signal,
    });

    await flushChoiceQueue();
    expect(choices.getActiveChoiceRequest({
      chatId: toChatId({ raw: 'chat-a' }),
    }).value).not.toBeUndefined();

    controller.abort();

    await expect(resultPromise).rejects.toThrow('Generation aborted');
    expect(choices.getActiveChoiceRequest({
      chatId: toChatId({ raw: 'chat-a' }),
    }).value).toBeUndefined();
  });

  it('rejects an out-of-range UI selection', async () => {
    const resultPromise = choices.requestChoice({
      chatId: toChatId({ raw: 'chat-a' }),
      prompt: 'Select one',
      choices: ['Alpha', 'Beta'],
      signal: undefined,
    });

    await flushChoiceQueue();
    const activeRequest = choices.getActiveChoiceRequest({
      chatId: toChatId({ raw: 'chat-a' }),
    }).value;

    expect(() => choices.resolveChoiceRequest({
      requestId: activeRequest!.requestId,
      index: 2,
    })).toThrow('Choice index is out of range: 2');

    choices.resolveChoiceRequest({
      requestId: activeRequest!.requestId,
      index: 0,
    });
    await expect(resultPromise).resolves.toEqual({ index: 0 });
  });
});
