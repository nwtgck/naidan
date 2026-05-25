import { reactive, toRaw, type Ref } from 'vue';
import { generateId } from '@/utils/id';
import {
  createBranchFromMessages,
  findDeepestLeaf,
  findNodeInBranch,
  findParentInBranch,
  getChatBranchIterator,
  type HistoryItem,
} from '@/utils/chat-tree';
import type {
  AssistantMessageNode,
  Chat,
  ChatContent,
  Hierarchy,
  HierarchyChatGroupNode,
  HierarchyNode,
  LmParameters,
  MessageNode,
  SystemMessageNode,
  SystemPrompt,
  ToolMessageNode,
  UserMessageNode,
} from '@/models/types';
import { EMPTY_LM_PARAMETERS } from '@/models/types';

export type ChatHistoryService = {
  forkChat({
    messageId,
    chatId,
  }: {
    messageId: string;
    chatId?: string;
  }): Promise<string | null>;

  editMessage({
    messageId,
    newContent,
    lmParameters,
  }: {
    messageId: string;
    newContent: string;
    lmParameters?: LmParameters;
  }): Promise<void>;

  switchVersion({
    messageId,
  }: {
    messageId: string;
  }): Promise<void>;

  getSiblings({
    messageId,
    chatId,
  }: {
    messageId: string;
    chatId?: string;
  }): MessageNode[];

  commitFullHistoryManipulation({
    chatId,
    messages,
    systemPrompt,
  }: {
    chatId: string;
    messages: HistoryItem[];
    systemPrompt: SystemPrompt | undefined;
  }): Promise<void>;
};

