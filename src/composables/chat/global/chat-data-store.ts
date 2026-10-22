import { isProxy, reactive, ref, toRaw, triggerRef, watch, type Ref } from 'vue';
import type { ChatGroupId, ChatId, MessageId } from '@/01-models/ids';
import type { ScopedSettingChange } from '@/01-models/scoped-setting-change';
import type { Chat, ChatContent, ChatGroup, ChatMeta, SidebarItem } from '@/01-models/types';
import { storageService, type ChatContentWrite } from '@/00-storage/service';
import { chatContentFingerprint } from '@/00-storage/service/chat-content-binding';
import { ChatContentBindingChangedError } from '@/00-storage/service/chat-content-binding';
import { findDeepestLeaf, findNodeInBranch } from '@/logic/chat-tree';
import { idToRaw, toChatId } from '@/01-models/ids';
import {
  applyScopedSettingChangesToChat,
  applyScopedSettingChangesToChatMeta,
  cloneScopedSettingChanges,
} from '@/logic/scoped-setting-changes';

export type ChatDataStore = {
  rootItems: Ref<SidebarItem[]>,
  currentChatRef: Ref<Chat | null>,
  currentChatGroupRef: Ref<ChatGroup | null>,
  liveChatRegistry: Map<ChatId, Chat>,

  loadData(): Promise<void>,
  replaceSidebarItems({
    items,
  }: {
    items: SidebarItem[],
  }): void,

  registerLiveInstance({
    chat,
  }: {
    chat: Chat,
  }): void,

  unregisterLiveInstance({
    chatId,
  }: {
    chatId: ChatId,
  }): void,

  getLiveChat({
    chat,
  }: {
    chat: Chat | Readonly<Chat>,
  }): Chat,

  getLiveChatById({
    chatId,
  }: {
    chatId: ChatId,
  }): Chat | null,

  getReadonlyChat({
    chatId,
  }: {
    chatId: ChatId,
  }): Readonly<Chat> | null,

  openChat({
    id,
    leafId,
    isCurrent,
  }: {
    id: ChatId,
    leafId: MessageId | undefined,
    isCurrent?: () => boolean,
  }): Promise<Chat | null>,

  openChatAtMessage({
    chatId,
    messageId,
    isCurrent,
  }: {
    chatId: ChatId,
    messageId: MessageId,
    isCurrent?: () => boolean,
  }): Promise<Chat | null>,

  openChatGroup({
    id,
  }: {
    id: ChatGroupId | null,
  }): void,

  updateChatContent({
    id,
    updater,
  }: {
    id: ChatId,

    updater: ({ current }: { current: ChatContent | null }) => ChatContent | Promise<ChatContent>,
    write: ChatContentWrite,
  }): Promise<ChatContent>,

  synchronizeModelBindingContent({ chatId }: { chatId: ChatId }): Promise<'synchronized' | 'changed'>,

  updateChatMeta({
    id,
    updater,
    creation,
    write,
  }: {
    id: ChatId,
    updater: ({ current }: { current: ChatMeta | null }) => ChatMeta,
    creation?: 'new-chat',
    write?: ChatContentWrite,
  }): Promise<void>,

  updateChatScopedSettings({
    chatId,
    changes,
  }: {
    chatId: ChatId,
    changes: readonly ScopedSettingChange[],
  }): Promise<void>,

  TEST_ONLY: {
    resetLiveState(): void,
  },
};

