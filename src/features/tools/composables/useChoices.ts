import { computed, reactive, type ComputedRef } from 'vue';
import { generateId } from '@/01-models/id';
import { Semaphore } from '@/utils/concurrency';
import type { ChatId, ToolChoicesRequestId } from '@/01-models/ids';
import type {
  ChoicesActiveRequest,
  ChoicesSelection,
  RequestChoice,
} from '@/features/tools/choices/runtime';

type ChoicesRuntimeState = {
  activeRequestsByChatId: Map<ChatId, ChoicesActiveRequest>,
};

type PendingSelection = {
  request: ChoicesActiveRequest,
  resolve: ({ selection }: { selection: ChoicesSelection }) => void,
};

const choicesRuntimeState = reactive<ChoicesRuntimeState>({
  activeRequestsByChatId: new Map(),
});

const chatChoiceLocks = new Map<ChatId, Semaphore>();
const pendingSelections = new Map<ToolChoicesRequestId, PendingSelection>();

function getChatChoiceLock({
  chatId,
}: {
  chatId: ChatId,
}): Semaphore {
  const existing = chatChoiceLocks.get(chatId);
  if (existing !== undefined) {
    return existing;
  }

  const lock = new Semaphore({ maxConcurrency: 1 });
  chatChoiceLocks.set(chatId, lock);
  return lock;
}

function waitForChoiceSelection({
  request,
  signal,
}: {
  request: ChoicesActiveRequest,
  signal: AbortSignal | undefined,
}): Promise<ChoicesSelection> {
  choicesRuntimeState.activeRequestsByChatId.set(request.chatId, request);

  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(new Error('Generation aborted'));
      return;
    }

    const handleAbort = () => {
      pendingSelections.delete(request.requestId);
      reject(new Error('Generation aborted'));
    };
    signal?.addEventListener('abort', handleAbort, { once: true });

    pendingSelections.set(request.requestId, {
      request,
      resolve: ({ selection }) => {
        signal?.removeEventListener('abort', handleAbort);
        resolve(selection);
      },
    });
  });
}

function clearActiveChoiceRequest({
  chatId,
  requestId,
}: {
  chatId: ChatId,
  requestId: ToolChoicesRequestId,
}): void {
  const activeRequest = choicesRuntimeState.activeRequestsByChatId.get(chatId);
  if (activeRequest?.requestId !== requestId) {
    return;
  }
  choicesRuntimeState.activeRequestsByChatId.delete(chatId);
}

async function runWithChatChoiceLock<TResult>({
  chatId,
  run,
}: {
  chatId: ChatId,
  run: () => Promise<TResult>,
}): Promise<TResult> {
  const lock = getChatChoiceLock({ chatId });
  return await lock.run({ task: run });
}

export const requestChoice: RequestChoice = async ({
  chatId,
  prompt,
  choices,
  signal,
}) => {
  return await runWithChatChoiceLock({
    chatId,
    run: async () => {
      if (signal?.aborted === true) {
        throw new Error('Generation aborted');
      }

      const request: ChoicesActiveRequest = {
        requestId: generateId<ToolChoicesRequestId>(),
        chatId,
        prompt,
        choices: [...choices],
      };

      try {
        return await waitForChoiceSelection({
          request,
          signal,
        });
      } finally {
        clearActiveChoiceRequest({
          chatId,
          requestId: request.requestId,
        });
        pendingSelections.delete(request.requestId);
      }
    },
  });
};

export function useChoices(): {
  requestChoice: RequestChoice,
  getActiveChoiceRequest: ({
    chatId,
  }: {
    chatId: ChatId,
  }) => ComputedRef<ChoicesActiveRequest | undefined>,
  resolveChoiceRequest: ({
    requestId,
    index,
  }: {
    requestId: ToolChoicesRequestId,
    index: number,
  }) => void,
  TEST_ONLY: {
    clearAll: () => void,
  },
  } {
  function getActiveChoiceRequest({
    chatId,
  }: {
    chatId: ChatId,
  }): ComputedRef<ChoicesActiveRequest | undefined> {
    return computed(() => choicesRuntimeState.activeRequestsByChatId.get(chatId));
  }

  function resolveChoiceRequest({
    requestId,
    index,
  }: {
    requestId: ToolChoicesRequestId,
    index: number,
  }): void {
    const pending = pendingSelections.get(requestId);
    if (pending === undefined) {
      return;
    }

    if (!Number.isInteger(index) || index < 0 || index >= pending.request.choices.length) {
      throw new Error(`Choice index is out of range: ${index}`);
    }

    pendingSelections.delete(requestId);
    pending.resolve({ selection: { index } });
  }

  function clearAll(): void {
    choicesRuntimeState.activeRequestsByChatId.clear();
    pendingSelections.clear();
    chatChoiceLocks.clear();
  }

  return {
    requestChoice,
    getActiveChoiceRequest,
    resolveChoiceRequest,
    ...((__BUILD_MODE_IS_TEST__ && {
      TEST_ONLY: {
        clearAll,
      },
    }) || {}),
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {};
