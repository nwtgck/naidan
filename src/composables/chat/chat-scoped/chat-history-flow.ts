import { ensureStrings } from '@/strings';
import { reactive, toRaw } from 'vue';
import type { AssistantMessageNode, Attachment, Chat, Hierarchy, HierarchyChatGroupNode, HierarchyNode, LmParameters, MessageNode, SystemPrompt } from '@/01-models/types';
import { copyMessageWithoutReplies } from '@/logic/copy-message-node';
import { cloneLmParameters } from '@/utils/lm-parameters';
import { storageService } from '@/00-storage/service';
import {
  createBranchFromMessages,
  findDeepestLeaf,
  findNodeInBranch,
  findParentInBranch,
  getChatBranchIterator,
} from '@/logic/chat-tree';
import { generateId } from '@/01-models/id';
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
import type { ChatId, ChatGroupId, MessageId } from '@/01-models/ids';
import { cloneToolConfigs } from '@/features/tools/tool-config';
import {
  useChatNavigation,
} from '@/composables/chat/ui/useChatNavigation';

export async function forkChatForChat({
  chatId,
  messageId,
}: {
  chatId: ChatId,
  messageId: MessageId,
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
  chatId: ChatId,
  messageId: MessageId,
  newContent: string,
  lmParameters: LmParameters | undefined,
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
  chatId: ChatId,
  messageId: MessageId,
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
  chatId: ChatId,
  messages: readonly MessageNode[],
  systemPrompt: SystemPrompt | undefined,
}): Promise<void> {
  const chat = getLiveChatById({ chatId });
  if (chat === null) return;

  // Snapshot the complete proposed branch before any storage awaits. Only these
  // copies become the new branch; the editor and existing replies remain intact.
  const newNodes = createBranchFromMessages({ messages });
  const prompt = systemPrompt === undefined ? undefined : (() => {
    const { behavior, content, ...unhandled } = systemPrompt;
    unhandled satisfies Record<PropertyKey, never>;
    switch (behavior) {
    case 'override': return { behavior, content };
    case 'append':
      if (content === null) throw new Error('An append prompt must contain text.');
      return { behavior, content };
    default: { const _ex: never = behavior; throw new Error(`Unhandled prompt: ${_ex}`); }
    }
  })();

  for (const message of newNodes) {
    switch (message.role) {
    case 'user': break;
    case 'assistant':
    case 'system':
    case 'tool': continue;
    default: { const _ex: never = message; throw new Error(`Unhandled message: ${_ex}`); }
    }
    for (const part of message.parts) {
      switch (part.type) {
      case 'attachment': break;
      case 'text': continue;
      default: { const _ex: never = part; throw new Error(`Unhandled user part: ${_ex}`); }
      }
      const attachment = part.attachment;
      switch (attachment.status) {
      case 'memory':
        if (storageService.canPersistBinary) {
          try {
            await storageService.saveFile({ blob: attachment.blob, binaryObjectId: attachment.binaryObjectId, name: attachment.originalName });
            const { blob: _blob, status: _status, ...metadata } = attachment;
            part.attachment = { ...metadata, status: 'persisted' };
          } catch (error) {
            // Keep the in-memory body if persistence fails; no old file is removed.
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

  const mutableChat = getLiveChat({ chat });
  mutableChat.systemPrompt = prompt;
  if (newNodes.length > 0) {
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
    updater: ({ current }) => ({
      ...(current ?? mutableChat),
      systemPrompt: prompt,
      updatedAt: mutableChat.updatedAt,
      currentLeafId: mutableChat.currentLeafId,
    }),
  });
}

async function forkChatFromTarget({
  targetChat,
  messageId,
}: {
  targetChat: Chat | Readonly<Chat> | null,
  messageId: MessageId,
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
  const clonedNodes = forkPath.map(message => copyMessageWithoutReplies({ message }));

  for (let index = 0; index < clonedNodes.length - 1; index += 1) {
    clonedNodes[index]!.replies.items.push(clonedNodes[index + 1]!);
  }

  const untitledChatTitle = await ensureStrings.SHARED__new_chat();
  const forkTitle = await ensureStrings.chatHistoryFlow__fork_of_chat({
    chatTitle: mutableChat.title || untitledChatTitle,
  });
  const newChatId = generateId<ChatId>();
  const newChat: Chat = reactive({
    ...toRaw(mutableChat),
    id: newChatId,
    title: forkTitle,
    root: { items: [clonedNodes[0]!] },
    currentLeafId: clonedNodes[clonedNodes.length - 1]?.id,
    originChatId: mutableChat.id,
    originMessageId: messageId,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    modelId: mutableChat.modelId,
    lmParameters: cloneLmParameters({ lmParameters: mutableChat.lmParameters }),
    toolConfigs: cloneToolConfigs({ toolConfigs: mutableChat.toolConfigs }),
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
  targetChat: Chat | Readonly<Chat>,
  messageId: MessageId,
  newContent: string,
  lmParameters: LmParameters | undefined,
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
    // A manual replacement creates a sibling, not an edited version of generated reasoning or calls.
    // Keep the original node and every descendant intact for version switching.
    const correctedNode: AssistantMessageNode = {
      id: generateId<MessageId>(),
      role: 'assistant',
      parts: [{ id: 'text', type: 'text', text: newContent, completeness: 'complete' }],
      createdAt: Date.now(),
      modelId: node.modelId,
      replies: { items: [] },
      interruption: undefined,
      lmParameters: cloneLmParameters({ lmParameters: node.lmParameters }),
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
      attachments: node.parts.flatMap(part => {
        switch (part.type) {
        case 'text': return [];
        case 'attachment': return [part.attachment];
        default: { const _ex: never = part; throw new Error(`Unhandled user part: ${_ex}`); }
        }
      }),
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
  targetChat: Chat | Readonly<Chat>,
  messageId: MessageId,
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
  current: Hierarchy,
  newChatId: ChatId,
  chatGroupId: ChatGroupId | null | undefined,
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
  mutableChat: Chat,
  messageId: MessageId,
  newContent: string,
  attachments: Attachment[] | undefined,
  lmParameters: LmParameters | undefined,
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

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