export function createChatDataStore({
  pruneVolatileAssistantErrorsForChat,
  hasActiveGeneration,
  isTaskRunning,
  onExternalGenerationStarted,
  onExternalGenerationStopped,
  onExternalGenerationAbortRequest,
  onMigration,
}: {
  pruneVolatileAssistantErrorsForChat: ({ chat }: { chat: Chat }) => void,
  hasActiveGeneration: ({ chatId }: { chatId: ChatId }) => boolean,
  isTaskRunning: ({ chatId }: { chatId: ChatId }) => boolean,
  onExternalGenerationStarted: ({ chatId }: { chatId: ChatId }) => void,
  onExternalGenerationStopped: ({ chatId }: { chatId: ChatId }) => void,
  onExternalGenerationAbortRequest: ({ chatId }: { chatId: ChatId }) => void,
  onMigration: () => void,
}): ChatDataStore {
  const rootItems = ref<SidebarItem[]>([]);
  const currentChatRef = ref<Chat | null>(null);
  const currentChatGroupRef = ref<ChatGroup | null>(null);
  const liveChatRegistry = reactive(new Map<ChatId, Chat>());
  const scopedSettingUpdateQueues = new Map<ChatId, Promise<void>>();
  const savedContentSnapshots = new Map<ChatId, string>();

  function contentSnapshot({ chat }: { chat: ChatContent }): string {
    return chatContentFingerprint({ content: chat });
  }

  function metadataWithoutContent({ chat }: { chat: ChatMeta & Partial<Pick<Chat, 'root'>> }) {
    const { root: _root, currentLeafId: _currentLeafId, ...metadata } = chat;
    return metadata;
  }

  function metadataSnapshot({ chat }: { chat: Chat }): string {
    return JSON.stringify(metadataWithoutContent({ chat }));
  }

  function registerLiveInstance({
    chat,
  }: {
    chat: Chat,
  }) {
    const raw = toRaw(chat);
    if (!raw || !raw.id) {
      return;
    }

    if (!liveChatRegistry.has(raw.id)) {
      savedContentSnapshots.delete(raw.id);
      liveChatRegistry.set(raw.id, isProxy(chat) ? chat : reactive(chat));
    }
  }

  function unregisterLiveInstance({
    chatId,
  }: {
    chatId: ChatId,
  }) {
    if (currentChatRef.value && toRaw(currentChatRef.value).id === chatId) {
      return;
    }
    const existing = liveChatRegistry.get(chatId);
    const hasUnsavedContent = existing !== undefined && contentSnapshot({ chat: existing }) !== savedContentSnapshots.get(chatId);
    if (!isTaskRunning({ chatId }) && !hasUnsavedContent) {
      liveChatRegistry.delete(chatId);
      savedContentSnapshots.delete(chatId);
    }
  }

  watch(currentChatRef, (newChat, oldChat) => {
    if (oldChat) {
      unregisterLiveInstance({ chatId: toRaw(oldChat).id });
    }
    if (newChat) {
      registerLiveInstance({ chat: newChat });
    }
  });

  function syncLiveInstancesWithSidebar() {
    const sync = ({
      items,
      parentGroupId,
    }: {
      items: SidebarItem[],
      parentGroupId: ChatGroupId | null,
    }) => {
      for (const item of items) {
        switch (item.type) {
        case 'chat': {
          const live = liveChatRegistry.get(item.chat.id);
          if (live) {
            live.groupId = parentGroupId;
          }
          if (currentChatRef.value && toRaw(currentChatRef.value).id === item.chat.id) {
            currentChatRef.value.groupId = parentGroupId;
          }
          break;
        }
        case 'chat_group':
          sync({ items: item.chatGroup.items, parentGroupId: item.chatGroup.id });
          break;
        default: {
          const _ex: never = item;
          return _ex;
        }
        }
      }
    };

    sync({ items: rootItems.value, parentGroupId: null });
  }

  let sidebarReloadTimeout: ReturnType<typeof setTimeout> | null = null;
  const THROTTLE_MS = 200;
  let lastSidebarReload = 0;

  type SidebarLoadState =
    | {
      kind: 'idle',
    }
    | {
      kind: 'loading',
      latestRequestedVersion: number,
      promise: Promise<void>,
    };

  let sidebarLoadState: SidebarLoadState = {
    kind: 'idle',
  };
  let nextSidebarLoadVersion = 0;

  function requireLoadingSidebarState({ state }: {
    state: SidebarLoadState,
  }): Extract<SidebarLoadState, { kind: 'loading' }> {
    switch (state.kind) {
    case 'idle':
      throw new Error('Sidebar load state became idle while loading.');
    case 'loading':
      return state;
    default: {
      const _ex: never = state;
      return _ex;
    }
    }
  }

  async function runSidebarLoad(): Promise<void> {
    try {
      while (true) {
        const state = requireLoadingSidebarState({
          state: sidebarLoadState,
        });
        const requestedVersion = state.latestRequestedVersion;
        const sidebarStructure = await storageService.getSidebarStructure();
        const currentState = requireLoadingSidebarState({
          state: sidebarLoadState,
        });

        if (currentState.latestRequestedVersion !== requestedVersion) {
          continue;
        }

        rootItems.value = sidebarStructure;
        syncLiveInstancesWithSidebar();
        sidebarLoadState = {
          kind: 'idle',
        };
        return;
      }
    } catch (error) {
      sidebarLoadState = {
        kind: 'idle',
      };
      throw error;
    }
  }

  function loadData(): Promise<void> {
    const requestedVersion = ++nextSidebarLoadVersion;
    const state = sidebarLoadState;
    switch (state.kind) {
    case 'idle': {
      const promise = Promise.resolve().then(runSidebarLoad);
      sidebarLoadState = {
        kind: 'loading',
        latestRequestedVersion: requestedVersion,
        promise,
      };
      return promise;
    }
    case 'loading':
      state.latestRequestedVersion = requestedVersion;
      return state.promise;
    default: {
      const _ex: never = state;
      return _ex;
    }
    }
  }

  function replaceSidebarItems({
    items,
  }: {
    items: SidebarItem[],
  }) {
    rootItems.value = items;
    syncLiveInstancesWithSidebar();
  }

  function debouncedSidebarReload() {
    const now = Date.now();

    const performReload = async () => {
      if (sidebarReloadTimeout) {
        clearTimeout(sidebarReloadTimeout);
        sidebarReloadTimeout = null;
      }

      await loadData();
      lastSidebarReload = Date.now();
    };

    if (now - lastSidebarReload > THROTTLE_MS) {
      void performReload();
      return;
    }

    if (!sidebarReloadTimeout) {
      const delay = THROTTLE_MS - (now - lastSidebarReload);
      sidebarReloadTimeout = setTimeout(() => {
        void performReload();
      }, delay);
    }
  }

  function getLiveChat({
    chat,
  }: {
    chat: Chat | Readonly<Chat>,
  }): Chat {
    const raw = toRaw(chat) as Chat;
    const chatId = raw.id;

    if (currentChatRef.value && toRaw(currentChatRef.value).id === chatId) {
      return currentChatRef.value;
    }

    const existing = liveChatRegistry.get(chatId);
    if (existing) {
      return existing;
    }

    const live = reactive(raw) as Chat;
    savedContentSnapshots.delete(chatId);
    liveChatRegistry.set(chatId, live);
    return live;
  }

  function getLiveChatById({
    chatId,
  }: {
    chatId: ChatId,
  }): Chat | null {
    if (currentChatRef.value && toRaw(currentChatRef.value).id === chatId) {
      return currentChatRef.value;
    }

    return liveChatRegistry.get(chatId) ?? null;
  }

  function getReadonlyChat({
    chatId,
  }: {
    chatId: ChatId,
  }): Readonly<Chat> | null {
    const liveChat = getLiveChatById({ chatId });
    return liveChat;
  }

  async function updateChatContent({
    id,
    updater,
    write,
  }: {
    id: ChatId,

    updater: ({ current }: { current: ChatContent | null }) => ChatContent | Promise<ChatContent>,
    write: ChatContentWrite,
  }) {
    const existing = liveChatRegistry.get(id);
    const before = existing === undefined ? undefined : contentSnapshot({ chat: existing });
    const persisted = await storageService.updateChatContent({
      id,
      write,
      updater,
    });
    if (existing !== undefined && liveChatRegistry.get(id) === existing) {
      const acceptedSnapshot = contentSnapshot({ chat: persisted });
      const liveSnapshot = contentSnapshot({ chat: existing });
      // Streaming nodes may still be referenced by the active generation. Keep
      // their identity when they already match, and retain edits made in flight.
      if (liveSnapshot === before && liveSnapshot !== acceptedSnapshot) {
        existing.root = persisted.root;
        existing.currentLeafId = persisted.currentLeafId;
      }
      savedContentSnapshots.set(id, acceptedSnapshot);
      if (currentChatRef.value && toRaw(currentChatRef.value).id === id) {
        triggerRef(currentChatRef);
      }
    }
    return persisted;
  }

  async function synchronizeModelBindingContent({ chatId }: { chatId: ChatId }): Promise<'synchronized' | 'changed'> {
    const existing = getLiveChatById({ chatId });
    const before = existing === null ? undefined : contentSnapshot({ chat: existing });
    const saved = savedContentSnapshots.get(chatId);
    const metadataBefore = existing === null ? undefined : metadataSnapshot({ chat: existing });
    if (existing !== null && saved !== undefined && before !== saved) {
      return 'changed';
    }
    const snapshot = await storageService.loadChatForModelBinding({ id: chatId });
    let fresh: Chat | null;
    switch (snapshot.status) {
    case 'loaded':
      if (!snapshot.isCurrent()) {
        return 'changed';
      }
      fresh = snapshot.chat;
      break;
    case 'changed': return 'changed';
    default: {
      const exhaustive: never = snapshot;
      throw new Error(String(exhaustive));
    }
    }
    if (fresh === null || getLiveChatById({ chatId }) !== existing || (existing !== null && (
      contentSnapshot({ chat: existing }) !== before || metadataSnapshot({ chat: existing }) !== metadataBefore ||
      (saved === undefined && contentSnapshot({ chat: fresh }) !== before)
    ))) {
      return 'changed';
    }
    if (existing !== null) {
      pruneVolatileAssistantErrorsForChat({ chat: fresh });
      Object.assign(existing, fresh);
      if (currentChatRef.value?.id === chatId) {
        triggerRef(currentChatRef);
      }
    } else {
      registerLiveInstance({ chat: fresh });
    }
    savedContentSnapshots.set(chatId, contentSnapshot({ chat: fresh }));
    return 'synchronized';
  }

  async function updateChatMeta({
    id,
    updater,
    creation,
    write,
  }: {
    id: ChatId,
    updater: ({ current }: { current: ChatMeta | null }) => ChatMeta,
    creation?: 'new-chat',
    write?: ChatContentWrite,
  }) {
    const existing = liveChatRegistry.get(id);
    const before = existing === undefined ? undefined : metadataSnapshot({ chat: existing });
    let acceptedChanges: Partial<ChatMeta> | undefined;
    await storageService.updateChatMeta({
      id,
      write,
      updater: ({ current }) => {
        switch (creation) {
        case 'new-chat':
          if (current !== null) {
            throw new Error('Chat already exists');
          }
          break;
        case undefined:
          if (current === null) {
            return undefined;
          }
          break;
        default: {
          const exhaustive: never = creation;
          throw new Error(String(exhaustive));
        }
        }
        const previousMetadata = current === null ? undefined : metadataWithoutContent({ chat: current });
        const previousFields = new Map(Object.entries(previousMetadata ?? {}).map(([field, value]) => [field, JSON.stringify(value)]));
        const updated: ChatMeta & Partial<Pick<Chat, 'root'>> = updater({ current });
        const { root: _root, ...metadata } = updated;
        const updatedMetadata = metadataWithoutContent({ chat: metadata });
        acceptedChanges = {};
        const fields = Object.keys({ ...previousMetadata, ...updatedMetadata }) as (keyof typeof updatedMetadata)[];
        for (const field of fields) {
          if (previousFields.get(field) !== JSON.stringify(updatedMetadata[field])) {
            acceptedChanges = { ...acceptedChanges, [field]: updatedMetadata[field] };
          }
        }
        return metadata;
      },
    });
    if (acceptedChanges !== undefined && existing !== undefined && liveChatRegistry.get(id) === existing && metadataSnapshot({ chat: existing }) === before) {
      Object.assign(existing, acceptedChanges);
      if (currentChatRef.value?.id === id) {
        triggerRef(currentChatRef);
      }
    }
  }

  async function updateChatScopedSettings({
    chatId,
    changes,
  }: {
    chatId: ChatId,
    changes: readonly ScopedSettingChange[],
  }): Promise<void> {
    if (changes.length === 0) {
      return;
    }

    const queuedChanges = cloneScopedSettingChanges({ changes });
    const previous = scopedSettingUpdateQueues.get(chatId) ?? Promise.resolve();
    const operation = previous
      .catch(() => undefined)
      .then(async () => {
        let persistedUpdatedAt: number | undefined;
        await storageService.updateChatMeta({
          id: chatId,
          updater: ({ current }) => {
            if (current === null) {
              throw new Error('Chat not found');
            }

            // Derive the timestamp from the latest persisted value inside the
            // storage lock. This prevents a queued or clock-skewed update from
            // moving updatedAt backwards.
            persistedUpdatedAt = Math.max(Date.now(), current.updatedAt + 1);
            return applyScopedSettingChangesToChatMeta({
              current,
              changes: queuedChanges,
              updatedAt: persistedUpdatedAt,
            });
          },
        });

        const existing = liveChatRegistry.get(chatId);
        if (existing === undefined) {
          return;
        }
        const current = toRaw(existing);
        const updated = applyScopedSettingChangesToChat({
          current,
          changes: queuedChanges,
          // Keep live state monotonic even if a custom storage adapter
          // short-circuits without invoking the updater.
          updatedAt: Math.max(
            persistedUpdatedAt ?? Date.now(),
            current.updatedAt + 1,
          ),
        });
        Object.assign(existing, updated);
        if (currentChatRef.value && toRaw(currentChatRef.value).id === chatId) {
          triggerRef(currentChatRef);
        }
      });

    const queueTail = operation.then(
      () => undefined,
      () => undefined,
    );
    scopedSettingUpdateQueues.set(chatId, queueTail);

    try {
      await operation;
    } finally {
      if (scopedSettingUpdateQueues.get(chatId) === queueTail) {
        scopedSettingUpdateQueues.delete(chatId);
      }
    }
  }

  async function openChat({
    id,
    leafId,
    isCurrent,
  }: {
    id: ChatId,
    leafId: MessageId | undefined,
    isCurrent?: () => boolean,
  }) {
    const assertCurrent = () => {
      if (isCurrent?.() === false) {
        throw new DOMException('Chat navigation superseded', 'AbortError');
      }
    };
    assertCurrent();
    if (liveChatRegistry.has(id)) {
      const chat = liveChatRegistry.get(id)!;
      if (leafId && leafId !== chat.currentLeafId) {
        const node = findNodeInBranch({ items: chat.root.items, targetId: leafId });
        if (node) {
          if (!savedContentSnapshots.has(id) && await synchronizeModelBindingContent({ chatId: id }) !== 'synchronized') {
            throw new ChatContentBindingChangedError();
          }
          if (contentSnapshot({ chat }) !== savedContentSnapshots.get(id)) {
            throw new ChatContentBindingChangedError();
          }
          await updateChatContent({ id, write: storageService.createChatContentWrite({ id, content: chat, binding: undefined }), updater: ({ current: curr }) => ({ ...curr!, currentLeafId: leafId }) });
        }
      }
      assertCurrent();
      currentChatGroupRef.value = null;
      currentChatRef.value = chat;
      return chat;
    }

    const loaded = await storageService.loadChat({ id });
    assertCurrent();
    if (liveChatRegistry.has(id)) {
      return openChat({ id, leafId, isCurrent });
    }
    if (loaded) {
      if (leafId && leafId !== loaded.currentLeafId) {
        const node = findNodeInBranch({ items: loaded.root.items, targetId: leafId });
        if (node) {
          const accepted = await updateChatContent({ id, write: storageService.createChatContentWrite({ id, content: loaded, binding: undefined }), updater: ({ current: curr }) => ({ ...curr!, currentLeafId: leafId }) });
          Object.assign(loaded, accepted);
        }
      }
      assertCurrent();
      if (liveChatRegistry.has(id)) {
        return openChat({ id, leafId, isCurrent });
      }
      pruneVolatileAssistantErrorsForChat({ chat: loaded });
      const reactiveChat = reactive(loaded);
      registerLiveInstance({ chat: reactiveChat });
      savedContentSnapshots.set(id, contentSnapshot({ chat: loaded }));
      currentChatGroupRef.value = null;
      currentChatRef.value = reactiveChat;
      return reactiveChat;
    }

    currentChatGroupRef.value = null;
    currentChatRef.value = null;
    return null;
  }

  async function openChatAtMessage({
    chatId,
    messageId,
    isCurrent,
  }: {
    chatId: ChatId,
    messageId: MessageId,
    isCurrent?: () => boolean,
  }) {
    const chat = await openChat({ id: chatId, leafId: undefined, isCurrent });
    if (isCurrent?.() === false) {
      throw new DOMException('Chat navigation superseded', 'AbortError');
    }
    if (!chat) {
      return null;
    }

    const mutableChat = getLiveChat({ chat });
    const node = findNodeInBranch({ items: mutableChat.root.items, targetId: messageId });
    if (!node) {
      return chat;
    }

    return openChat({ id: chatId, leafId: findDeepestLeaf({ node }).id, isCurrent });
  }

  function openChatGroup({
    id,
  }: {
    id: ChatGroupId | null,
  }) {
    if (id === null) {
      currentChatGroupRef.value = null;
      return;
    }

    const groups = rootItems.value.flatMap((item) => {
      switch (item.type) {
      case 'chat_group':
        return [item.chatGroup];
      case 'chat':
        return [];
      default: {
        const _ex: never = item;
        return _ex;
      }
      }
    });

    const group = groups.find((candidate) => candidate.id === id);
    if (group) {
      currentChatRef.value = null;
      currentChatGroupRef.value = group;
    }
  }

  storageService.subscribeToChanges({
    listener: async ({ event }) => {
      switch (event.type) {
      case 'chat_meta_and_chat_group': {
        debouncedSidebarReload();

        if (event.id && currentChatRef.value && idToRaw({ id: toRaw(currentChatRef.value).id }) === event.id) {
          const chatId = toChatId({ raw: event.id });
          const existing = currentChatRef.value;
          const before = metadataSnapshot({ chat: existing });
          const fresh = await storageService.loadChat({ id: chatId });
          if (currentChatRef.value !== existing || metadataSnapshot({ chat: existing }) !== before) {
            break;
          }
          if (fresh) {
            // Metadata hints cannot replace an accepted unsaved message tree.
            const { root: _root, currentLeafId: _currentLeafId, ...metadata } = fresh;
            Object.assign(currentChatRef.value, metadata);
            triggerRef(currentChatRef);
          } else if (!hasActiveGeneration({ chatId })) {
            currentChatRef.value = null;
          }
        }

        if (event.id && currentChatGroupRef.value && idToRaw({ id: currentChatGroupRef.value.id }) === event.id) {
          const allGroups = await storageService.listChatGroups();
          currentChatGroupRef.value = allGroups.find((group) => idToRaw({ id: group.id }) === event.id) || null;
        }
        break;
      }
      case 'chat_content_generation': {
        const chatId = toChatId({ raw: event.id });
        switch (event.status) {
        case 'started':
          if (!hasActiveGeneration({ chatId })) {
            onExternalGenerationStarted({ chatId });
          }
          break;
        case 'stopped':
          onExternalGenerationStopped({ chatId });
          break;
        case 'abort_request':
          onExternalGenerationAbortRequest({ chatId });
          break;
        default: {
          const _ex: never = event.status;
          throw new Error(`Unhandled status: ${_ex}`);
        }
        }
        break;
      }
      case 'chat_content': {
        if (event.id && currentChatRef.value && idToRaw({ id: toRaw(currentChatRef.value).id }) === event.id) {
          const chatId = toChatId({ raw: event.id });
          if (!hasActiveGeneration({ chatId })) {
            await synchronizeModelBindingContent({ chatId });
          }
        }
        break;
      }
      case 'migration': {
        onMigration();
        liveChatRegistry.clear();
        savedContentSnapshots.clear();
        currentChatRef.value = null;
        currentChatGroupRef.value = null;

        await loadData();
        break;
      }
      case 'binary_objects':
      case 'settings':
      case 'naidan_rpc_registry':
        break;
      default: {
        const _ex: never = event;
        throw new Error(`Unhandled event: ${_ex}`);
      }
      }
    },
  });

  return {
    rootItems,
    currentChatRef,
    currentChatGroupRef,
    liveChatRegistry,
    loadData,
    replaceSidebarItems,
    registerLiveInstance,
    unregisterLiveInstance,
    getLiveChat,
    getLiveChatById,
    getReadonlyChat,
    openChat,
    openChatAtMessage,
    openChatGroup,
    updateChatContent,
    synchronizeModelBindingContent,
    updateChatMeta,
    updateChatScopedSettings,
    ...((__BUILD_MODE_IS_TEST__ && {
      TEST_ONLY: {
        resetLiveState() {
          currentChatRef.value = null;
          currentChatGroupRef.value = null;
          liveChatRegistry.clear();
          savedContentSnapshots.clear();
          scopedSettingUpdateQueues.clear();
        },
      },
    }) || {}),
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
