import { computed, ref, type ComputedRef, type Ref } from 'vue';
import type { MessageNode } from '@/models/types';
import type { ChatFlowItem } from './useChatDisplayFlow';

type MaybeReadonlyRef<T> = Ref<T> | ComputedRef<T>;
type ChatAreaContext = {
  id: string;
  currentLeafId?: string;
};

export type ChatAreaScrollTarget =
  | { kind: 'message'; anchorId: string; messageId: string }
  | { kind: 'process_sequence'; anchorId: string; sequenceId: string }
  | { kind: 'tool_group'; anchorId: string; toolGroupId: string };

export type ChatAreaInitialOpenTarget =
  | ChatAreaScrollTarget
  | { kind: 'bottom' };

export interface ChatAreaAutoScrollSnapshot {
  contextKey: string | undefined;
  latestUserTurnId: string | undefined;
  initialOpenTarget: ChatAreaInitialOpenTarget;
  firstAssistantVisibleTarget: ChatAreaScrollTarget | undefined;
}

type ChatAreaAutoScrollState =
  | { kind: 'uninitialized' }
  | { kind: 'awaiting_user_turn'; contextKey: string }
  | { kind: 'ready_for_assistant'; contextKey: string; userTurnId: string }
  | { kind: 'assistant_scrolled'; contextKey: string; userTurnId: string };

export type ChatAreaAutoScrollAction =
  | { kind: 'initial_open'; target: ChatAreaInitialOpenTarget }
  | { kind: 'assistant'; target: ChatAreaScrollTarget; userTurnId: string };

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

function getInitialOpenTarget({ latestUserTurnId }: { latestUserTurnId: string | undefined }): ChatAreaInitialOpenTarget {
  if (!latestUserTurnId) {
    return { kind: 'bottom' };
  }
  return {
    kind: 'message',
    anchorId: `message-${latestUserTurnId}`,
    messageId: latestUserTurnId,
  };
}

function getScrollTargetForItem({ item }: { item: ChatFlowItem }): ChatAreaScrollTarget | undefined {
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
}): ChatAreaScrollTarget | undefined {
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

function getNextStateForSnapshot({
  currentState,
  snapshot,
}: {
  currentState: ChatAreaAutoScrollState;
  snapshot: ChatAreaAutoScrollSnapshot;
}): ChatAreaAutoScrollState {
  if (!snapshot.contextKey) {
    return { kind: 'uninitialized' };
  }

  if (currentState.kind === 'uninitialized' || currentState.contextKey !== snapshot.contextKey) {
    if (!snapshot.latestUserTurnId) {
      return { kind: 'awaiting_user_turn', contextKey: snapshot.contextKey };
    }
    return {
      kind: 'assistant_scrolled',
      contextKey: snapshot.contextKey,
      userTurnId: snapshot.latestUserTurnId,
    };
  }

  if (!snapshot.latestUserTurnId) {
    return { kind: 'awaiting_user_turn', contextKey: snapshot.contextKey };
  }

  if (currentState.kind === 'assistant_scrolled' && currentState.userTurnId === snapshot.latestUserTurnId) {
    return currentState;
  }

  return {
    kind: 'ready_for_assistant',
    contextKey: snapshot.contextKey,
    userTurnId: snapshot.latestUserTurnId,
  };
}

export function useChatAreaAutoScroll({
  currentChat,
  activeMessages,
  chatFlow,
}: {
  currentChat: MaybeReadonlyRef<ChatAreaContext | null>;
  activeMessages: MaybeReadonlyRef<readonly MessageNode[]>;
  chatFlow: MaybeReadonlyRef<readonly ChatFlowItem[]>;
}) {
  const state = ref<ChatAreaAutoScrollState>({ kind: 'uninitialized' });

  const snapshot = computed<ChatAreaAutoScrollSnapshot>(() => {
    const chat = currentChat.value;
    const contextKey = chat ? `${chat.id}:${chat.currentLeafId ?? ''}` : undefined;
    const latestUserTurnId = getLatestUserTurnId({ activeMessages: [...activeMessages.value] });

    return {
      contextKey,
      latestUserTurnId,
      initialOpenTarget: getInitialOpenTarget({ latestUserTurnId }),
      firstAssistantVisibleTarget: getFirstAssistantVisibleTarget({
        chatFlow: [...chatFlow.value],
        latestUserTurnId,
      }),
    };
  });

  function consumeScrollAction(): ChatAreaAutoScrollAction | undefined {
    const currentSnapshot = snapshot.value;
    const previousState = state.value;
    const nextState = getNextStateForSnapshot({
      currentState: previousState,
      snapshot: currentSnapshot,
    });
    state.value = nextState;

    if (currentSnapshot.contextKey && (previousState.kind === 'uninitialized' || previousState.contextKey !== currentSnapshot.contextKey)) {
      return {
        kind: 'initial_open',
        target: currentSnapshot.initialOpenTarget,
      };
    }

    switch (nextState.kind) {
    case 'ready_for_assistant':
      break;
    case 'uninitialized':
    case 'awaiting_user_turn':
    case 'assistant_scrolled':
      return undefined;
    default: {
      const _ex: never = nextState;
      return _ex;
    }
    }

    if (!currentSnapshot.firstAssistantVisibleTarget) {
      return undefined;
    }

    return {
      kind: 'assistant',
      target: currentSnapshot.firstAssistantVisibleTarget,
      userTurnId: nextState.userTurnId,
    };
  }

  function markAssistantAutoScrolled({
    contextKey,
    userTurnId,
  }: {
    contextKey: string;
    userTurnId: string;
  }): void {
    state.value = {
      kind: 'assistant_scrolled',
      contextKey,
      userTurnId,
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
