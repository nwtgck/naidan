import { isProxy, reactive, ref, toRaw, triggerRef, watch, type Ref } from 'vue';
import type { Chat, ChatContent, ChatGroup, ChatMeta, SidebarItem } from '@/models/types';
import { storageService } from '@/services/storage';
import { findDeepestLeaf, findNodeInBranch } from '@/utils/chat-tree';

export type ChatDataStore = {
  rootItems: Ref<SidebarItem[]>;
  currentChatRef: Ref<Chat | null>;
  currentChatGroupRef: Ref<ChatGroup | null>;
  liveChatRegistry: Map<string, Chat>;

  loadData(_args: Record<never, never>): Promise<void>;
  replaceSidebarItems({
    items,
  }: {
    items: SidebarItem[];
  }): void;

  registerLiveInstance({
    chat,
  }: {
    chat: Chat;
  }): void;

  unregisterLiveInstance({
    chatId,
  }: {
    chatId: string;
  }): void;

  getLiveChat({
    chat,
  }: {
    chat: Chat | Readonly<Chat>;
  }): Chat;

  openChat({
    id,
    leafId,
  }: {
    id: string;
    leafId: string | undefined;
  }): Promise<Chat | null>;

  openChatAtMessage({
    chatId,
    messageId,
  }: {
    chatId: string;
    messageId: string;
  }): Promise<Chat | null>;

  openChatGroup({
    id,
  }: {
    id: string | null;
  }): void;

  updateChatContent({
    id,
    updater,
  }: {
    id: string;
    updater: (current: ChatContent | null) => ChatContent | Promise<ChatContent>;
  }): Promise<void>;

  updateChatMeta({
    id,
    updater,
  }: {
    id: string;
    updater: (current: Chat | null) => Chat | Promise<Chat>;
  }): Promise<void>;
};

