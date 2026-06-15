import { reactive, toRaw } from 'vue';
import type { AssistantMessageNode, Chat, Hierarchy, HierarchyChatGroupNode, HierarchyNode, LmParameters, MessageNode, SystemPrompt, ToolMessageNode, UserMessageNode } from '@/models/types';
import { EMPTY_LM_PARAMETERS } from '@/models/types';
import { storageService } from '@/services/storage';
import {
  createBranchFromMessages,
  findDeepestLeaf,
  findNodeInBranch,
  findParentInBranch,
  getChatBranchIterator,
  type HistoryItem,
} from '@/utils/chat-tree';
import { generateId } from '@/utils/id';
import {
  getLiveChat,
  getLiveChatById,
  isProcessing,
  loadData,
  registerLiveInstance,
  triggerCurrentChat as notifyChatChanged,
  updateChatContent,
  updateChatMeta,
} from '@/composables/chat/global/chat-core-singletons';
import {
  sendMessageToTargetChat,
} from '@/composables/chat/chat-scoped/chat-generation-flow';
import {
  abortProcessingForChat,
} from '@/composables/chat/chat-scoped/chat-processing-abort';
import type { ChatId, ChatGroupId, MessageId } from '@/models/ids';
import {
  useChatNavigation,
} from '@/composables/chat/ui/useChatNavigation';

export async function forkChatForChat({
  chatId,
  messageId,
}: {
  chatId: ChatId;
  messageId: MessageId;
}): Promise<ChatId | null> {
  return await forkChatFromTarget({
    targetChat: getLiveChatById({ chatId }),
    messageId,
  });
}

export async function editMessageForChat({
  chatId,
  messageId,
  newContent,
  lmParameters,
}: {
  chatId: ChatId;
  messageId: MessageId;
  newContent: string;
  lmParameters: LmParameters | undefined;
}): Promise<void> {
  const targetChat = getLiveChatById({ chatId });
  if (targetChat === null) {
    return;
  }
  await editMessageInTarget({
    targetChat,
    messageId,
    newContent,
    lmParameters,
  });
}

export async function switchVersionForChat({
  chatId,
  messageId,
}: {
  chatId: ChatId;
  messageId: MessageId;
}): Promise<void> {
  const targetChat = getLiveChatById({ chatId });
  if (targetChat === null) {
    return;
  }
  await switchVersionInTarget({
    targetChat,
    messageId,
  });
}

export async function commitFullHistoryManipulationForChat({
  chatId,
  messages,
  systemPrompt,
}: {
  chatId: ChatId;
  messages: HistoryItem[];
  systemPrompt: SystemPrompt | undefined;
}): Promise<void> {
  const target = getLiveChatById({ chatId });
  if (target === null) {
    return;
  }

  const mutableChat = getLiveChat({ chat: target });
  mutableChat.systemPrompt = systemPrompt;

  for (const message of messages) {
    if (!message.attachments) {
      continue;
    }
    for (let index = 0; index < message.attachments.length; index += 1) {
      const attachment = message.attachments[index]!;
      switch (attachment.status) {
      case 'memory':
        if (storageService.canPersistBinary) {
          try {
            await storageService.saveFile({ blob: attachment.blob, binaryObjectId: attachment.binaryObjectId, name: attachment.originalName });
            message.attachments[index] = { ...attachment, status: 'persisted' };
          } catch (error) {
            console.error('Failed to persist attachment during manipulation:', error);
          }
        }
        break;
      case 'persisted':
      case 'missing':
        break;
      default: {
        const _ex: never = attachment;
        throw new Error(`Unhandled attachment status: ${_ex}`);
      }
      }
    }
  }

  const newNodes = createBranchFromMessages({ messages });
  if (newNodes.length > 0) {
    if (!mutableChat.root) {
      mutableChat.root = { items: [] };
    }
    mutableChat.root.items.push(newNodes[0]!);
    mutableChat.currentLeafId = newNodes[newNodes.length - 1]!.id;
  }

  mutableChat.updatedAt = Date.now();
  notifyChatChanged({ chatId: mutableChat.id });

  await updateChatContent({
    id: mutableChat.id,

    updater: ({ current }) => ({ ...current, root: mutableChat.root, currentLeafId: mutableChat.currentLeafId }),
  });
  await updateChatMeta({
    id: mutableChat.id,

    updater: ({ current }) => {
      if (current === null) {
        return mutableChat;
      }
      return { ...current, updatedAt: Date.now(), currentLeafId: mutableChat.currentLeafId };
    },
  });
}