export function createChatHistoryService({
  currentChatRef,
  liveChatRegistry,
  getLiveChat,
  registerLiveInstance,
  updateChatContent,
  updateChatMeta,
  updateHierarchy,
  loadData,
  openChat,
  canPersistBinary,
  saveFile,
  isProcessing,
  abortChat,
  sendMessage,
  triggerCurrentChat,
}: {
  currentChatRef: Ref<Chat | null>;
  liveChatRegistry: Map<string, Chat>;
  getLiveChat: ({ chat }: { chat: Chat | Readonly<Chat> }) => Chat;
  registerLiveInstance: ({ chat }: { chat: Chat }) => void;
  updateChatContent: ({
    id,
    updater,
  }: {
    id: string;
    updater: (current: ChatContent | null) => ChatContent;
  }) => Promise<void>;
  updateChatMeta: ({
    id,
    updater,
  }: {
    id: string;
    updater: (current: Chat | null) => Chat | Promise<Chat>;
  }) => Promise<void>;
  updateHierarchy: (updater: (current: Hierarchy) => Hierarchy | Promise<Hierarchy>) => Promise<void>;
  loadData: (_args: Record<never, never>) => Promise<void>;
  openChat: ({ id }: { id: string }) => Promise<Chat | null>;
  canPersistBinary: () => boolean;
  saveFile: ({
    blob,
    binaryObjectId,
    originalName,
  }: {
    blob: Blob;
    binaryObjectId: string;
    originalName: string;
  }) => Promise<void>;
  isProcessing: ({ chatId }: { chatId: string }) => boolean;
  abortChat: ({ chatId }: { chatId: string }) => void;
  sendMessage: ({
    content,
    parentId,
    attachments,
    chatTarget,
    lmParameters,
  }: {
    content: string;
    parentId: string | null;
    attachments: UserMessageNode['attachments'] | undefined;
    chatTarget?: Chat;
    lmParameters?: LmParameters;
  }) => Promise<void>;
  triggerCurrentChat: ({ chatId }: { chatId: string }) => void;
}): ChatHistoryService {
  async function forkChat({
    messageId,
    chatId,
  }: {
    messageId: string;
    chatId?: string;
  }) {
    const target = chatId ? liveChatRegistry.get(chatId) : currentChatRef.value;
    if (!target) return null;
    const mutableChat = getLiveChat({ chat: target });
    const path = Array.from(getChatBranchIterator({ chat: mutableChat }));
    const idx = path.findIndex(message => message.id === messageId);
    if (idx === -1) return null;
    const forkPath = path.slice(0, idx + 1);
    const clonedNodes: MessageNode[] = forkPath.map(node => {
      const common = { id: node.id, content: node.content, timestamp: node.timestamp, replies: { items: [] } };
      switch (node.role) {
      case 'user':
        return {
          ...common,
          role: 'user',
          attachments: node.attachments,
          thinking: undefined,
          error: undefined,
          modelId: undefined,
          lmParameters: node.lmParameters || { reasoning: { effort: undefined } },
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
          lmParameters: node.lmParameters || { reasoning: { effort: undefined } },
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
        } as SystemMessageNode;
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

    for (let i = 0; i < clonedNodes.length - 1; i++) {
      clonedNodes[i]!.replies.items.push(clonedNodes[i + 1]!);
    }

    const newChatId = generateId();
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
    await updateHierarchy(current => {
      const node: HierarchyNode = { type: 'chat', id: newChatId };
      const chatGroupId = mutableChat.groupId;
      if (chatGroupId) {
        const group = current.items.find(item => item.type === 'chat_group' && item.id === chatGroupId) as HierarchyChatGroupNode | undefined;
        if (group) {
          group.chat_ids.unshift(newChatId);
          return current;
        }
      }
      const firstChatIdx = current.items.findIndex(item => item.type === 'chat');
      const insertIdx = firstChatIdx !== -1 ? firstChatIdx : current.items.length;
      current.items.splice(insertIdx, 0, node);
      return current;
    });
    await loadData({});
    await openChat({ id: newChat.id });
    return newChat.id;
  }

  async function editMessage({
    messageId,
    newContent,
    lmParameters,
  }: {
    messageId: string;
    newContent: string;
    lmParameters?: LmParameters;
  }) {
    if (!currentChatRef.value) return;
    const chatId = toRaw(currentChatRef.value).id;
    if (isProcessing({ chatId })) {
      abortChat({ chatId });
      while (isProcessing({ chatId })) {
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    }

    const chat = getLiveChat({ chat: currentChatRef.value });
    const node = findNodeInBranch({ items: chat.root.items, targetId: messageId });
    if (!node) return;

    switch (node.role) {
    case 'assistant': {
      const correctedNode: AssistantMessageNode = {
        id: generateId(),
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
      const parent = findParentInBranch({ items: chat.root.items, childId: messageId });
      if (parent) parent.replies.items.push(correctedNode);
      else chat.root.items.push(correctedNode);
      chat.currentLeafId = correctedNode.id;
      await updateChatContent({
        id: chat.id,
        updater: current => ({ ...current, root: chat.root, currentLeafId: chat.currentLeafId }),
      });
      triggerCurrentChat({ chatId: chat.id });
      break;
    }
    case 'user': {
      const parent = findParentInBranch({ items: chat.root.items, childId: messageId });
      await sendMessage({
        content: newContent,
        parentId: parent ? parent.id : null,
        attachments: node.attachments,
        chatTarget: chat,
        lmParameters,
      });
      break;
    }
    case 'system': {
      const parent = findParentInBranch({ items: chat.root.items, childId: messageId });
      await sendMessage({
        content: newContent,
        parentId: parent ? parent.id : null,
        attachments: undefined,
        chatTarget: chat,
        lmParameters,
      });
      break;
    }
    case 'tool':
      break;
    default: {
      const _ex: never = node;
      throw new Error(`Unhandled role: ${(_ex as { role: string }).role}`);
    }
    }
  }

  async function switchVersion({
    messageId,
  }: {
    messageId: string;
  }) {
    if (!currentChatRef.value) return;
    const chat = getLiveChat({ chat: currentChatRef.value });
    const node = findNodeInBranch({ items: chat.root.items, targetId: messageId });
    if (!node) return;
    chat.currentLeafId = findDeepestLeaf({ node }).id;
    triggerCurrentChat({ chatId: chat.id });
    await updateChatContent({
      id: chat.id,
      updater: current => ({ ...current, root: chat.root, currentLeafId: chat.currentLeafId }),
    });
  }

  function getSiblings({
    messageId,
    chatId,
  }: {
    messageId: string;
    chatId?: string;
  }) {
    const target = chatId ? liveChatRegistry.get(chatId) : currentChatRef.value;
    if (!target) return [];
    const mutableChat = getLiveChat({ chat: target });
    const parent = findParentInBranch({ items: mutableChat.root.items, childId: messageId });
    return parent ? parent.replies.items : mutableChat.root.items;
  }

  async function commitFullHistoryManipulation({
    chatId,
    messages,
    systemPrompt,
  }: {
    chatId: string;
    messages: HistoryItem[];
    systemPrompt: SystemPrompt | undefined;
  }) {
    const target = liveChatRegistry.get(chatId) || (currentChatRef.value && toRaw(currentChatRef.value).id === chatId ? currentChatRef.value : null);
    if (!target) return;
    const chat = getLiveChat({ chat: target });

    chat.systemPrompt = systemPrompt;

    for (const message of messages) {
      if (!message.attachments) continue;
      for (let i = 0; i < message.attachments.length; i++) {
        const attachment = message.attachments[i]!;
        const status = attachment.status;
        switch (status) {
        case 'memory':
          if (canPersistBinary()) {
            try {
              await saveFile({
                blob: attachment.blob,
                binaryObjectId: attachment.binaryObjectId,
                originalName: attachment.originalName,
              });
              message.attachments[i] = { ...attachment, status: 'persisted' };
            } catch (error) {
              console.error('Failed to persist attachment during manipulation:', error);
            }
          }
          break;
        case 'persisted':
        case 'missing':
          break;
        default: {
          const _ex: never = status;
          throw new Error(`Unhandled attachment status: ${_ex}`);
        }
        }
      }
    }

    const newNodes = createBranchFromMessages({ messages });

    if (newNodes.length > 0) {
      if (!chat.root) chat.root = { items: [] };
      chat.root.items.push(newNodes[0]!);
      chat.currentLeafId = newNodes[newNodes.length - 1]!.id;
    }

    chat.updatedAt = Date.now();
    triggerCurrentChat({ chatId: chat.id });

    await updateChatContent({
      id: chat.id,
      updater: current => ({ ...current, root: chat.root, currentLeafId: chat.currentLeafId }),
    });
    await updateChatMeta({
      id: chat.id,
      updater: current => {
        if (!current) return chat;
        return { ...current, updatedAt: Date.now(), currentLeafId: chat.currentLeafId };
      },
    });
  }

  return {
    forkChat,
    editMessage,
    switchVersion,
    getSiblings,
    commitFullHistoryManipulation,
  };
}
