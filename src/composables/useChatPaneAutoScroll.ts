import { computed, ref, type ComputedRef, type Ref } from 'vue';
import type { MessageNode } from '@/models/types';
import type { ChatFlowItem } from './useChatDisplayFlow';

type MaybeReadonlyRef<T> = Ref<T> | ComputedRef<T>;
type ChatPaneContext = {
  id: string;
  currentLeafId?: string;
};
type ChatPaneProcessingStatus = 'idle' | 'processing';

export type ChatPaneScrollTarget =
  | { kind: 'message'; anchorId: string; messageId: string }
  | { kind: 'process_sequence'; anchorId: string; sequenceId: string }
  | { kind: 'tool_group'; anchorId: string; toolGroupId: string };

export type ChatPaneInitialOpenTarget =
  | ChatPaneScrollTarget
  | { kind: 'bottom' };

export interface ChatPaneAutoScrollSnapshot {
  chatId: string | undefined;
  navigationKey: string | undefined;
  processingStatus: ChatPaneProcessingStatus;
  latestUserTurnId: string | undefined;
  initialOpenTarget: ChatPaneInitialOpenTarget;
  firstAssistantVisibleTarget: ChatPaneScrollTarget | undefined;
}

type ChatPaneAutoScrollState =
  | { kind: 'uninitialized' }
  | {
      kind: 'tracking';
      chatId: string;
      navigationKey: string;
      response:
        | { kind: 'awaiting_user_turn' }
        | { kind: 'ready_for_assistant'; userTurnId: string }
        | { kind: 'assistant_scrolled'; userTurnId: string };
    };

export type ChatPaneAutoScrollAction =
  | { kind: 'initial_open'; target: ChatPaneInitialOpenTarget }
  | { kind: 'assistant'; target: ChatPaneScrollTarget; userTurnId: string };

function getLatestUserTurnId({ activeMessages }: { activeMessages: MessageNode[] }): string | undefined {
  for (let index = activeMessages.length - 1; index >= 0; index--) {
    const message = activeMessages[index];
    if (!message) {
      continue;
    }
    const role = message.role;
    switch (role) {
    case 'user':
      return message.id;
    case 'assistant':
    case 'system':
    case 'tool':
      break;
    default: {
      const _ex: never = role;
      return _ex;
    }
    }
  }
  return undefined;
}

function getInitialOpenTarget({ latestUserTurnId }: { latestUserTurnId: string | undefined }): ChatPaneInitialOpenTarget {
  if (!latestUserTurnId) {
    return { kind: 'bottom' };
  }
  return {
    kind: 'message',
    anchorId: `message-${latestUserTurnId}`,
    messageId: latestUserTurnId,
  };
}

function getScrollTargetForItem({ item }: { item: ChatFlowItem }): ChatPaneScrollTarget | undefined {
  switch (item.type) {
  case 'message': {
    const role = item.node.role;
    switch (role) {
    case 'assistant':
    case 'system':
    case 'tool':
      return {
        kind: 'message',
        anchorId: `message-${item.node.id}`,
        messageId: item.node.id,
      };
    case 'user':
      return undefined;
    default: {
      const _ex: never = role;
      return _ex;
    }
    }
  }
  case 'process_sequence':
    return {
      kind: 'process_sequence',
      anchorId: `process-sequence-${item.id}`,
      sequenceId: item.id,
    };
  case 'tool_group':
    return {
      kind: 'tool_group',
      anchorId: `tool-group-${item.id}`,
      toolGroupId: item.id,
    };
  default: {
    const _ex: never = item;
    return _ex;
  }
  }
}

function getFirstAssistantVisibleTarget({
  chatFlow,
  latestUserTurnId,
}: {
  chatFlow: ChatFlowItem[];
  latestUserTurnId: string | undefined;
}): ChatPaneScrollTarget | undefined {
  if (!latestUserTurnId) return undefined;

  let currentUserTurnId: string | undefined;
  for (const item of chatFlow) {
    if (item.type === 'message' && item.node.role === 'user') {
      currentUserTurnId = item.node.id;
      continue;
    }

    if (currentUserTurnId !== latestUserTurnId) {
      continue;
    }

    const target = getScrollTargetForItem({ item });
    if (target) {
      return target;
    }
  }

  return undefined;
}

function getNavigationKey({ chat }: { chat: ChatPaneContext }): string {
  return `${chat.id}:${chat.currentLeafId ?? ''}`;
}

function getOpenedResponseState({
  latestUserTurnId,
}: {
  latestUserTurnId: string | undefined;
}): Extract<ChatPaneAutoScrollState, { kind: 'tracking' }>['response'] {
  if (!latestUserTurnId) {
    return { kind: 'awaiting_user_turn' };
  }
  return {
    kind: 'assistant_scrolled',
    userTurnId: latestUserTurnId,
  };
}

