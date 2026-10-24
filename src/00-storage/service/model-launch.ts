import { retargetTitleGenerationToSameScope } from '@/01-models/title-generation';
import { resolveChatModelBinding } from '@/01-models/chat-model-binding';
import type { IStorageProvider } from './interface';
import type { Chat, ChatContent, ChatGroup, ChatMeta, Hierarchy, SettingsTitleGeneration } from '@/01-models/types';
import { cloneDownloadDestination, type DownloadDestination } from '@/01-models/download';
import { idToRaw, toChatGroupId, type ChatId, type ChatGroupId } from '@/01-models/ids';
import { cloneChatModelLaunch, modelLaunchChatGroupPrefix, modelLaunchTargetSchema, type ModelLaunchTarget, type ChatModelLaunch } from '@/01-models/llama-cpp-browser-model-launch';
import { chatGroupToDto, chatMetaToDto, hierarchyToDomain, hierarchyToDto } from '@/00-storage/mapper/mappers';

export type ModelLaunchChatRequest = {
  chatId: ChatId,
  newChatGroupId: ChatGroupId,
  chatGroupName: string,
  input: string,
  requestedVariant: string | undefined,
  target: ModelLaunchTarget,
  destination: DownloadDestination,
  effectiveModelId: string,
  titleGeneration: SettingsTitleGeneration,
  mode: 'create' | 'resume' | 'retarget',
  expectedTarget: ModelLaunchTarget | undefined,
};

type WriteState = 'unattempted' | 'attempted' | 'confirmed';
type LaunchRecord = {
  launch: ChatModelLaunch,
  meta: ChatMeta,
  chatGroup: ChatGroup,
  metaState: WriteState,
  chatGroupState: WriteState,
  hierarchyState: WriteState,
  contentState: WriteState,
};
type OwnerState = { meta: ChatMeta | null, content: ChatContent | null, hierarchy: Hierarchy, chatGroup: ChatGroup | null };

function wasWriteAttempted({ state }: { state: WriteState }): boolean {
  switch (state) {
  case 'unattempted': return false;
  case 'attempted': case 'confirmed': return true;
  default: {
    const exhaustive: never = state;
    throw new Error(String(exhaustive));
  }
  }
}

function wasWriteConfirmed({ state }: { state: WriteState }): boolean {
  switch (state) {
  case 'unattempted': case 'attempted': return false;
  case 'confirmed': return true;
  default: {
    const exhaustive: never = state;
    throw new Error(String(exhaustive));
  }
  }
}

// Only an explicit Start creates authority. Ordinary reads and history cannot.
const sessions = new WeakMap<IStorageProvider, Map<ChatId, LaunchRecord>>();

function sessionFor({ provider }: { provider: IStorageProvider }): Map<ChatId, LaunchRecord> {
  let session = sessions.get(provider);
  if (session === undefined) {
    session = new Map();
    sessions.set(provider, session);
  }
  return session;
}

function sameBinding({ left, right }: { left: Pick<ChatMeta, 'endpoint' | 'modelId'>, right: Pick<ChatMeta, 'endpoint' | 'modelId'> }): boolean {
  return JSON.stringify(left.endpoint) === JSON.stringify(right.endpoint) && left.modelId === right.modelId;
}

export function observeModelLaunch({ provider, meta }: { provider: IStorageProvider, meta: ChatMeta }): void {
  const record = sessions.get(provider)?.get(meta.id);
  if (record === undefined) {
    return;
  }
  const { launch } = record;
  if (!sameBinding({ left: meta, right: record.meta })) {
    launch.phase = 'detached';
  }
  const membership = meta.groupId ?? undefined;
  switch (launch.phase) {
  case 'active':
    if (membership !== launch.chatGroupId) {
      launch.phase = 'detached';
    }
    break;
  case 'reserved':
    if (membership !== undefined && membership !== launch.chatGroupId && membership !== launch.previousChatGroupId) {
      launch.phase = 'detached';
    }
    break;
  case 'detached': break;
  default: {
    const exhaustive: never = launch.phase;
    throw new Error(String(exhaustive));
  }
  }
}

