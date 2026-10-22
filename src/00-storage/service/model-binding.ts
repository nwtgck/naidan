import { resolveChatModelBinding } from '@/01-models/chat-model-binding';
import type { IStorageProvider } from './interface';
import type { ChatContent, ChatMeta, Endpoint, MessageBranch, MessageNode } from '@/01-models/types';
import type { ChatGroupId, ChatId, MessageId } from '@/01-models/ids';
import { idToRaw } from '@/01-models/ids';
import { promoteModelLaunchBinding } from './model-launch';
import { chatContentFingerprint, readChatContentWrite, type ChatContentWrite } from './chat-content-binding';
import { chatModelBindingAssistantFingerprint } from '@/01-models/chat-message';

export type ModelBindingSnapshot = {
  readonly chatId: ChatId,
  readonly sourceModelId: string,
  readonly chat: { readonly groupId: ChatGroupId | undefined, readonly endpoint: Endpoint | undefined, readonly modelId: string | undefined },
  readonly chatGroup: { readonly id: ChatGroupId, readonly endpoint: Endpoint | undefined, readonly modelId: string | undefined } | undefined,
  readonly global: { readonly endpoint: Endpoint, readonly modelId: string },
  readonly chatRevision: number,
  readonly chatGroupRevision: number,
  readonly chatGroupTarget: 'candidate' | 'not-targeted',
  readonly isCurrent: () => boolean,
};
export type ModelBindingPromotionResult = {
  chat: 'applied' | 'changed',
  chatGroup: 'applied' | 'changed' | 'not-targeted',
  content: 'applied' | 'changed',
};
type PromotionProgress = {
  modelId: string,
  chat: { endpoint?: Endpoint, modelId?: string } | undefined,
  chatGroup: { endpoint?: Endpoint, modelId?: string } | undefined,
  contentFingerprint: string | undefined,
};
// Finite operation-local progress permits retry after a durable write rejects.
const promotionProgress = new WeakMap<ModelBindingSnapshot, PromotionProgress>();

async function ownerIsPresent({ provider, chatId, chatGroupId }: { provider: IStorageProvider, chatId: ChatId, chatGroupId: ChatGroupId | undefined }): Promise<boolean> {
  const hierarchy = await provider.loadHierarchy();
  const rawChatId = idToRaw({ id: chatId });
  return hierarchy?.items.some(item => {
    switch (item.type) {
    case 'chat': return chatGroupId === undefined && item.id === rawChatId;
    case 'chat_group': return chatGroupId !== undefined && item.id === idToRaw({ id: chatGroupId }) && item.chat_ids.includes(rawChatId);
    default: {
      const exhaustive: never = item;
      throw new Error(String(exhaustive));
    }
    }
  }) ?? false;
}

export function sameModelBindingFields({ left, right }: { left: { endpoint?: Endpoint, modelId?: string }, right: { endpoint?: Endpoint, modelId?: string } }): boolean {
  return left.modelId === right.modelId && JSON.stringify(left.endpoint) === JSON.stringify(right.endpoint);
}


export async function captureModelBinding({ provider, chatId, sourceModelId, chatRevision, chatGroupRevision, isCurrent }: {
  provider: IStorageProvider, chatId: ChatId, sourceModelId: string, chatRevision: number, chatGroupRevision({ id }: { id: ChatGroupId }): number, isCurrent(): boolean,
}): Promise<ModelBindingSnapshot | undefined> {
  const chat = await provider.loadChatMeta({ id: chatId });
  const settings = await provider.loadSettings();
  if (chat === null || settings === null || !isCurrent()) {
    return undefined;
  }
  if (!await ownerIsPresent({ provider, chatId, chatGroupId: chat.groupId ?? undefined })) {
    return undefined;
  }
  const chatGroup = chat.groupId == null ? null : await provider.loadChatGroup({ id: chat.groupId });
  const pair = resolveChatModelBinding({ chat, chatGroup, settings });
  if (!isCurrent() || pair.chat.endpoint.type !== 'llama_cpp_browser' || pair.chat.modelId !== sourceModelId) {
    return undefined;
  }
  return {
    chatId,
    sourceModelId,
    chat: { groupId: chat.groupId ?? undefined, endpoint: structuredClone(chat.endpoint), modelId: chat.modelId },
    chatGroup: chatGroup === null ? undefined : { id: chatGroup.id, endpoint: structuredClone(chatGroup.endpoint), modelId: chatGroup.modelId },
    global: { endpoint: structuredClone(settings.endpoint), modelId: settings.defaultModelId || '' },
    chatRevision,
    chatGroupRevision: chatGroup === null ? 0 : chatGroupRevision({ id: chatGroup.id }),
    chatGroupTarget: pair.sources.modelId === 'chat_group' && chatGroup !== null && pair.chatGroup.endpoint.type === 'llama_cpp_browser' && pair.chatGroup.modelId === sourceModelId ? 'candidate' : 'not-targeted',
    isCurrent,
  };
}

