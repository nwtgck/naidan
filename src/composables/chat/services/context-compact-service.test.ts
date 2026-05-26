import { describe, expect, it, vi } from 'vitest';
import { createContextCompactService } from './context-compact-service';

describe('createContextCompactService', () => {
  it('uses the explicit chatId path even when there is no current chat', async () => {
    const getChatTarget = vi.fn().mockReturnValue({
      id: 'chat-1',
      root: { items: [] },
      createdAt: 0,
      updatedAt: 0,
      debugEnabled: false,
    });

    const service = createContextCompactService({
      getCurrentChat: () => null,
      getChatTarget: ({ chatId }) => getChatTarget(chatId),
      getLiveChat: ({ chat }) => chat,
      isProcessing: () => false,
      registerLiveInstance: vi.fn(),
      resolveSettings: () => ({
        endpointType: 'openai',
        endpointUrl: 'http://localhost',
        endpointHttpHeaders: undefined,
        modelId: 'gpt-4.1',
        lmParameters: undefined,
      }),
      getPromptMode: () => 'without_message_ids',
      runtime: {
        getActiveContextCompaction: vi.fn(),
        setActiveContextCompaction: vi.fn(),
        deleteActiveContextCompaction: vi.fn(),
        setProgress: vi.fn(),
        getProgress: vi.fn(),
      } as any,
      updateChatContent: vi.fn(),
      updateChatMeta: vi.fn(),
      triggerCurrentChat: vi.fn(),
      addErrorEvent: vi.fn(),
      startProcessing: vi.fn(),
      finishProcessing: vi.fn(),
    });

    const result = await service.compactCurrentBranchForChat({
      chatId: 'chat-1',
      keepRecentMessages: 2,
      instructionOverride: undefined,
    });

    expect(getChatTarget).toHaveBeenCalledWith('chat-1');
    expect(result).toEqual({
      status: 'skipped',
      reason: 'not_enough_messages',
    });
  });

  it('returns no_current_chat when the explicit chat target is unavailable', async () => {
    const service = createContextCompactService({
      getCurrentChat: () => null,
      getChatTarget: () => null,
      getLiveChat: ({ chat }) => chat,
      isProcessing: () => false,
      registerLiveInstance: vi.fn(),
      resolveSettings: () => ({
        endpointType: 'openai',
        endpointUrl: 'http://localhost',
        endpointHttpHeaders: undefined,
        modelId: 'gpt-4.1',
        lmParameters: undefined,
      }),
      getPromptMode: () => 'without_message_ids',
      runtime: {
        getActiveContextCompaction: vi.fn(),
        setActiveContextCompaction: vi.fn(),
        deleteActiveContextCompaction: vi.fn(),
        setProgress: vi.fn(),
        getProgress: vi.fn(),
      } as any,
      updateChatContent: vi.fn(),
      updateChatMeta: vi.fn(),
      triggerCurrentChat: vi.fn(),
      addErrorEvent: vi.fn(),
      startProcessing: vi.fn(),
      finishProcessing: vi.fn(),
    });

    await expect(service.compactCurrentBranchForChat({
      chatId: 'missing-chat',
      keepRecentMessages: 2,
      instructionOverride: undefined,
    })).resolves.toEqual({
      status: 'skipped',
      reason: 'no_current_chat',
    });
  });
});