export function forgetModelLaunches({ provider }: { provider: IStorageProvider }): void {
  sessions.delete(provider);
}

export function detachModelLaunchOwner({ provider, chatId }: { provider: IStorageProvider, chatId: ChatId }): void {
  const record = sessions.get(provider)?.get(chatId);
  if (record !== undefined) {
    record.launch.phase = 'detached';
  }
}

export function detachModelLaunchChatGroupOwners({ provider, chatGroupId }: { provider: IStorageProvider, chatGroupId: ChatGroupId }): void {
  for (const record of sessions.get(provider)?.values() ?? []) {
    if (record.launch.chatGroupId === chatGroupId || record.launch.previousChatGroupId === chatGroupId) {
      record.launch.phase = 'detached';
    }
  }
}

export function readModelLaunch({ provider, chatId }: { provider: IStorageProvider, chatId: ChatId }): ChatModelLaunch | undefined {
  const record = sessions.get(provider)?.get(chatId);
  return record === undefined ? undefined : cloneChatModelLaunch({ launch: record.launch });
}

function ownerLocations({ hierarchy, chatId }: { hierarchy: Hierarchy, chatId: ChatId }): (ChatGroupId | undefined)[] {
  return hierarchy.items.flatMap<ChatGroupId | undefined>(item => {
    switch (item.type) {
    case 'chat': return item.id === chatId ? [undefined] : [];
    case 'chat_group': return item.chat_ids.filter(id => id === chatId).map(() => item.id);
    default: {
      const exhaustive: never = item;
      throw new Error(String(exhaustive));
    }
    }
  });
}

function matchesModel({ chatGroup, modelId }: { chatGroup: ChatGroup, modelId: string }): boolean {
  return chatGroup.endpoint?.type === 'llama_cpp_browser' && chatGroup.modelId === modelId;
}

async function loadOwnerState({ provider, chatId, chatGroupId }: { provider: IStorageProvider, chatId: ChatId, chatGroupId: ChatGroupId }): Promise<OwnerState> {
  const meta = await provider.loadChatMeta({ id: chatId });
  const content = await provider.loadChatContent({ id: chatId });
  const rawHierarchy = await provider.loadHierarchy();
  const hierarchy = rawHierarchy === null ? { items: [] } : hierarchyToDomain({ dto: rawHierarchy });
  const chatGroup = await provider.loadChatGroup({ id: chatGroupId });
  return { meta, content, hierarchy, chatGroup };
}

function validateRecord({ record, state, chatId }: { record: LaunchRecord, state: OwnerState, chatId: ChatId }): boolean {
  const { launch } = record;
  const detach = () => {
    launch.phase = 'detached';
    return false;
  };
  const locations = ownerLocations({ hierarchy: state.hierarchy, chatId });
  switch (launch.phase) {
  case 'detached': return false;
  case 'active':
    return state.meta !== null && state.content !== null && state.chatGroup !== null
      && sameBinding({ left: state.meta, right: record.meta }) && sameBinding({ left: state.chatGroup, right: record.chatGroup })
      && locations.length === 1 && locations[0] === launch.chatGroupId ? true : detach();
  case 'reserved': break;
  default: {
    const exhaustive: never = launch.phase;
    throw new Error(String(exhaustive));
  }
  }
  if (state.meta === null) {
    if (wasWriteAttempted({ state: record.metaState })) {
      return detach();
    }
  } else {
    if (!wasWriteAttempted({ state: record.metaState }) || JSON.stringify(chatMetaToDto({ domain: state.meta })) !== JSON.stringify(chatMetaToDto({ domain: record.meta }))) {
      return detach();
    }
    record.metaState = 'confirmed';
  }
  if (state.chatGroup === null) {
    if (wasWriteAttempted({ state: record.chatGroupState })) {
      return detach();
    }
  } else {
    if (!wasWriteAttempted({ state: record.chatGroupState }) || JSON.stringify(chatGroupToDto({ domain: state.chatGroup })) !== JSON.stringify(chatGroupToDto({ domain: record.chatGroup }))) {
      return detach();
    }
    record.chatGroupState = 'confirmed';
  }
  const inDestination = locations.length === 1 && locations[0] === launch.chatGroupId;
  switch (record.hierarchyState) {
  case 'unattempted':
    if (launch.previousChatGroupId === undefined ? locations.length !== 0 : locations.length !== 1 || locations[0] !== launch.previousChatGroupId) {
      return detach();
    }
    break;
  case 'attempted': case 'confirmed':
    if (!inDestination) {
      return detach();
    }
    record.hierarchyState = 'confirmed';
    break;
  default: {
    const exhaustive: never = record.hierarchyState;
    throw new Error(String(exhaustive));
  }
  }
  if (state.content === null) {
    if (wasWriteAttempted({ state: record.contentState })) {
      return detach();
    }
  } else {
    if (!wasWriteAttempted({ state: record.contentState }) || state.content.root.items.length !== 0 || state.content.currentLeafId !== undefined) {
      return detach();
    }
    record.contentState = 'confirmed';
  }
  return true;
}