function patchKnownMessages({ branch, knownMessageIds, knownMessageFingerprints, sourceModelId, modelId }: { branch: MessageBranch, knownMessageIds: ReadonlySet<MessageId>, knownMessageFingerprints: ReadonlyMap<MessageId, string> | undefined, sourceModelId: string, modelId: string }): MessageBranch {
  return {
    ...branch,
    items: branch.items.map((node): MessageNode => {
      const replies = patchKnownMessages({ branch: node.replies, knownMessageIds, knownMessageFingerprints, sourceModelId, modelId });
      switch (node.role) {
      case 'assistant': return {
        ...node,
        modelId: knownMessageIds.has(node.id) && node.modelId === sourceModelId
        && (knownMessageFingerprints === undefined || knownMessageFingerprints.get(node.id) === chatModelBindingAssistantFingerprint({ node })) ? modelId : node.modelId,
        replies,
      };
      case 'user': case 'system': case 'tool': return { ...node, replies };
      default: {
        const exhaustive: never = node;
        throw new Error(String(exhaustive));
      }
      }
    }),
  };
}

/** The caller owns metadata, settings, and this owner's content lock. */
export async function promoteModelBinding({ provider, expected, modelId, knownMessageIds, knownMessageFingerprints, expectedContent, globalOutcome, chatRevision, chatGroupRevision, onWriteAttempt }: {
  provider: IStorageProvider, expected: ModelBindingSnapshot, modelId: string, knownMessageIds: readonly MessageId[], knownMessageFingerprints: ReadonlyMap<MessageId, string> | undefined, expectedContent: ChatContentWrite,
  onWriteAttempt({ scope }: { scope: 'metadata' | 'content' }): void,
  globalOutcome: 'applied' | 'changed' | 'not-targeted', chatRevision: number, chatGroupRevision({ id }: { id: ChatGroupId }): number,
}): Promise<ModelBindingPromotionResult> {
  let chatGroupOutcome: ModelBindingPromotionResult['chatGroup'];
  switch (expected.chatGroupTarget) {
  case 'candidate': chatGroupOutcome = 'changed';
    break;
  case 'not-targeted': chatGroupOutcome = 'not-targeted';
    break;
  default: {
    const exhaustive: never = expected.chatGroupTarget;
    throw new Error(String(exhaustive));
  }
  }
  const result: ModelBindingPromotionResult = { chat: 'changed', chatGroup: chatGroupOutcome, content: 'changed' };
  if (!expected.isCurrent()) {
    return result;
  }
  const chat = await provider.loadChatMeta({ id: expected.chatId });
  const settings = await provider.loadSettings();
  if (chat === null || settings === null || !expected.isCurrent()) {
    return result;
  }
  if (!await ownerIsPresent({ provider, chatId: expected.chatId, chatGroupId: expected.chat.groupId })) {
    return result;
  }
  const chatGroup = chat.groupId == null ? null : await provider.loadChatGroup({ id: chat.groupId });
  let progress = promotionProgress.get(expected);
  if (progress !== undefined && progress.modelId !== modelId) {
    return result;
  }
  if (progress === undefined) {
    progress = { modelId, chat: undefined, chatGroup: undefined, contentFingerprint: undefined };
    promotionProgress.set(expected, progress);
  }
  const sameMembership = (chat.groupId ?? undefined) === expected.chat.groupId;
  const pairs = resolveChatModelBinding({ chat, chatGroup, settings });
  const ownChatCommit = progress.chat !== undefined && sameModelBindingFields({ left: chat, right: progress.chat });
  const ownGroupCommit = progress.chatGroup !== undefined && chatGroup !== null && sameModelBindingFields({ left: chatGroup, right: progress.chatGroup });
  const sameChat = sameMembership && chatRevision === expected.chatRevision && (sameModelBindingFields({ left: chat, right: expected.chat }) || ownChatCommit);
  const ownGlobalCommit = globalOutcome === 'applied'
    && expected.global.endpoint.type === 'llama_cpp_browser' && expected.global.modelId === expected.sourceModelId
    && settings.endpoint.type === 'llama_cpp_browser' && settings.defaultModelId === modelId;
  const sourceMatches = (pairs.chat.modelId === expected.sourceModelId || ((ownGlobalCommit || ownChatCommit || ownGroupCommit) && pairs.chat.modelId === modelId))
    && pairs.chat.endpoint.type === 'llama_cpp_browser';
  const groupMatches = expected.chatGroupTarget === 'candidate' && sameMembership && chatGroup !== null && expected.chatGroup !== undefined
    && chatGroup.id === expected.chatGroup.id && chatGroupRevision({ id: chatGroup.id }) === expected.chatGroupRevision
    && (sameModelBindingFields({ left: chatGroup, right: expected.chatGroup }) || ownGroupCommit)
    && pairs.chatGroup.endpoint.type === 'llama_cpp_browser'
    && (pairs.chatGroup.modelId === expected.sourceModelId || ((ownGlobalCommit || ownGroupCommit) && pairs.chatGroup.modelId === modelId));

  if (!expected.isCurrent()) {
    return result;
  }
  // Each scope is conditional independently. A changed owner does not veto its
  // still-matching supplying chat group or the separately committed global pair.
  if (groupMatches && chatGroup !== null) {
    const updated = { ...chatGroup, modelId };
    progress.chatGroup = { endpoint: updated.endpoint, modelId: updated.modelId };
    onWriteAttempt({ scope: 'metadata' });
    await provider.saveChatGroup({ chatGroup: updated });
    result.chatGroup = 'applied';
  }
  if (!expected.isCurrent()) {
    return result;
  }
  if (sameChat && sourceMatches) {
    const inheritedSaved = result.chatGroup === 'applied' || (!chat.modelId && ownGlobalCommit && pairs.chat.modelId === modelId);
    const updated: ChatMeta = inheritedSaved ? { ...chat } : { ...chat, endpoint: { type: 'llama_cpp_browser' }, modelId };
    progress.chat = { endpoint: updated.endpoint, modelId: updated.modelId };
    onWriteAttempt({ scope: 'metadata' });
    await provider.saveChatMeta({ meta: updated });
    await promoteModelLaunchBinding({ provider, chatId: expected.chatId, sourceModelId: expected.sourceModelId, modelId });
    result.chat = 'applied';
  }
  switch (result.chat) {
  case 'applied': {
    const content = await provider.loadChatContent({ id: expected.chatId });
    const fingerprint = content === null ? undefined : chatContentFingerprint({ content });
    if (content !== null && progress.contentFingerprint !== undefined && fingerprint === progress.contentFingerprint) {
      result.content = 'applied';
    } else if (content !== null && fingerprint === readChatContentWrite({ write: expectedContent, id: expected.chatId }).baseline && expected.isCurrent()) {
      const updated: ChatContent = {
        ...content,
        root: patchKnownMessages({ branch: content.root, knownMessageIds: new Set(knownMessageIds), knownMessageFingerprints, sourceModelId: expected.sourceModelId, modelId }),
      };
      progress.contentFingerprint = chatContentFingerprint({ content: updated });
      if (progress.contentFingerprint !== fingerprint) {
        onWriteAttempt({ scope: 'content' });
        await provider.saveChatContent({ id: expected.chatId, content: updated });
      }
      result.content = 'applied';
    }
    break;
  }
  case 'changed': break;
  default: {
    const exhaustive: never = result.chat;
    throw new Error(String(exhaustive));
  }
  }
  return result;
}

export const TEST_ONLY = {
};