async function forkChatFromTarget({
  targetChat,
  messageId,
}: {
  targetChat: Chat | Readonly<Chat> | null;
  messageId: MessageId;
}): Promise<ChatId | null> {
  if (targetChat === null) {
    return null;
  }

  const mutableChat = getLiveChat({ chat: targetChat });
  const path = Array.from(getChatBranchIterator({ chat: mutableChat }));
  const pathIndex = path.findIndex((message) => message.id === messageId);
  if (pathIndex === -1) {
    return null;
  }

  const forkPath = path.slice(0, pathIndex + 1);
  const clonedNodes: MessageNode[] = forkPath.map((node) => {
    const common = {
      id: node.id,
      content: node.content ?? '',
      timestamp: node.timestamp,
      replies: { items: [] },
    };
    switch (node.role) {
    case 'user':
      return {
        ...common,
        role: 'user',
        attachments: node.attachments,
        thinking: undefined,
        error: undefined,
        modelId: undefined,
        lmParameters: node.lmParameters || EMPTY_LM_PARAMETERS,
        toolCalls: undefined,
        results: undefined,
      } as UserMessageNode;
    case 'assistant':
      return {
        ...common,
        role: 'assistant',
        attachments: undefined,
        thinking: node.thinking,
        error: node.error,
        modelId: node.modelId,
        lmParameters: node.lmParameters || EMPTY_LM_PARAMETERS,
        toolCalls: node.toolCalls,
        results: undefined,
      } as AssistantMessageNode;
    case 'system':
      return {
        ...common,
        role: 'system',
        attachments: undefined,
        thinking: undefined,
        error: undefined,
        modelId: undefined,
        lmParameters: undefined,
        toolCalls: undefined,
        results: undefined,
      } as MessageNode;
    case 'tool':
      return {
        ...common,
        role: 'tool',
        content: undefined,
        attachments: undefined,
        thinking: undefined,
        error: undefined,
        modelId: undefined,
        lmParameters: undefined,
        toolCalls: undefined,
        results: node.results,
      } as ToolMessageNode;
    default: {
      const _ex: never = node;
      throw new Error(`Unhandled role: ${(_ex as { role: string }).role}`);
    }
    }
  });

  for (let index = 0; index < clonedNodes.length - 1; index += 1) {
    clonedNodes[index]!.replies.items.push(clonedNodes[index + 1]!);
  }

  const newChatId = generateId<ChatId>();
  const newChat: Chat = reactive({
    ...toRaw(mutableChat),
    id: newChatId,
    title: `Fork of ${mutableChat.title || 'New Chat'}`,
    root: { items: [clonedNodes[0]!] },
    currentLeafId: clonedNodes[clonedNodes.length - 1]?.id,
    originChatId: mutableChat.id,
    originMessageId: messageId,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    modelId: mutableChat.modelId,
  });

  registerLiveInstance({ chat: newChat });
  await updateChatContent({
    id: newChatId,
    updater: () => ({ root: newChat.root, currentLeafId: newChat.currentLeafId }),
  });
  await updateChatMeta({
    id: newChatId,
    updater: () => newChat,
  });
  await storageService.updateHierarchy({ updater: ({ current }) => {
    return prependForkedChatToHierarchy({
      current,
      newChatId,
      chatGroupId: mutableChat.groupId,
    });
  } });
  await loadData();
  await useChatNavigation().openChat({ chatId: newChat.id, leafId: undefined });
  return newChat.id;
}