/** Network-free writes under the caller's metadata, settings, and content locks. */
export async function prepareModelLaunchChat({ provider, request, beforeWrite }: { provider: IStorageProvider, request: ModelLaunchChatRequest, beforeWrite?: () => void }): Promise<Chat> {
  const { chatId, newChatGroupId, chatGroupName, input, requestedVariant, target: proposedTarget, destination, effectiveModelId, titleGeneration, mode, expectedTarget, ...unhandled } = request;
  unhandled satisfies Record<PropertyKey, never>;
  const target = modelLaunchTargetSchema.parse(proposedTarget);
  const acceptedDestination = cloneDownloadDestination({ destination });
  const acceptedTitleGeneration = retargetTitleGenerationToSameScope({ source: titleGeneration, model: 'same_scope' });
  let record = sessions.get(provider)?.get(chatId);
  let state: OwnerState;
  if (record !== undefined) {
    state = await loadOwnerState({ provider, chatId, chatGroupId: record.launch.chatGroupId });
    beforeWrite?.();
    if (sessions.get(provider)?.get(chatId) !== record || (mode !== 'retarget' && record.launch.input !== input) || !validateRecord({ record, state, chatId })) {
      throw new Error('The model launch chat was moved, removed, or changed');
    }
  } else {
    const meta = await provider.loadChatMeta({ id: chatId });
    const content = await provider.loadChatContent({ id: chatId });
    const rawHierarchy = await provider.loadHierarchy();
    state = { meta, content, hierarchy: rawHierarchy === null ? { items: [] } : hierarchyToDomain({ dto: rawHierarchy }), chatGroup: null };
  }
  switch (mode) {
  case 'resume':
    if (record === undefined) {
      throw new Error('A current page model launch receipt is required');
    }
    break;
  case 'create':
    if (record === undefined && (state.meta !== null || state.content !== null || ownerLocations({ hierarchy: state.hierarchy, chatId }).length !== 0)) {
      throw new Error('The model launch chat ID is already in use');
    }
    break;
  case 'retarget':
    if (record === undefined || record.launch.phase !== 'active' || expectedTarget === undefined
      || JSON.stringify(record.launch.target) !== JSON.stringify(expectedTarget)
      || state.meta === null || state.meta.endpoint !== undefined || state.meta.modelId !== undefined
      || state.content === null || state.content.root.items.length !== 0 || state.content.currentLeafId !== undefined) {
      throw new Error('Cannot retarget a changed model launch or conversation');
    }
    break;
  default: {
    const exhaustive: never = mode;
    throw new Error(String(exhaustive));
  }
  }
  if (record !== undefined && mode !== 'retarget') {
    switch (record.launch.phase) {
    case 'active': {
      const chat = await provider.loadChat({ id: chatId });
      beforeWrite?.();
      if (chat === null || sessions.get(provider)?.get(chatId) !== record) {
        throw new Error('The model launch chat is missing');
      }
      return chat;
    }
    case 'reserved': break;
    case 'detached': throw new Error('The model launch chat was removed');
    default: {
      const exhaustive: never = record.launch.phase;
      throw new Error(String(exhaustive));
    }
    }
  }
  if (record === undefined || mode === 'retarget') {
    let chatGroupIdentity: string;
    switch (acceptedDestination.kind) {
    case 'host': chatGroupIdentity = JSON.stringify({ directoryId: acceptedDestination.directoryId, modelId: effectiveModelId });
      break;
    case 'opfs': chatGroupIdentity = effectiveModelId;
      break;
    default: {
      const exhaustive: never = acceptedDestination;
      throw new Error(String(exhaustive));
    }
    }
    const prefix = await modelLaunchChatGroupPrefix({ modelId: chatGroupIdentity });
    const candidates = await provider.listChatGroups();
    const reusable = candidates.find(candidate => {
      const rawId = idToRaw({ id: candidate.id });
      return (rawId === prefix || rawId.startsWith(`${prefix}-`)) && matchesModel({ chatGroup: candidate, modelId: effectiveModelId });
    });
    const primaryId = toChatGroupId({ raw: prefix });
    const primary = reusable === undefined ? await provider.loadChatGroup({ id: primaryId }) : undefined;
    const id = reusable?.id ?? (primary == null ? primaryId : toChatGroupId({ raw: `${prefix}-${idToRaw({ id: newChatGroupId })}` }));
    if (reusable === undefined && primary != null && await provider.loadChatGroup({ id }) !== null) {
      throw new Error('The model chat group ID is already in use');
    }
    beforeWrite?.();
    const now = Date.now();
    const previousChatGroupId = record?.launch.chatGroupId;
    const launch: ChatModelLaunch = { input, requestedVariant, target, destination: acceptedDestination, effectiveModelId, chatGroupId: id, previousChatGroupId, chatGroupName, titleGeneration: acceptedTitleGeneration, phase: 'reserved' };
    record = {
      launch,
      meta: state.meta ?? { id: chatId, title: null, createdAt: now, updatedAt: now, debugEnabled: false },
      chatGroup: reusable ?? { id, name: chatGroupName, isCollapsed: false, items: [], updatedAt: now, endpoint: { type: 'llama_cpp_browser' }, modelId: effectiveModelId, titleGeneration: acceptedTitleGeneration },
      metaState: state.meta === null ? 'unattempted' : 'confirmed',
      chatGroupState: reusable === undefined ? 'unattempted' : 'confirmed',
      hierarchyState: previousChatGroupId === id ? 'confirmed' : 'unattempted',
      contentState: state.content === null ? 'unattempted' : 'confirmed',
    };
    sessionFor({ provider }).set(chatId, record);
  }
  let started = false;
  const checkBeforeWrite = () => {
    if (!started) {
      beforeWrite?.();
      if (sessions.get(provider)?.get(chatId) !== record) {
        throw new Error('The page model launch operation expired');
      }
      started = true;
    }
  };
  if (!wasWriteConfirmed({ state: record.chatGroupState })) {
    checkBeforeWrite();
    record.chatGroupState = 'attempted';
    await provider.saveChatGroup({ chatGroup: record.chatGroup });
    record.chatGroupState = 'confirmed';
  }
  if (!wasWriteConfirmed({ state: record.metaState })) {
    checkBeforeWrite();
    record.metaState = 'attempted';
    await provider.saveChatMeta({ meta: record.meta });
    record.metaState = 'confirmed';
  }
  if (!wasWriteConfirmed({ state: record.hierarchyState })) {
    for (const item of state.hierarchy.items) {
      switch (item.type) {
      case 'chat_group': item.chat_ids = item.chat_ids.filter(id => id !== chatId);
        break;
      case 'chat': break;
      default: {
        const exhaustive: never = item;
        throw new Error(String(exhaustive));
      }
      }
    }
    state.hierarchy.items = state.hierarchy.items.filter(item => item.type !== 'chat' || item.id !== chatId);
    const destinationId = record.launch.chatGroupId;
    const destinationNode = state.hierarchy.items.find(item => item.type === 'chat_group' && item.id === destinationId);
    if (destinationNode === undefined) {
      state.hierarchy.items.unshift({ type: 'chat_group', id: record.launch.chatGroupId, chat_ids: [chatId] });
    } else {
      switch (destinationNode.type) {
      case 'chat_group': destinationNode.chat_ids.unshift(chatId);
        break;
      case 'chat': throw new Error('Invalid chat group destination');
      default: {
        const exhaustive: never = destinationNode;
        throw new Error(String(exhaustive));
      }
      }
    }
    checkBeforeWrite();
    record.hierarchyState = 'attempted';
    await provider.saveHierarchy({ hierarchy: hierarchyToDto({ domain: state.hierarchy }) });
    record.hierarchyState = 'confirmed';
  }
  // A readable new Chat must already inherit its model group.
  if (!wasWriteConfirmed({ state: record.contentState })) {
    checkBeforeWrite();
    record.contentState = 'attempted';
    await provider.saveChatContent({ id: chatId, content: { root: { items: [] }, currentLeafId: undefined } });
    record.contentState = 'confirmed';
  }
  state = await loadOwnerState({ provider, chatId, chatGroupId: record.launch.chatGroupId });
  if (sessions.get(provider)?.get(chatId) !== record || !validateRecord({ record, state, chatId })) {
    throw new Error('The saved model launch chat changed');
  }
  const chat = await provider.loadChat({ id: chatId });
  if (chat === null || sessions.get(provider)?.get(chatId) !== record) {
    throw new Error('The saved model launch chat could not be read');
  }
  record.launch.phase = 'active';
  record.launch.previousChatGroupId = undefined;
  return chat;
}

