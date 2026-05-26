import { computed, ref } from 'vue';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const compactCurrentBranchForChat = vi.fn();
const abortContextCompact = vi.fn();

vi.mock('@/composables/chat/services/context-compact-service', () => ({
  createContextCompactService: () => ({
    compactCurrentBranchForChat,
    abortContextCompact,
  }),
}));

vi.mock('@/composables/useSettings', () => ({
  useSettings: () => ({
    settings: {
      value: {
        endpointType: 'openai',
        endpointUrl: 'http://localhost',
        storageType: 'local',
        defaultModelId: 'gpt-4',
      },
    },
  }),
}));

vi.mock('@/composables/useGlobalEvents', () => ({
  useGlobalEvents: () => ({
    addErrorEvent: vi.fn(),
  }),
}));

vi.mock('@/composables/useChatWeshPreferences', () => ({
  useChatWeshPreferences: () => ({
    getNaidanSysfsMountSelection: () => 'none',
  }),
}));

vi.mock('@/composables/chat/chat-derived-state', () => ({
  createChatDerivedState: () => ({
    chatGroups: computed(() => []),
  }),
}));

vi.mock('@/composables/chat/chat-current-bridge', () => ({
  createChatCurrentBridge: () => ({
    getCurrentChat: () => null,
    getChatTargetByOptionalId: () => null,
    triggerCurrentChat: vi.fn(),
  }),
}));

vi.mock('@/composables/chat/global/chat-core-singletons', () => ({
  chatRuntimeStore: {
    startTask: vi.fn(),
    finishTask: vi.fn(),
  },
  contextCompactRuntime: {
    getProgress: ({ chatId }: { chatId: string | undefined }) => chatId ? { phase: 'preparing', compactedMessageCount: 1, suffixMessageCount: 2 } : { phase: 'idle' },
  },
  currentChatRef: ref(null),
  currentChatGroupRef: ref(null),
  getLiveChat: vi.fn(),
  isProcessing: vi.fn(),
  liveChatRegistry: new Map(),
  registerLiveInstance: vi.fn(),
  rootItems: ref([]),
  updateChatContent: vi.fn(),
  updateChatMeta: vi.fn(),
}));

import { useChatCompact } from './useChatCompact';

describe('useChatCompact', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    compactCurrentBranchForChat.mockResolvedValue({ status: 'compacted' });
  });

  it('returns idle progress and no-ops when chatId is undefined', async () => {
    const chatCompact = useChatCompact({
      chatId: computed(() => undefined),
    });

    await expect(chatCompact.run({
      keepRecentMessages: 3,
      instructionOverride: undefined,
    })).resolves.toBe(false);

    chatCompact.abort({});

    expect(chatCompact.progress.value).toEqual({ phase: 'idle' });
    expect(compactCurrentBranchForChat).not.toHaveBeenCalled();
    expect(abortContextCompact).toHaveBeenCalledWith({ chatId: undefined });
  });

  it('binds chatId when running compact and reading progress', async () => {
    const currentChatId = ref<string | undefined>('chat-1');
    const chatCompact = useChatCompact({
      chatId: computed(() => currentChatId.value),
    });

    await expect(chatCompact.run({
      keepRecentMessages: 5,
      instructionOverride: '# custom',
    })).resolves.toBe(true);

    expect(compactCurrentBranchForChat).toHaveBeenCalledWith({
      chatId: 'chat-1',
      keepRecentMessages: 5,
      instructionOverride: '# custom',
    });
    expect(chatCompact.progress.value).toEqual({
      phase: 'preparing',
      compactedMessageCount: 1,
      suffixMessageCount: 2,
    });
  });
});