function getResponseStateAfterContentChange({
  currentResponse,
  latestUserTurnId,
}: {
  currentResponse: Extract<ChatPaneAutoScrollState, { kind: 'tracking' }>['response'];
  latestUserTurnId: string | undefined;
}): Extract<ChatPaneAutoScrollState, { kind: 'tracking' }>['response'] {
  if (!latestUserTurnId) {
    return { kind: 'awaiting_user_turn' };
  }

  switch (currentResponse.kind) {
  case 'assistant_scrolled':
  case 'ready_for_assistant':
    if (currentResponse.userTurnId === latestUserTurnId) {
      return currentResponse;
    }
    return {
      kind: 'ready_for_assistant',
      userTurnId: latestUserTurnId,
    };
  case 'awaiting_user_turn':
    return {
      kind: 'ready_for_assistant',
      userTurnId: latestUserTurnId,
    };
  default: {
    const _ex: never = currentResponse;
    return _ex;
  }
  }
}

export function useChatPaneAutoScroll({
  chat,
  activeMessages,
  chatFlow,
  processingStatus,
}: {
  chat: MaybeReadonlyRef<ChatPaneContext | null>;
  activeMessages: MaybeReadonlyRef<readonly MessageNode[]>;
  chatFlow: MaybeReadonlyRef<readonly ChatFlowItem[]>;
  processingStatus: MaybeReadonlyRef<ChatPaneProcessingStatus>;
}) {
  const state = ref<ChatPaneAutoScrollState>({ kind: 'uninitialized' });

  const snapshot = computed<ChatPaneAutoScrollSnapshot>(() => {
    const chatValue = chat.value;
    const latestUserTurnId = getLatestUserTurnId({ activeMessages: [...activeMessages.value] });

    return {
      chatId: chatValue?.id,
      navigationKey: chatValue ? getNavigationKey({ chat: chatValue }) : undefined,
      processingStatus: processingStatus.value,
      latestUserTurnId,
      initialOpenTarget: getInitialOpenTarget({ latestUserTurnId }),
      firstAssistantVisibleTarget: getFirstAssistantVisibleTarget({
        chatFlow: [...chatFlow.value],
        latestUserTurnId,
      }),
    };
  });

  function consumeScrollAction(): ChatPaneAutoScrollAction | undefined {
    const currentSnapshot = snapshot.value;
    const previousState = state.value;

    if (!currentSnapshot.chatId || !currentSnapshot.navigationKey) {
      state.value = { kind: 'uninitialized' };
      return undefined;
    }

    const openedDifferentChat = previousState.kind === 'uninitialized' || previousState.chatId !== currentSnapshot.chatId;
    const changedBranchWhileIdle = previousState.kind === 'tracking'
      && previousState.navigationKey !== currentSnapshot.navigationKey
      && currentSnapshot.processingStatus === 'idle';

    if (openedDifferentChat || changedBranchWhileIdle) {
      state.value = {
        kind: 'tracking',
        chatId: currentSnapshot.chatId,
        navigationKey: currentSnapshot.navigationKey,
        response: getOpenedResponseState({ latestUserTurnId: currentSnapshot.latestUserTurnId }),
      };
      return {
        kind: 'initial_open',
        target: currentSnapshot.initialOpenTarget,
      };
    }

    const previousResponse = previousState.kind === 'tracking'
      ? previousState.response
      : { kind: 'awaiting_user_turn' as const };
    const nextResponse = getResponseStateAfterContentChange({
      currentResponse: previousResponse,
      latestUserTurnId: currentSnapshot.latestUserTurnId,
    });
    state.value = {
      kind: 'tracking',
      chatId: currentSnapshot.chatId,
      navigationKey: currentSnapshot.navigationKey,
      response: nextResponse,
    };

    switch (nextResponse.kind) {
    case 'ready_for_assistant':
      break;
    case 'awaiting_user_turn':
    case 'assistant_scrolled':
      return undefined;
    default: {
      const _ex: never = nextResponse;
      return _ex;
    }
    }

    if (!currentSnapshot.firstAssistantVisibleTarget) {
      return undefined;
    }

    return {
      kind: 'assistant',
      target: currentSnapshot.firstAssistantVisibleTarget,
      userTurnId: nextResponse.userTurnId,
    };
  }

  function markAssistantAutoScrolled({
    chatId,
    navigationKey,
    userTurnId,
  }: {
    chatId: string;
    navigationKey: string;
    userTurnId: string;
  }): void {
    state.value = {
      kind: 'tracking',
      chatId,
      navigationKey,
      response: {
        kind: 'assistant_scrolled',
        userTurnId,
      },
    };
  }

  return {
    snapshot,
    consumeScrollAction,
    markAssistantAutoScrolled,
    TEST_ONLY: {
      state,
    },
  };
}
