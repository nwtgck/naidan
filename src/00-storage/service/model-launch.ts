import { retargetTitleGenerationToSameScope } from '@/01-models/title-generation';
import type { IStorageProvider } from './interface';
import type { Chat, ChatGroup, Hierarchy, SettingsTitleGeneration } from '@/01-models/types';
import { idToRaw, toChatGroupId, type ChatId, type ChatGroupId } from '@/01-models/ids';
import { modelLaunchChatGroupPrefix, modelLaunchTargetSchema, type ModelLaunchTarget, type ChatModelLaunch } from '@/01-models/llama-cpp-browser-model-launch';
import { hierarchyToDomain, hierarchyToDto } from '@/00-storage/mapper/mappers';

export type ModelLaunchChatRequest = {
  chatId: ChatId,
  newChatGroupId: ChatGroupId,
  chatGroupName: string,
  input: string,
  requestedVariant: string | undefined,
  target: ModelLaunchTarget,
  titleGeneration: SettingsTitleGeneration,
  mode: 'create-or-resume' | 'retarget',
  expectedTarget: ModelLaunchTarget | undefined,
};
// No setup marker, source plan, or revision counter is written into DTOs.
// A browser reload intentionally discards this session-local recovery state.
const sessions = new WeakMap<IStorageProvider, Map<ChatId, ChatModelLaunch>>();

function sessionFor({ provider }: { provider: IStorageProvider }): Map<ChatId, ChatModelLaunch> {
  let session = sessions.get(provider);
  if (session === undefined) {
    session = new Map();
    sessions.set(provider, session);
  }
  return session;
}

export function readModelLaunch({ provider, chatId }: { provider: IStorageProvider, chatId: ChatId }): ChatModelLaunch | undefined {
  const launch = sessions.get(provider)?.get(chatId);
  return launch === undefined ? undefined : structuredClone(launch);
}

function containsChat({ hierarchy, chatId, chatGroupId }: { hierarchy: Hierarchy, chatId: ChatId, chatGroupId: ChatGroupId | undefined }): boolean {
  return hierarchy.items.some(item => {
    switch (item.type) {
    case 'chat': return chatGroupId === undefined && item.id === chatId;
    case 'chat_group': return (chatGroupId === undefined || item.id === chatGroupId) && item.chat_ids.includes(chatId);
    default: { const exhaustive: never = item; throw new Error(String(exhaustive)); }
    }
  });
}

function matchesModel({ chatGroup, modelId }: { chatGroup: ChatGroup, modelId: string }): boolean {
  return chatGroup.endpoint?.type === 'llama_cpp_browser' && chatGroup.modelId === modelId;
}

export async function restoreModelLaunch({ provider, chatId, input, requestedVariant, target }: {
  provider: IStorageProvider, chatId: ChatId, input: string, requestedVariant: string | undefined, target: ModelLaunchTarget,
}): Promise<ChatModelLaunch | undefined> {
  const accepted = modelLaunchTargetSchema.parse(target);
  const session = sessionFor({ provider });
  const phase = session.get(chatId)?.phase;
  switch (phase) {
  case 'detached': return undefined;
  case undefined: case 'active': case 'reserved': break;
  default: { const exhaustive: never = phase; throw new Error(String(exhaustive)); }
  }
  const meta = await provider.loadChatMeta({ id: chatId });
  const content = await provider.loadChatContent({ id: chatId });
  if (meta === null || content === null || meta.groupId == null || meta.endpoint !== undefined || meta.modelId !== undefined) return undefined;
  const chatGroup = await provider.loadChatGroup({ id: meta.groupId });
  if (chatGroup === null || !matchesModel({ chatGroup, modelId: accepted.modelId })) return undefined;
  const prefix = await modelLaunchChatGroupPrefix({ modelId: accepted.modelId });
  const rawId = idToRaw({ id: chatGroup.id });
  if (rawId !== prefix && !rawId.startsWith(`${prefix}-`)) return undefined;
  const dto = await provider.loadHierarchy();
  if (dto === null || !containsChat({ hierarchy: hierarchyToDomain({ dto }), chatId, chatGroupId: chatGroup.id })) return undefined;
  const launch: ChatModelLaunch = { version: 1, input, requestedVariant, target: accepted, chatGroupId: chatGroup.id, phase: 'active' };
  session.set(chatId, launch);
  return structuredClone(launch);
}

