import { retargetTitleGenerationToSameScope } from '@/01-models/title-generation';
import type { Chat, ChatMeta, Hierarchy, SettingsTitleGeneration } from '@/01-models/types';
import type { ChatGroupId, ChatId } from '@/01-models/ids';
import type { IStorageProvider } from './interface';
import { hierarchyToDomain, hierarchyToDto } from '@/00-storage/mapper/mappers';

export type LocalModelChatRequest = {
  chatId: ChatId,
  chatGroupId: ChatGroupId,
  modelId: string,
  chatGroupName: string,
  titleGeneration: SettingsTitleGeneration,
};
type LocalModelChatReceipt = { request: LocalModelChatRequest, phase: 'reserved' | 'active' | 'detached' };
const receipts = new WeakMap<IStorageProvider, Map<ChatId, LocalModelChatReceipt>>();

function chatLocation({ hierarchy, chatId }: { hierarchy: Hierarchy, chatId: ChatId }): { chatGroupId: ChatGroupId | undefined } | undefined {
  for (const item of hierarchy.items) {
    switch (item.type) {
    case 'chat':
      if (item.id === chatId) {
        return { chatGroupId: undefined };
      }
      break;
    case 'chat_group':
      if (item.chat_ids.includes(chatId)) {
        return { chatGroupId: item.id };
      }
      break;
    default: {
      const exhaustive: never = item;
      throw new Error(String(exhaustive));
    }
    }
  }
  return undefined;
}

/** Stable IDs repair only this operation's partial writes in this page. */
export async function prepareLocalModelChat({ provider, request, beforeWrite }: { provider: IStorageProvider, request: LocalModelChatRequest, beforeWrite?: () => void }): Promise<Chat> {
  const { chatId, chatGroupId, modelId, chatGroupName, titleGeneration, ...unhandled } = request;
  unhandled satisfies Record<PropertyKey, never>;
  const acceptedRequest: LocalModelChatRequest = { chatId, chatGroupId, modelId, chatGroupName, titleGeneration: retargetTitleGenerationToSameScope({ source: titleGeneration, model: 'same_scope' }) };
  let session = receipts.get(provider);
  if (session === undefined) {
    session = new Map();
    receipts.set(provider, session);
  }
  let receipt = session.get(chatId);
  const meta = await provider.loadChatMeta({ id: chatId });
  const content = await provider.loadChatContent({ id: chatId });
  const chatGroup = await provider.loadChatGroup({ id: chatGroupId });
  const rawHierarchy = await provider.loadHierarchy();
  const hierarchy: Hierarchy = rawHierarchy === null ? { items: [] } : hierarchyToDomain({ dto: rawHierarchy });
  const location = chatLocation({ hierarchy, chatId });
  if (receipt === undefined) {
    if (meta !== null || content !== null || chatGroup !== null || location !== undefined) {
      throw new Error('The local model chat ID is already in use');
    }
    receipt = { request: acceptedRequest, phase: 'reserved' };
    session.set(chatId, receipt);
  } else if (JSON.stringify(receipt.request) !== JSON.stringify(acceptedRequest)) {
    throw new Error('The local model chat request changed');
  }
  const rawSettingsChanged = meta !== null && (meta.endpoint !== undefined || meta.modelId !== undefined);
  const groupChanged = chatGroup !== null && (chatGroup.endpoint?.type !== 'llama_cpp_browser' || chatGroup.modelId !== modelId);
  if (receipt.phase === 'detached' || rawSettingsChanged || groupChanged
    || (location !== undefined && location.chatGroupId !== chatGroupId)
    || (receipt.phase === 'active' && (meta === null || content === null || chatGroup === null || location === undefined))
    || (meta === null && (content !== null || chatGroup !== null || location !== undefined))) {
    receipt.phase = 'detached';
    throw new Error('The local model chat was moved, removed, or changed');
  }
  switch (receipt.phase) {
  case 'active': {
    const chat = await provider.loadChat({ id: chatId });
    if (chat === null) {
      throw new Error('The local model chat is missing');
    }
    return chat;
  }
  case 'reserved': break;
  default: {
    const exhaustive: never = receipt.phase;
    throw new Error(String(exhaustive));
  }
  }
  if (content !== null && content.root.items.length > 0) {
    throw new Error('Cannot repair a local model chat with conversation content');
  }
  const now = Date.now();
  beforeWrite?.();
  const reservedMeta: ChatMeta = meta ?? { id: chatId, title: null, createdAt: now, updatedAt: now, debugEnabled: false };
  if (meta === null) {
    await provider.saveChatMeta({ meta: reservedMeta });
  }
  if (chatGroup === null) {
    await provider.saveChatGroup({
      chatGroup: {
        id: chatGroupId,
        name: chatGroupName,
        isCollapsed: false,
        items: [],
        updatedAt: now,
        endpoint: { type: 'llama_cpp_browser' },
        modelId,
        titleGeneration: receipt.request.titleGeneration,
      },
    });
  }
  if (content === null) {
    await provider.saveChatContent({ id: chatId, content: { root: { items: [] }, currentLeafId: undefined } });
  }
  if (location === undefined) {
    const groupNode = hierarchy.items.find(item => item.type === 'chat_group' && item.id === chatGroupId);
    switch (groupNode?.type) {
    case 'chat_group':
      groupNode.chat_ids.unshift(chatId);
      break;
    case undefined:
      hierarchy.items.unshift({ type: 'chat_group', id: chatGroupId, chat_ids: [chatId] });
      break;
    case 'chat': throw new Error('Invalid local model chat group destination');
    default: {
      const exhaustive: never = groupNode;
      throw new Error(String(exhaustive));
    }
    }
    await provider.saveHierarchy({ hierarchy: hierarchyToDto({ domain: hierarchy }) });
  }
  receipt.phase = 'active';
  const chat = await provider.loadChat({ id: chatId });
  if (chat === null) {
    throw new Error('The saved local model chat could not be read');
  }
  return chat;
}

export const TEST_ONLY = {
};