export function createChatDataStore({
  applyVolatileAssistantErrorsToChat,
  hasActiveGeneration,
  isTaskRunning,
  onExternalGenerationStarted,
  onExternalGenerationStopped,
  onExternalGenerationAbortRequest,
  onMigration,
}: {
  applyVolatileAssistantErrorsToChat: ({ chat }: { chat: Chat }) => void;
  hasActiveGeneration: ({ chatId }: { chatId: string }) => boolean;
  isTaskRunning: ({ chatId }: { chatId: string }) => boolean;
  onExternalGenerationStarted: ({ chatId }: { chatId: string }) => void;
  onExternalGenerationStopped: ({ chatId }: { chatId: string }) => void;
  onExternalGenerationAbortRequest: ({ chatId }: { chatId: string }) => void;
  onMigration: (_args: Record<never, never>) => void;
}): ChatDataStore {
  const rootItems = ref<SidebarItem[]>([]);
  const currentChatRef = ref<Chat | null>(null);
  const currentChatGroupRef = ref<ChatGroup | null>(null);
  const liveChatRegistry = reactive(new Map<string, Chat>());

  function registerLiveInstance({
    chat,
  }: {
    chat: Chat;
  }) {
    const raw = toRaw(chat);
    if (!raw || !raw.id) return;

    if (!liveChatRegistry.has(raw.id)) {
      liveChatRegistry.set(raw.id, isProxy(chat) ? chat : reactive(chat));
      return;
    }

    const existing = liveChatRegistry.get(raw.id)!;
    if (existing !== chat) {
      Object.assign(existing, raw);
    }
  }

  function unregisterLiveInstance({
    chatId,
  }: {
    chatId: string;
  }) {
    if (currentChatRef.value && toRaw(currentChatRef.value).id === chatId) return;
    if (!isTaskRunning({ chatId })) {
      liveChatRegistry.delete(chatId);
    }
  }

  watch(currentChatRef, (newChat, oldChat) => {
    if (oldChat) unregisterLiveInstance({ chatId: toRaw(oldChat).id });
    if (newChat) registerLiveInstance({ chat: newChat });
  });

  function syncLiveInstancesWithSidebar(_args: Record<never, never>) {
    const sync = ({
      items,
      parentGroupId,
    }: {
      items: SidebarItem[];
      parentGroupId: string | null;
    }) => {
      for (const item of items) {
        switch (item.type) {
        case 'chat': {
          const live = liveChatRegistry.get(item.chat.id);
          if (live) live.groupId = parentGroupId;
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

  function loadData(_args: Record<never, never>) {
    return storageService.getSidebarStructure().then((sidebarStructure) => {
      rootItems.value = sidebarStructure;
      syncLiveInstancesWithSidebar({});
    });
  }

  function replaceSidebarItems({
    items,
  }: {
    items: SidebarItem[];
  }) {
    rootItems.value = items;
    syncLiveInstancesWithSidebar({});
  }

  function debouncedSidebarReload(_args: Record<never, never>) {
    const now = Date.now();

    const performReload = async (_innerArgs: Record<never, never>) => {
      if (sidebarReloadTimeout) {
        clearTimeout(sidebarReloadTimeout);
        sidebarReloadTimeout = null;
      }

      await loadData({});
      lastSidebarReload = Date.now();
    };

    if (now - lastSidebarReload > THROTTLE_MS) {
      void performReload({});
      return;
    }

    if (!sidebarReloadTimeout) {
      const delay = THROTTLE_MS - (now - lastSidebarReload);
      sidebarReloadTimeout = setTimeout(() => {
        void performReload({});
      }, delay);
    }
  }

  function getLiveChat({
    chat,
  }: {
    chat: Chat | Readonly<Chat>;
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
    liveChatRegistry.set(chatId, live);
    return live;
  }

  async function updateChatContent({
    id,
    updater,
  }: {
    id: string;
    updater: (current: ChatContent | null) => ChatContent | Promise<ChatContent>;
  }) {
    const existing = liveChatRegistry.get(id);
    if (existing) {
      const updated = await updater({ root: existing.root, currentLeafId: existing.currentLeafId });
      existing.root = updated.root;
      existing.currentLeafId = updated.currentLeafId;
      if (currentChatRef.value && toRaw(currentChatRef.value).id === id) {
        triggerRef(currentChatRef);
      }
    }

    await storageService.updateChatContent(id, updater);
  }

  async function updateChatMeta({
    id,
    updater,
  }: {
    id: string;
    updater: (current: Chat | null) => Chat | Promise<Chat>;
  }) {
    const existing = liveChatRegistry.get(id);
    if (existing) {
      const updated = await updater(toRaw(existing));
      Object.assign(existing, updated);
      if (currentChatRef.value && toRaw(currentChatRef.value).id === id) {
        triggerRef(currentChatRef);
      }
    }

    await storageService.updateChatMeta(id, async (curr) => {
      const fullChat = curr ? await storageService.loadChat({ id }) : null;
      const updatedFull = await updater(fullChat);
      if (!updatedFull) return curr!;
      const { root: _r, endpointType, endpointUrl, endpointHttpHeaders, ...meta } = updatedFull;
      return {
        ...meta,
        ...(endpointType !== undefined && {
          endpoint: {
            type: endpointType,
            url: endpointUrl,
            httpHeaders: endpointHttpHeaders,
          },
        }),
      } as ChatMeta;
    });
  }

  async function openChat({
    id,
    leafId,
  }: {
    id: string;
    leafId: string | undefined;
  }) {
    if (liveChatRegistry.has(id)) {
      const chat = liveChatRegistry.get(id)!;
      if (leafId && leafId !== chat.currentLeafId) {
        const node = findNodeInBranch({ items: chat.root.items, targetId: leafId });
        if (node) {
          chat.currentLeafId = leafId;
          void storageService.updateChatContent(id, (curr) => ({ ...curr!, currentLeafId: leafId }));
        }
      }
      currentChatGroupRef.value = null;
      currentChatRef.value = chat;
      return chat;
    }

    const loaded = await storageService.loadChat({ id });
    if (loaded) {
      if (leafId && leafId !== loaded.currentLeafId) {
        const node = findNodeInBranch({ items: loaded.root.items, targetId: leafId });
        if (node) {
          loaded.currentLeafId = leafId;
          void storageService.updateChatContent(id, (curr) => ({ ...curr!, currentLeafId: leafId }));
        }
      }
      applyVolatileAssistantErrorsToChat({ chat: loaded });
      const reactiveChat = reactive(loaded);
      registerLiveInstance({ chat: reactiveChat });
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
  }: {
    chatId: string;
    messageId: string;
  }) {
    const chat = await openChat({ id: chatId, leafId: undefined });
    if (!chat) return null;

    const mutableChat = getLiveChat({ chat });
    const node = findNodeInBranch({ items: mutableChat.root.items, targetId: messageId });
    if (!node) return chat;

    mutableChat.currentLeafId = findDeepestLeaf({ node }).id;
    if (currentChatRef.value && toRaw(currentChatRef.value).id === mutableChat.id) {
      triggerRef(currentChatRef);
    }
    return chat;
  }

  function openChatGroup({
    id,
  }: {
    id: string | null;
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

  storageService.subscribeToChanges(async (event) => {
    switch (event.type) {
    case 'chat_meta_and_chat_group': {
      debouncedSidebarReload({});

      if (event.id && currentChatRef.value && toRaw(currentChatRef.value).id === event.id) {
        const fresh = await storageService.loadChat({ id: event.id });
        if (fresh && currentChatRef.value) {
          applyVolatileAssistantErrorsToChat({ chat: fresh });
          Object.assign(currentChatRef.value, fresh);
          triggerRef(currentChatRef);
        } else if (!hasActiveGeneration({ chatId: event.id })) {
          currentChatRef.value = null;
        }
      }

      if (event.id && currentChatGroupRef.value?.id === event.id) {
        const allGroups = await storageService.listChatGroups();
        currentChatGroupRef.value = allGroups.find((group) => group.id === event.id) || null;
      }
      break;
    }
    case 'chat_content_generation': {
      switch (event.status) {
      case 'started':
        if (!hasActiveGeneration({ chatId: event.id })) {
          onExternalGenerationStarted({ chatId: event.id });
        }
        break;
      case 'stopped':
        onExternalGenerationStopped({ chatId: event.id });
        break;
      case 'abort_request':
        onExternalGenerationAbortRequest({ chatId: event.id });
        break;
      default: {
        const _ex: never = event.status;
        throw new Error(`Unhandled status: ${_ex}`);
      }
      }
      break;
    }
    case 'chat_content': {
      if (event.id && currentChatRef.value && toRaw(currentChatRef.value).id === event.id) {
        if (!hasActiveGeneration({ chatId: event.id })) {
          const fresh = await storageService.loadChat({ id: event.id });
          if (fresh && currentChatRef.value) {
            applyVolatileAssistantErrorsToChat({ chat: fresh });
            currentChatRef.value.root = fresh.root;
            currentChatRef.value.currentLeafId = fresh.currentLeafId;
            triggerRef(currentChatRef);
          }
        }
      }
      break;
    }
    case 'migration': {
      onMigration({});
      liveChatRegistry.clear();
      currentChatRef.value = null;
      currentChatGroupRef.value = null;

      await loadData({});
      break;
    }
    case 'settings':
      break;
    default: {
      const _ex: never = event;
      throw new Error(`Unhandled event: ${_ex}`);
    }
    }
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
    openChat,
    openChatAtMessage,
    openChatGroup,
    updateChatContent,
    updateChatMeta,
  };
}