async function editMessageInTarget({
  targetChat,
  messageId,
  newContent,
  lmParameters,
}: {
  targetChat: Chat | Readonly<Chat>;
  messageId: MessageId;
  newContent: string;
  lmParameters: LmParameters | undefined;
}): Promise<void> {
  if (isProcessing({ chatId: targetChat.id })) {
    abortProcessingForChat({
      chatId: targetChat.id,
    });
    while (isProcessing({ chatId: targetChat.id })) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  const mutableChat = getLiveChat({ chat: targetChat });
  const node = findNodeInBranch({ items: mutableChat.root.items, targetId: messageId });
  if (node === null) {
    return;
  }

  switch (node.role) {
  case 'assistant': {
    const correctedNode: AssistantMessageNode = {
      id: generateId<MessageId>(),
      role: 'assistant',
      content: newContent,
      attachments: undefined,
      timestamp: Date.now(),
      modelId: node.modelId,
      replies: { items: [] },
      thinking: undefined,
      error: undefined,
      lmParameters: node.lmParameters || EMPTY_LM_PARAMETERS,
      toolCalls: undefined,
      results: undefined,
    };
    const parent = findParentInBranch({ items: mutableChat.root.items, childId: messageId });
    if (parent) {
      parent.replies.items.push(correctedNode);
    } else {
      mutableChat.root.items.push(correctedNode);
    }
    mutableChat.currentLeafId = correctedNode.id;
    await updateChatContent({
      id: mutableChat.id,

      updater: ({ current }) => ({ ...current, root: mutableChat.root, currentLeafId: mutableChat.currentLeafId }),
    });
    notifyChatChanged({ chatId: mutableChat.id });
    break;
  }
  case 'user':
    await sendEditedMessage({
      mutableChat,
      messageId,
      newContent,
      attachments: node.attachments,
      lmParameters,
    });
    break;
  case 'system':
    await sendEditedMessage({
      mutableChat,
      messageId,
      newContent,
      attachments: undefined,
      lmParameters,
    });
    break;
  case 'tool':
    break;
  default: {
    const _ex: never = node;
    throw new Error(`Unhandled role: ${(_ex as { role: string }).role}`);
  }
  }
}

async function switchVersionInTarget({
  targetChat,
  messageId,
}: {
  targetChat: Chat | Readonly<Chat>;
  messageId: MessageId;
}): Promise<void> {
  const mutableChat = getLiveChat({ chat: targetChat });
  const node = findNodeInBranch({ items: mutableChat.root.items, targetId: messageId });
  if (node === null) {
    return;
  }

  mutableChat.currentLeafId = findDeepestLeaf({ node }).id;
  notifyChatChanged({ chatId: mutableChat.id });
  await updateChatContent({
    id: mutableChat.id,

    updater: ({ current }) => ({ ...current, root: mutableChat.root, currentLeafId: mutableChat.currentLeafId }),
  });
}

function prependForkedChatToHierarchy({
  current,
  newChatId,
  chatGroupId,
}: {
  current: Hierarchy;
  newChatId: ChatId;
  chatGroupId: ChatGroupId | null | undefined;
}): Hierarchy {
  const node: HierarchyNode = { type: 'chat', id: newChatId };
  if (chatGroupId) {
    const group = current.items.find(
      (item) => item.type === 'chat_group' && item.id === chatGroupId,
    ) as HierarchyChatGroupNode | undefined;
    if (group) {
      group.chat_ids.unshift(newChatId);
      return current;
    }
  }

  const firstChatIndex = current.items.findIndex((item) => item.type === 'chat');
  const insertIndex = firstChatIndex !== -1 ? firstChatIndex : current.items.length;
  current.items.splice(insertIndex, 0, node);
  return current;
}

async function sendEditedMessage({
  mutableChat,
  messageId,
  newContent,
  attachments,
  lmParameters,
}: {
  mutableChat: Chat;
  messageId: MessageId;
  newContent: string;
  attachments: UserMessageNode['attachments'] | undefined;
  lmParameters: LmParameters | undefined;
}): Promise<void> {
  const parent = findParentInBranch({ items: mutableChat.root.items, childId: messageId });
  await sendMessageToTargetChat({
    targetChat: mutableChat,
    content: newContent,
    parentId: parent ? parent.id : null,
    attachments,
    lmParameters,
  });
}
