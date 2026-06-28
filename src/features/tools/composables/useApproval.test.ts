import { toChatId } from '@/01-models/ids';
import { afterEach, describe, expect, it } from 'vitest';
import { useApproval } from './useApproval';
import { APPROVAL_ACTIONS } from '@/features/tools/approval';

async function flushApprovalQueue(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('useApproval', () => {
  const approval = useApproval();

  afterEach(() => {
    approval.TEST_ONLY.clearAll();
  });

  it('shows an active approval request and resolves an allow_once decision', async () => {
    const resultPromise = approval.ensureApproval({
      chatId: toChatId({ raw: 'chat-a' }),
      action: APPROVAL_ACTIONS.toolWikipediaSearch,
      signal: undefined,
      preview: {
        type: 'wikipedia_search',
        keyword: 'quantum computer',
      },
    });

    await flushApprovalQueue();

    const activeRequest = approval.getActiveApprovalRequest({ chatId: toChatId({ raw: 'chat-a' }) }).value;
    expect(activeRequest).toMatchObject({
      chatId: toChatId({ raw: 'chat-a' }),
      action: APPROVAL_ACTIONS.toolWikipediaSearch,
      preview: {
        type: 'wikipedia_search',
        keyword: 'quantum computer',
      },
    });
    expect(activeRequest?.requestId).toEqual(expect.any(String));

    approval.resolveApprovalRequest({
      requestId: activeRequest!.requestId,
      decision: 'allow_once',
    });

    await expect(resultPromise).resolves.toEqual({ status: 'approved' });
    expect(approval.getActiveApprovalRequest({ chatId: toChatId({ raw: 'chat-a' }) }).value).toBeUndefined();
    expect(approval.TEST_ONLY.getStoredApprovalStatus({
      chatId: toChatId({ raw: 'chat-a' }),
      actionId: 'tool.wikipedia.search',
    })).toBe('missing');
  });

  it('stores allow_for_chat only for the current chat', async () => {
    const firstResultPromise = approval.ensureApproval({
      chatId: toChatId({ raw: 'chat-a' }),
      action: APPROVAL_ACTIONS.toolWikipediaSearch,
      signal: undefined,
      preview: {
        type: 'wikipedia_search',
        keyword: 'first keyword',
      },
    });

    await flushApprovalQueue();

    const firstRequest = approval.getActiveApprovalRequest({ chatId: toChatId({ raw: 'chat-a' }) }).value;
    expect(firstRequest).not.toBeUndefined();
    approval.resolveApprovalRequest({
      requestId: firstRequest!.requestId,
      decision: 'allow_for_chat',
    });
    await expect(firstResultPromise).resolves.toEqual({ status: 'approved' });

    await expect(approval.ensureApproval({
      chatId: toChatId({ raw: 'chat-a' }),
      action: APPROVAL_ACTIONS.toolWikipediaSearch,
      signal: undefined,
      preview: {
        type: 'wikipedia_search',
        keyword: 'second keyword',
      },
    })).resolves.toEqual({ status: 'approved' });

    const otherChatResultPromise = approval.ensureApproval({
      chatId: toChatId({ raw: 'chat-b' }),
      action: APPROVAL_ACTIONS.toolWikipediaSearch,
      signal: undefined,
      preview: {
        type: 'wikipedia_search',
        keyword: 'other chat keyword',
      },
    });

    await flushApprovalQueue();

    const otherChatRequest = approval.getActiveApprovalRequest({ chatId: toChatId({ raw: 'chat-b' }) }).value;
    expect(otherChatRequest).not.toBeUndefined();
    approval.resolveApprovalRequest({
      requestId: otherChatRequest!.requestId,
      decision: 'deny',
    });
    await expect(otherChatResultPromise).resolves.toEqual({ status: 'denied' });
  });

  it('stores allow_globally across chats until the runtime is cleared', async () => {
    const firstResultPromise = approval.ensureApproval({
      chatId: toChatId({ raw: 'chat-a' }),
      action: APPROVAL_ACTIONS.toolWikipediaGetPage,
      signal: undefined,
      preview: {
        type: 'wikipedia_get_page',
        title: undefined,
        pageId: '123',
      },
    });

    await flushApprovalQueue();

    const firstRequest = approval.getActiveApprovalRequest({ chatId: toChatId({ raw: 'chat-a' }) }).value;
    expect(firstRequest).not.toBeUndefined();
    approval.resolveApprovalRequest({
      requestId: firstRequest!.requestId,
      decision: 'allow_globally',
    });
    await expect(firstResultPromise).resolves.toEqual({ status: 'approved' });

    await expect(approval.ensureApproval({
      chatId: toChatId({ raw: 'chat-b' }),
      action: APPROVAL_ACTIONS.toolWikipediaGetPage,
      signal: undefined,
      preview: {
        type: 'wikipedia_get_page',
        title: undefined,
        pageId: '456',
      },
    })).resolves.toEqual({ status: 'approved' });
    expect(approval.getActiveApprovalRequest({ chatId: toChatId({ raw: 'chat-b' }) }).value).toBeUndefined();
  });

  it('serializes approval UI per chat and re-checks stored approvals under the lock', async () => {
    const firstResultPromise = approval.ensureApproval({
      chatId: toChatId({ raw: 'chat-a' }),
      action: APPROVAL_ACTIONS.toolWikipediaSearch,
      signal: undefined,
      preview: {
        type: 'wikipedia_search',
        keyword: 'first keyword',
      },
    });
    const secondResultPromise = approval.ensureApproval({
      chatId: toChatId({ raw: 'chat-a' }),
      action: APPROVAL_ACTIONS.toolWikipediaSearch,
      signal: undefined,
      preview: {
        type: 'wikipedia_search',
        keyword: 'second keyword',
      },
    });

    await flushApprovalQueue();

    const firstRequest = approval.getActiveApprovalRequest({ chatId: toChatId({ raw: 'chat-a' }) }).value;
    expect(firstRequest?.preview).toEqual({
      type: 'wikipedia_search',
      keyword: 'first keyword',
    });

    approval.resolveApprovalRequest({
      requestId: firstRequest!.requestId,
      decision: 'allow_for_chat',
    });

    await expect(firstResultPromise).resolves.toEqual({ status: 'approved' });
    await expect(secondResultPromise).resolves.toEqual({ status: 'approved' });
    expect(approval.getActiveApprovalRequest({ chatId: toChatId({ raw: 'chat-a' }) }).value).toBeUndefined();
  });

  it('clears the active request when the approval signal aborts', async () => {
    const controller = new AbortController();
    const resultPromise = approval.ensureApproval({
      chatId: toChatId({ raw: 'chat-a' }),
      action: APPROVAL_ACTIONS.toolWikipediaSearch,
      signal: controller.signal,
      preview: {
        type: 'wikipedia_search',
        keyword: 'abort keyword',
      },
    });

    await flushApprovalQueue();

    const activeRequest = approval.getActiveApprovalRequest({ chatId: toChatId({ raw: 'chat-a' }) }).value;
    expect(activeRequest).not.toBeUndefined();

    controller.abort();

    await expect(resultPromise).rejects.toThrow('Generation aborted');
    expect(approval.getActiveApprovalRequest({ chatId: toChatId({ raw: 'chat-a' }) }).value).toBeUndefined();
  });
});