/** Explicit moves/removals revoke only receipts already owned by this page. */
export async function detachRemovedModelLaunchOwners({ provider, after }: { provider: IStorageProvider, after: Hierarchy }): Promise<void> {
  for (const [chatId, record] of sessions.get(provider) ?? []) {
    const locations = ownerLocations({ hierarchy: after, chatId });
    if (locations.length !== 1 || locations[0] !== record.launch.chatGroupId) {
      record.launch.phase = 'detached';
    }
  }
}

/** Only an actual owner binding change may advance this page's receipt. */
export async function promoteModelLaunchBinding({ provider, chatId, sourceModelId, modelId }: { provider: IStorageProvider, chatId: ChatId, sourceModelId: string, modelId: string }): Promise<void> {
  const record = sessions.get(provider)?.get(chatId);
  if (record === undefined || record.launch.phase !== 'active' || record.launch.effectiveModelId !== sourceModelId) {
    return;
  }
  const state = await loadOwnerState({ provider, chatId, chatGroupId: record.launch.chatGroupId });
  const settings = await provider.loadSettings();
  if (sessions.get(provider)?.get(chatId) !== record || record.launch.phase !== 'active' || record.launch.effectiveModelId !== sourceModelId) {
    return;
  }
  const locations = ownerLocations({ hierarchy: state.hierarchy, chatId });
  if (state.meta === null || state.content === null || state.chatGroup === null || settings === null
    || locations.length !== 1 || locations[0] !== record.launch.chatGroupId) {
    record.launch.phase = 'detached';
    return;
  }
  const pair = resolveChatModelBinding({ chat: state.meta, chatGroup: state.chatGroup, settings }).chat;
  if (pair.endpoint.type !== 'llama_cpp_browser' || pair.modelId !== modelId) {
    record.launch.phase = 'detached';
    return;
  }
  record.meta = state.meta;
  record.chatGroup = state.chatGroup;
  record.launch.effectiveModelId = modelId;
}

export const TEST_ONLY = {
  resetSession: ({ provider }: { provider: IStorageProvider }) => {
    sessions.delete(provider);
  },
};