/** Network-free writes under the caller's metadata and content locks. */
export async function prepareModelLaunchChat({ provider, request }: { provider: IStorageProvider, request: ModelLaunchChatRequest }): Promise<Chat> {
  const { chatId, newChatGroupId, chatGroupName, input, requestedVariant, target: proposedTarget, titleGeneration, mode, expectedTarget, ...unhandled } = request;
  unhandled satisfies Record<PropertyKey, never>;
  const target = modelLaunchTargetSchema.parse(proposedTarget);
  const session = sessionFor({ provider });
  let launch = session.get(chatId);
  const existing = await provider.loadChatMeta({ id: chatId });
  const content = await provider.loadChatContent({ id: chatId });
  const rawHierarchy = await provider.loadHierarchy();
  const hierarchy = rawHierarchy === null ? { items: [] } : hierarchyToDomain({ dto: rawHierarchy });
  const initialPhase = launch?.phase;
  switch (initialPhase) {
  case 'detached': throw new Error('The model launch chat was removed');
  case undefined: case 'active': case 'reserved': break;
  default: { const exhaustive: never = initialPhase; throw new Error(String(exhaustive)); }
  }
  if (launch !== undefined && launch.input !== input) throw new Error('The model launch request changed');
  if (launch?.phase === 'active' && mode === 'create-or-resume') {
    if (!containsChat({ hierarchy, chatId, chatGroupId: launch.chatGroupId })) throw new Error('The model launch chat was moved or removed');
    const chat = await provider.loadChat({ id: chatId });
    if (chat === null) throw new Error('The model launch chat is missing');
    return chat;
  }
  if (launch === undefined && mode === 'create-or-resume' && existing !== null && content !== null) {
    // The previous page may have stopped after all writes but before replace().
    // Reuse that exact saved chat; do not create another or resurrect removals.
    const restored = await restoreModelLaunch({ provider, chatId, input, requestedVariant, target });
    if (restored !== undefined) {
      const chat = await provider.loadChat({ id: chatId });
      if (chat !== null) return chat;
    }
  }
  if (content !== null && content.root.items.length > 0) throw new Error('Cannot change a model launch with conversation content');
  if (existing?.endpoint !== undefined || existing?.modelId !== undefined) throw new Error('The chat settings were changed');
  let chatGroup: ChatGroup;
  let createChatGroup = false;
  switch (launch?.phase) {
  case 'reserved': {
    const reserved = await provider.loadChatGroup({ id: launch.chatGroupId });
    chatGroup = reserved ?? {
      id: launch.chatGroupId,
      name: chatGroupName,
      isCollapsed: false,
      items: [],
      updatedAt: Date.now(),
      endpoint: { type: 'llama_cpp_browser' },
      modelId: launch.target.modelId,
      titleGeneration: retargetTitleGenerationToSameScope({ source: titleGeneration, model: 'same_scope' }),
    };
    createChatGroup = reserved === null;
    break;
  }
  case undefined: case 'active': {
    switch (mode) {
    case 'create-or-resume':
      if (existing !== null || content !== null || containsChat({ hierarchy, chatId, chatGroupId: undefined })) throw new Error('The model launch chat ID is already in use');
      break;
    case 'retarget': {
      if (launch === undefined || existing === null || content === null || expectedTarget === undefined
        || JSON.stringify(launch.target) !== JSON.stringify(expectedTarget)
        || !containsChat({ hierarchy, chatId, chatGroupId: launch.chatGroupId })) throw new Error('The model launch changed before selecting a model');
      const previous = await provider.loadChatGroup({ id: launch.chatGroupId });
      if (previous === null || !matchesModel({ chatGroup: previous, modelId: expectedTarget.modelId })) throw new Error('The chat group settings changed');
      break;
    }
    default: { const exhaustive: never = mode; throw new Error(String(exhaustive)); }
    }
    // A namespaced existing ID, not a display name or added persistence field,
    // identifies automatically created chat groups. Manual groups are untouched.
    const prefix = await modelLaunchChatGroupPrefix({ modelId: target.modelId });
    const candidates = await provider.listChatGroups();
    const reusable = candidates.find(candidate => {
      const rawId = idToRaw({ id: candidate.id });
      return (rawId === prefix || rawId.startsWith(`${prefix}-`)) && matchesModel({ chatGroup: candidate, modelId: target.modelId });
    });
    const primaryId = toChatGroupId({ raw: prefix });
    const primary = reusable === undefined ? await provider.loadChatGroup({ id: primaryId }) : undefined;
    const id = primary == null ? primaryId : toChatGroupId({ raw: `${prefix}-${idToRaw({ id: newChatGroupId })}` });
    if (reusable === undefined && primary != null && await provider.loadChatGroup({ id }) !== null) throw new Error('The model chat group ID is already in use');
    chatGroup = reusable ?? {
      id,
      name: chatGroupName,
      isCollapsed: false,
      items: [],
      updatedAt: Date.now(),
      endpoint: { type: 'llama_cpp_browser' },
      modelId: target.modelId,
      titleGeneration: retargetTitleGenerationToSameScope({ source: titleGeneration, model: 'same_scope' }),
    };
    createChatGroup = reusable === undefined;
    launch = { version: 1, input, requestedVariant, target, chatGroupId: chatGroup.id, phase: 'reserved' };
    session.set(chatId, launch);
    break;
  }
  case 'detached': throw new Error('The model launch chat was removed');
  default: { const exhaustive: never = launch!.phase; throw new Error(String(exhaustive)); }
  }
  if (!matchesModel({ chatGroup, modelId: launch.target.modelId })) throw new Error('The reserved chat group settings changed');
  if (createChatGroup) await provider.saveChatGroup({ chatGroup });
  if (existing === null) {
    const now = Date.now();
    await provider.saveChatMeta({ meta: { id: chatId, title: null, createdAt: now, updatedAt: now, debugEnabled: false } });
  }
  if (content === null) await provider.saveChatContent({ id: chatId, content: { root: { items: [] }, currentLeafId: undefined } });
  for (const item of hierarchy.items) {
    switch (item.type) {
    case 'chat_group': item.chat_ids = item.chat_ids.filter(id => id !== chatId); break;
    case 'chat': break;
    default: { const exhaustive: never = item; throw new Error(String(exhaustive)); }
    }
  }
  hierarchy.items = hierarchy.items.filter(item => item.type !== 'chat' || item.id !== chatId);
  const destination = hierarchy.items.find(item => item.type === 'chat_group' && item.id === chatGroup.id);
  if (destination === undefined) hierarchy.items.unshift({ type: 'chat_group', id: chatGroup.id, chat_ids: [chatId] });
  else {
    switch (destination.type) {
    case 'chat_group': destination.chat_ids.unshift(chatId); break;
    case 'chat': throw new Error('Invalid chat group destination');
    default: { const exhaustive: never = destination; throw new Error(String(exhaustive)); }
    }
  }
  await provider.saveHierarchy({ hierarchy: hierarchyToDto({ domain: hierarchy }) });
  session.set(chatId, { ...launch, phase: 'active' });
  const chat = await provider.loadChat({ id: chatId });
  if (chat === null) throw new Error('The saved model launch chat could not be read');
  return chat;
}

/** A same-session repair is never permission to undo an explicit removal. */
export async function detachRemovedModelLaunchOwners({ provider, before: _before, after }: { provider: IStorageProvider, before: Hierarchy, after: Hierarchy }): Promise<void> {
  const session = sessions.get(provider);
  if (session === undefined) return;
  for (const [chatId, launch] of session) {
    if (!containsChat({ hierarchy: after, chatId, chatGroupId: launch.chatGroupId })) session.set(chatId, { ...launch, phase: 'detached' });
  }
}

export const TEST_ONLY = {
  resetSession: ({ provider }: { provider: IStorageProvider }) => {
    sessions.delete(provider);
  },
};
