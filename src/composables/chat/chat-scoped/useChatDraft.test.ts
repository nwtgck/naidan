import { computed } from 'vue';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockGetDraft,
  mockSaveDraft,
  mockClearDraft,
  mockRevokeAll,
} = vi.hoisted(() => ({
  mockGetDraft: vi.fn(),
  mockSaveDraft: vi.fn(),
  mockClearDraft: vi.fn(),
  mockRevokeAll: vi.fn(),
}));

vi.mock('@/composables/useChatDraft', () => ({
  useChatDraft: () => ({
    getDraft: mockGetDraft,
    saveDraft: mockSaveDraft,
    clearDraft: mockClearDraft,
    revokeAll: mockRevokeAll,
  }),
}));

import { useChatDraft } from './useChatDraft';

describe('useChatDraft', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetDraft.mockReturnValue({
      input: 'draft text',
      attachments: [],
      attachmentUrls: {},
    });
  });

  it('binds draft operations to the scoped chatId', () => {
    const chatDraft = useChatDraft({
      chatId: computed(() => 'chat-1'),
    });

    expect(chatDraft.getDraft({})).toEqual({
      input: 'draft text',
      attachments: [],
      attachmentUrls: {},
    });
    expect(mockGetDraft).toHaveBeenCalledWith({ chatId: 'chat-1' });

    chatDraft.saveDraft({
      draft: {
        input: 'changed',
        attachments: [],
        attachmentUrls: {},
      },
    });
    chatDraft.clearDraft({});
    chatDraft.revokeAll({});

    expect(mockSaveDraft).toHaveBeenCalledWith({
      chatId: 'chat-1',
      draft: {
        input: 'changed',
        attachments: [],
        attachmentUrls: {},
      },
    });
    expect(mockClearDraft).toHaveBeenCalledWith({ chatId: 'chat-1' });
    expect(mockRevokeAll).toHaveBeenCalled();
  });

  it('supports undefined chatId via shared fallback behavior', () => {
    const chatDraft = useChatDraft({
      chatId: computed(() => undefined),
    });

    chatDraft.getDraft({});
    chatDraft.saveDraft({
      draft: {
        input: '',
        attachments: [],
        attachmentUrls: {},
      },
    });
    chatDraft.clearDraft({});

    expect(mockGetDraft).toHaveBeenCalledWith({ chatId: undefined });
    expect(mockSaveDraft).toHaveBeenCalledWith({
      chatId: undefined,
      draft: {
        input: '',
        attachments: [],
        attachmentUrls: {},
      },
    });
    expect(mockClearDraft).toHaveBeenCalledWith({ chatId: undefined });
  });
});
