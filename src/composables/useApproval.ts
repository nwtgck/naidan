import { computed, reactive, type ComputedRef } from 'vue';
import { generateOpaqueId } from '@/utils/id';
import { Semaphore } from '@/utils/concurrency';
import type { ChatId } from '@/models/ids';
import type {
  ApprovalActionId,
  ApprovalActiveRequest,
  ApprovalEnsureRequest,
  ApprovalEnsureResult,
  ApprovalStoredStatus,
  ApprovalUiDecision,
  EnsureApproval,
} from '@/services/approval';

type ApprovalRuntimeState = {
  activeRequestsByChatId: Map<ChatId, ApprovalActiveRequest>;
  chatApprovalsByChatId: Map<ChatId, Set<ApprovalActionId>>;
  globalApprovalActionIds: Set<ApprovalActionId>;
};

const approvalRuntimeState = reactive<ApprovalRuntimeState>({
  activeRequestsByChatId: new Map(),
  chatApprovalsByChatId: new Map(),
  globalApprovalActionIds: new Set(),
});

const chatApprovalLocks = new Map<ChatId, Semaphore>();
const pendingDecisionResolvers = new Map<string, ({ decision }: { decision: ApprovalUiDecision }) => void>();

function getChatApprovalLock({
  chatId,
}: {
  chatId: ChatId;
}): Semaphore {
  const existing = chatApprovalLocks.get(chatId);
  if (existing !== undefined) {
    return existing;
  }

  const lock = new Semaphore({ maxConcurrency: 1 });
  chatApprovalLocks.set(chatId, lock);
  return lock;
}

function getStoredApprovalStatus({
  chatId,
  actionId,
}: {
  chatId: ChatId;
  actionId: ApprovalActionId;
}): ApprovalStoredStatus {
  if (approvalRuntimeState.globalApprovalActionIds.has(actionId)) {
    return 'approved';
  }

  const chatApprovals = approvalRuntimeState.chatApprovalsByChatId.get(chatId);
  if (chatApprovals?.has(actionId) === true) {
    return 'approved';
  }

  return 'missing';
}

function storeApprovalDecision({
  chatId,
  actionId,
  decision,
}: {
  chatId: ChatId;
  actionId: ApprovalActionId;
  decision: ApprovalUiDecision;
}): void {
  switch (decision) {
  case 'allow_once':
  case 'deny':
    return;
  case 'allow_for_chat': {
    const existing = approvalRuntimeState.chatApprovalsByChatId.get(chatId);
    const next = new Set(existing ?? []);
    next.add(actionId);
    approvalRuntimeState.chatApprovalsByChatId.set(chatId, next);
    return;
  }
  case 'allow_globally':
    approvalRuntimeState.globalApprovalActionIds.add(actionId);
    return;
  default: {
    const _ex: never = decision;
    throw new Error(`Unhandled approval UI decision: ${_ex}`);
  }
  }
}

function waitForApprovalUiDecision({
  request,
  signal,
}: {
  request: ApprovalActiveRequest;
  signal: AbortSignal | undefined;
}): Promise<ApprovalUiDecision> {
  approvalRuntimeState.activeRequestsByChatId.set(request.chatId, request);

  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(new Error('Generation aborted'));
      return;
    }

    const handleAbort = () => {
      pendingDecisionResolvers.delete(request.requestId);
      reject(new Error('Generation aborted'));
    };
    signal?.addEventListener('abort', handleAbort, { once: true });

    pendingDecisionResolvers.set(request.requestId, ({ decision }) => {
      signal?.removeEventListener('abort', handleAbort);
      resolve(decision);
    });
  });
}

function clearActiveApprovalRequest({
  chatId,
  requestId,
}: {
  chatId: ChatId;
  requestId: string;
}): void {
  const activeRequest = approvalRuntimeState.activeRequestsByChatId.get(chatId);
  if (activeRequest?.requestId !== requestId) {
    return;
  }
  approvalRuntimeState.activeRequestsByChatId.delete(chatId);
}

async function runWithChatApprovalLock<TResult>({
  chatId,
  run,
}: {
  chatId: ChatId;
  run: () => Promise<TResult>;
}): Promise<TResult> {
  const lock = getChatApprovalLock({ chatId });
  return await lock.run({ task: run });
}

export async function ensureApproval({
  chatId,
  action,
  preview,
  signal,
}: {
  chatId: ChatId;
  action: ApprovalEnsureRequest['action'];
  preview: ApprovalEnsureRequest['preview'];
  signal: ApprovalEnsureRequest['signal'];
}): Promise<ApprovalEnsureResult> {
  return await runWithChatApprovalLock({
    chatId,
    run: async () => {
      if (signal?.aborted === true) {
        throw new Error('Generation aborted');
      }

      const actionId = action.id;
      const storedStatus = getStoredApprovalStatus({
        chatId,
        actionId,
      });

      switch (storedStatus) {
      case 'approved':
        return { status: 'approved' };
      case 'missing':
        break;
      default: {
        const _ex: never = storedStatus;
        throw new Error(`Unhandled approval stored status: ${_ex}`);
      }
      }

      const request: ApprovalActiveRequest = {
        requestId: generateOpaqueId(),
        chatId,
        action,
        preview,
      };

      try {
        const decision = await waitForApprovalUiDecision({
          request,
          signal,
        });
        storeApprovalDecision({
          chatId,
          actionId,
          decision,
        });

        switch (decision) {
        case 'allow_once':
        case 'allow_for_chat':
        case 'allow_globally':
          return { status: 'approved' };
        case 'deny':
          return { status: 'denied' };
        default: {
          const _ex: never = decision;
          throw new Error(`Unhandled approval UI decision: ${_ex}`);
        }
        }
      } finally {
        clearActiveApprovalRequest({
          chatId,
          requestId: request.requestId,
        });
        pendingDecisionResolvers.delete(request.requestId);
      }
    },
  });
}

export function useApproval(): {
  ensureApproval: EnsureApproval;
  getActiveApprovalRequest: ({
    chatId,
  }: {
    chatId: ChatId;
  }) => ComputedRef<ApprovalActiveRequest | undefined>;
  resolveApprovalRequest: ({
    requestId,
    decision,
  }: {
    requestId: string;
    decision: ApprovalUiDecision;
  }) => void;
  TEST_ONLY: {
    getStoredApprovalStatus: ({
      chatId,
      actionId,
    }: {
      chatId: ChatId;
      actionId: ApprovalActionId;
    }) => ApprovalStoredStatus;
    clearAll: () => void;
  };
  } {
  function getActiveApprovalRequest({
    chatId,
  }: {
    chatId: ChatId;
  }): ComputedRef<ApprovalActiveRequest | undefined> {
    return computed(() => approvalRuntimeState.activeRequestsByChatId.get(chatId));
  }

  function resolveApprovalRequest({
    requestId,
    decision,
  }: {
    requestId: string;
    decision: ApprovalUiDecision;
  }): void {
    const resolver = pendingDecisionResolvers.get(requestId);
    if (resolver === undefined) {
      return;
    }
    resolver({ decision });
  }

  function clearAll(): void {
    approvalRuntimeState.activeRequestsByChatId.clear();
    approvalRuntimeState.chatApprovalsByChatId.clear();
    approvalRuntimeState.globalApprovalActionIds.clear();
    pendingDecisionResolvers.clear();
    chatApprovalLocks.clear();
  }

  return {
    ensureApproval,
    getActiveApprovalRequest,
    resolveApprovalRequest,
    TEST_ONLY: {
      getStoredApprovalStatus,
      clearAll,
    },
  };
}
