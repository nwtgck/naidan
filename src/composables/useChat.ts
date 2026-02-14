import { generateId } from '../utils/id';
import { ref, computed, reactive, triggerRef, readonly, watch, toRaw, isProxy } from 'vue';
import type { Chat, MessageNode, ChatGroup, SidebarItem, ChatSummary, ChatMeta, ChatContent, Attachment, MultimodalContent, ChatMessage, EndpointType, Hierarchy, HierarchyNode, HierarchyChatGroupNode, SystemPrompt } from '../models/types';
import { storageService } from '../services/storage';
import { OpenAIProvider, OllamaProvider, type LLMProvider } from '../services/llm';
import { TransformersJsProvider } from '../services/transformers-js-provider';
import { transformersJsService } from '../services/transformers-js';
import { useSettings } from './useSettings';
import { useConfirm } from './useConfirm';
import { useGlobalEvents } from './useGlobalEvents';
import { useStoragePersistence } from './useStoragePersistence';
import { useImageGeneration } from './useImageGeneration';
import { fileToDataUrl, findDeepestLeaf, findNodeInBranch, findParentInBranch, getChatBranch, processThinking, createBranchFromMessages, type HistoryItem } from '../utils/chat-tree';
import { resolveChatSettings } from '../utils/chat-settings-resolver';
import { detectLanguage, getTitleSystemPrompt, cleanGeneratedTitle } from '../utils/title-generator';
import {
  SENTINEL_IMAGE_PENDING,
  isImageRequest,
  parseImageRequest,
  createImageRequestMarker,
  createImageResponseMarker,
  stripNaidanSentinels,
  type ImageRequestParams
} from '../utils/image-generation';

const rootItems = ref<SidebarItem[]>([]);
const _currentChat = ref<Chat | null>(null);
const _currentChatGroup = ref<ChatGroup | null>(null);

const liveChatRegistry = reactive(new Map<string, Chat>());
const activeGenerations = reactive(new Map<string, { controller: AbortController, chat: Chat }>)
const externalGenerations = reactive(new Set<string>());
const activeTaskCounts = reactive(new Map<string, number>());

const streaming = computed(() => activeGenerations.size > 0 || externalGenerations.size > 0);
const generatingTitle = computed(() => Array.from(activeTaskCounts.keys()).some(k => k.startsWith('title:')));
const fetchingModels = computed(() => Array.from(activeTaskCounts.keys()).some(k => k.startsWith('fetch:')));

const creatingChat = ref(false);
const availableModels = ref<string[]>([]);


// --- Lifecycle & Cleanup ---

if ((() => {
  const t = typeof window;
  switch (t) {
  case 'undefined': return false;
  case 'object':
  case 'boolean':
  case 'string':
  case 'number':
  case 'function':
  case 'symbol':
  case 'bigint':
    return true;
  default: {
    const _ex: never = t;
    return _ex;
  }
  }
})()) {
  window.addEventListener('beforeunload', () => {
    for (const item of activeGenerations.values()) {
      item.controller.abort();
    }
  });
}

// --- Registry Helpers ---

function incTask(chatId: string, type: 'title' | 'fetch' | 'process') {
  const key = `${type}:${chatId}`;
  activeTaskCounts.set(key, (activeTaskCounts.get(key) || 0) + 1);
}

function decTask(chatId: string, type: 'title' | 'fetch' | 'process') {
  const key = `${type}:${chatId}`;
  const val = (activeTaskCounts.get(key) || 0) - 1;
  if (val <= 0) activeTaskCounts.delete(key);
  else activeTaskCounts.set(key, val);
}

function isTaskRunning(chatId: string) {
  if (activeGenerations.has(chatId) || externalGenerations.has(chatId)) return true;
  for (const [key, count] of activeTaskCounts.entries()) {
    if (count > 0 && key.endsWith(':' + chatId)) return true;
  }
  return false;
}

function isProcessing(chatId: string) {
  if (activeGenerations.has(chatId) || externalGenerations.has(chatId)) return true;
  return (activeTaskCounts.get('process:' + chatId) || 0) > 0;
}

function registerLiveInstance(chat: Chat) {
  const raw = toRaw(chat);
  if (!raw || !raw.id) return;

  if (!liveChatRegistry.has(raw.id)) {
    liveChatRegistry.set(raw.id, isProxy(chat) ? chat : reactive(chat));
  } else {
    const existing = liveChatRegistry.get(raw.id)!;
    if (existing !== chat) {
      Object.assign(existing, raw);
    }
  }
}

function unregisterLiveInstance(chatId: string) {
  if (_currentChat.value && toRaw(_currentChat.value).id === chatId) return;
  if (!isTaskRunning(chatId)) {
    liveChatRegistry.delete(chatId);
  }
}

watch(_currentChat, (newChat, oldChat) => {
  if (oldChat) unregisterLiveInstance(toRaw(oldChat).id);
  if (newChat) registerLiveInstance(newChat); // Already reactive or raw
});

transformersJsService.subscribeModelList(async () => {
  const { fetchAvailableModels, currentChat, resolvedSettings } = useChat();
  const type = resolvedSettings.value?.endpointType;
  if (type) {
    switch (type) {
    case 'transformers_js':
      await fetchAvailableModels(currentChat.value?.id);
      break;
    case 'openai':
    case 'ollama':
      break;
    default: {
      const _ex: never = type;
      throw new Error(`Unhandled endpoint type: ${_ex}`);
    }
    }
  }
});

// --- Synchronization ---
function syncLiveInstancesWithSidebar() {
  const sync = (items: SidebarItem[], parentGroupId: string | null) => {
    for (const item of items) {
      switch (item.type) {
      case 'chat': {
        const live = liveChatRegistry.get(item.chat.id);
        if (live) live.groupId = parentGroupId;
        if (_currentChat.value && toRaw(_currentChat.value).id === item.chat.id) {
          _currentChat.value.groupId = parentGroupId;
        }
        break;
      }
      case 'chat_group':
        sync(item.chatGroup.items, item.chatGroup.id);
        break;
      default: {
        const _ex: never = item;
        return _ex;
      }
      }
    }
  };
  sync(rootItems.value, null);
}

let sidebarReloadTimeout: ReturnType<typeof setTimeout> | null = null;
const THROTTLE_MS = 200;
let lastSidebarReload = 0;

const debouncedSidebarReload = () => {
  const now = Date.now();

  const performReload = async () => {
    if (sidebarReloadTimeout) {
      clearTimeout(sidebarReloadTimeout);
      sidebarReloadTimeout = null;
    }
    rootItems.value = await storageService.getSidebarStructure();
    syncLiveInstancesWithSidebar();
    lastSidebarReload = Date.now();
  };

  if (now - lastSidebarReload > THROTTLE_MS) {
    performReload();
  } else if (!sidebarReloadTimeout) {
    const delay = THROTTLE_MS - (now - lastSidebarReload);
    sidebarReloadTimeout = setTimeout(performReload, delay);
  }
};

storageService.subscribeToChanges(async (event) => {
  switch (event.type) {
  case 'chat_meta_and_chat_group': {
    debouncedSidebarReload();

    if (event.id && _currentChat.value && toRaw(_currentChat.value).id === event.id) {
      const fresh = await storageService.loadChat(event.id);
      if (fresh && _currentChat.value) {
        Object.assign(_currentChat.value, fresh);
        triggerRef(_currentChat);
      } else if (!activeGenerations.has(event.id)) {
        _currentChat.value = null;
      }
    }

    if (event.id && _currentChatGroup.value?.id === event.id) {
      const allGroups = await storageService.listChatGroups();
      _currentChatGroup.value = allGroups.find(g => g.id === event.id) || null;
    }
    break;
  }
  case 'chat_content_generation': {
    switch (event.status) {
    case 'started':
      if (!activeGenerations.has(event.id)) {
        externalGenerations.add(event.id);
      }
      break;
    case 'stopped':
      externalGenerations.delete(event.id);
      break;
    case 'abort_request': {
      const local = activeGenerations.get(event.id);
      if (local) {
        local.controller.abort();
      }
      break;
    }
    default: {
      const _ex: never = event.status;
      throw new Error(`Unhandled status: ${_ex}`);
    }
    }
    break;
  }
  case 'chat_content': {
    if (event.id && _currentChat.value && toRaw(_currentChat.value).id === event.id) {
      if (!activeGenerations.has(event.id)) {
        const fresh = await storageService.loadChat(event.id);
        if (fresh && _currentChat.value) {
          _currentChat.value.root = fresh.root;
          _currentChat.value.currentLeafId = fresh.currentLeafId;
          triggerRef(_currentChat);
        }
      }
    }
    break;
  }
  case 'migration': {
    for (const item of activeGenerations.values()) item.controller.abort();
    activeGenerations.clear();
    activeTaskCounts.clear();
    liveChatRegistry.clear();

    rootItems.value = await storageService.getSidebarStructure();
    if (_currentChat.value) {
      const fresh = await storageService.loadChat(toRaw(_currentChat.value).id);
      _currentChat.value = fresh ? reactive(fresh) : null;
    }
    if (_currentChatGroup.value) {
      const allGroups = await storageService.listChatGroups();
      _currentChatGroup.value = allGroups.find(g => g.id === _currentChatGroup.value?.id) || null;
    }
    break;
  }
  case 'settings':
    // Handled by components via useSettings
    break;
  default: {
    const _ex: never = event;
    throw new Error(`Unhandled event: ${_ex}`);
  }
  }
});

export interface AddToastOptions { message: string; actionLabel?: string; onAction?: () => void | Promise<void>; duration?: number; }

export function useChat() {
  const { settings } = useSettings();

  const currentChat = computed(() => _currentChat.value ? readonly(_currentChat.value) : null);
  const currentChatGroup = computed(() => _currentChatGroup.value ? readonly(_currentChatGroup.value) : null);
  const sidebarItems = computed(() => rootItems.value);

  const chats = computed(() => {
    const all: ChatSummary[] = [];
    const collect = (items: SidebarItem[]) => {
      items.forEach(item => {
        switch (item.type) {
        case 'chat':
          all.push(item.chat);
          break;
        case 'chat_group':
          collect(item.chatGroup.items);
          break;
        default: {
          const _ex: never = item;
          return _ex;
        }
        }
      });
    };
    collect(rootItems.value);
    return all;
  });

  const chatGroups = computed(() => {
    const all: ChatGroup[] = [];
    rootItems.value.forEach(item => {
      switch (item.type) {
      case 'chat_group':
        all.push(item.chatGroup);
        break;
      case 'chat':
        break;
      default: {
        const _ex: never = item;
        return _ex;
      }
      }
    });
    return all;
  });

  const resolvedSettings = computed(() => {
    if (!_currentChat.value) return null;
    return resolveChatSettings(toRaw(_currentChat.value), chatGroups.value, settings.value);
  });

  const inheritedSettings = computed(() => {
    if (!_currentChat.value) return null;
    const chat = toRaw(_currentChat.value);
    const virtualChat: Chat = { ...chat, modelId: undefined, endpointType: undefined, endpointUrl: undefined, endpointHttpHeaders: undefined, systemPrompt: undefined, lmParameters: undefined, };
    return resolveChatSettings(virtualChat, chatGroups.value, settings.value);
  });

  const activeMessages = computed(() => {
    if (!_currentChat.value) return [];
    return getChatBranch(_currentChat.value);
  });

  const getLiveChat = (chat: Chat | Readonly<Chat>): Chat => {
    const raw = toRaw(chat) as Chat;
    const chatId = raw.id;

    if (_currentChat.value && toRaw(_currentChat.value).id === chatId) {
      return _currentChat.value;
    }

    const existing = liveChatRegistry.get(chatId);
    if (existing) {
      return existing;
    }

    const live = reactive(raw) as Chat;
    liveChatRegistry.set(chatId, live);
    return live;
  };

  const loadData = async () => {
    rootItems.value = await storageService.getSidebarStructure();
  };

  const fetchAvailableModels = async (chatId?: string, customEndpoint?: { type: EndpointType, url: string, headers?: readonly (readonly [string, string])[] }) => {
    const mutableChat = chatId ? liveChatRegistry.get(chatId) : undefined;
    if (mutableChat) incTask(mutableChat.id, 'fetch');
    else if (!customEndpoint) activeTaskCounts.set('fetch:global', (activeTaskCounts.get('fetch:global') || 0) + 1);

    let type: EndpointType;
    let url: string;
    let headers: readonly (readonly [string, string])[] | undefined;

    if (customEndpoint) {
      type = customEndpoint.type; url = customEndpoint.url; headers = customEndpoint.headers;
    } else if (mutableChat) {
      const group = mutableChat.groupId ? chatGroups.value.find(g => g.id === mutableChat.groupId) : null;
      type = mutableChat.endpointType || group?.endpoint?.type || settings.value.endpointType;
      url = mutableChat.endpointUrl || group?.endpoint?.url || settings.value.endpointUrl || '';
      headers = mutableChat.endpointHttpHeaders || group?.endpoint?.httpHeaders || settings.value.endpointHttpHeaders;
    } else if (_currentChat.value) {
      const chat = toRaw(_currentChat.value);
      const group = chat.groupId ? chatGroups.value.find(g => g.id === chat.groupId) : null;
      type = chat.endpointType || group?.endpoint?.type || settings.value.endpointType;
      url = chat.endpointUrl || group?.endpoint?.url || settings.value.endpointUrl || '';
      headers = chat.endpointHttpHeaders || group?.endpoint?.httpHeaders || settings.value.endpointHttpHeaders;
    } else {
      type = settings.value.endpointType;
      url = settings.value.endpointUrl || '';
      headers = settings.value.endpointHttpHeaders;
    }

    if (!url && type !== 'transformers_js') {
      if (mutableChat) {
        decTask(mutableChat.id, 'fetch');
      } else if (!customEndpoint) {
        const val = (activeTaskCounts.get('fetch:global') || 0) - 1;
        if (val <= 0) activeTaskCounts.delete('fetch:global'); else activeTaskCounts.set('fetch:global', val);
      }
      return [];
    }

    try {
      const mutableHeaders = headers ? JSON.parse(JSON.stringify(headers)) : undefined;
      const provider = (() => {
        switch (type) {
        case 'ollama':
          return new OllamaProvider({ endpoint: url, headers: mutableHeaders });
        case 'openai':
          return new OpenAIProvider({ endpoint: url, headers: mutableHeaders });
        case 'transformers_js':
          return new TransformersJsProvider();
        default: {
          const _ex: never = type;
          throw new Error(`Unhandled endpoint type: ${_ex}`);
        }
        }
      })();

      const models = await provider.listModels({});
      const result = Array.isArray(models) ? models : [];
      if ((mutableChat && _currentChat.value && toRaw(_currentChat.value).id === mutableChat.id) || (!mutableChat && !chatId)) {
        availableModels.value = result;
      }

      // If we're fetching for a specific chat and it has a modelId override that's no longer available, clear it.
      if (mutableChat && mutableChat.modelId && !result.includes(mutableChat.modelId)) {
        mutableChat.modelId = '';
        mutableChat.updatedAt = Date.now();
        if (_currentChat.value && toRaw(_currentChat.value).id === mutableChat.id) triggerRef(_currentChat);
        // We don't call updateChatModel here to avoid "Chat not found" errors for unsaved chats.
        // The components or next storage sync will handle persistence.
      }

      return result;
    } catch (e) {
      const { addErrorEvent } = useGlobalEvents();
      addErrorEvent({ source: 'useChat:fetchAvailableModels', message: 'Failed to fetch models for resolution', details: e instanceof Error ? e : String(e), });
      return [];
    } finally {
      if (mutableChat) {
        decTask(mutableChat.id, 'fetch');
      } else if (!customEndpoint) {
        const val = (activeTaskCounts.get('fetch:global') || 0) - 1;
        if (val <= 0) activeTaskCounts.delete('fetch:global'); else activeTaskCounts.set('fetch:global', val);
      }
    }
  };

  const updateChatContent = async (id: string, updater: (current: ChatContent | null) => ChatContent | Promise<ChatContent>) => {
    const existing = liveChatRegistry.get(id);
    if (existing) {
      const updated = await updater({ root: existing.root, currentLeafId: existing.currentLeafId });
      existing.root = updated.root;
      existing.currentLeafId = updated.currentLeafId;
      if (_currentChat.value && toRaw(_currentChat.value).id === id) triggerRef(_currentChat);
    }
    await storageService.updateChatContent(id, updater);
  };

  const updateChatMeta = async (id: string, updater: (current: Chat | null) => Chat | Promise<Chat>) => {
    const existing = liveChatRegistry.get(id);
    if (existing) {
      const updated = await updater(toRaw(existing));
      Object.assign(existing, updated);
      if (_currentChat.value && toRaw(_currentChat.value).id === id) triggerRef(_currentChat);
    }
    await storageService.updateChatMeta(id, async (curr) => {
      const fullChat = curr ? await storageService.loadChat(id) : null;
      const updatedFull = await updater(fullChat);
      if (!updatedFull) return curr!;
      const { root: _r, ...meta } = updatedFull;
      return meta as ChatMeta;
    });
  };

  const createNewChat = async (options: {
    groupId: string | undefined;
    modelId: string | undefined;
    systemPrompt: SystemPrompt | undefined;
  }): Promise<Chat | null> => {
    const { groupId, modelId, systemPrompt } = options;
    if (creatingChat.value) return null;
    _currentChatGroup.value = null;
    creatingChat.value = true;
    const chatId = generateId();
    try {
      const chatObj: Chat = reactive({
        id: chatId, title: null, groupId: groupId ?? null, root: { items: [] },
        createdAt: Date.now(), updatedAt: Date.now(), debugEnabled: false,
        modelId: modelId ?? undefined,
        systemPrompt,
      });

      registerLiveInstance(chatObj);
      await updateChatContent(chatId, () => ({ root: chatObj.root, currentLeafId: chatObj.currentLeafId }));
      await updateChatMeta(chatId, () => chatObj);

      await storageService.updateHierarchy((curr) => {
        if (groupId) {
          const group = curr.items.find(i => i.type === 'chat_group' && i.id === groupId) as HierarchyChatGroupNode;
          if (group) {
            group.chat_ids.unshift(chatId); return curr;
          }
        }
        const firstChatIdx = curr.items.findIndex(i => i.type === 'chat');
        const insertIdx = firstChatIdx !== -1 ? firstChatIdx : curr.items.length;
        curr.items.splice(insertIdx, 0, { type: 'chat', id: chatId });
        return curr;
      });

      _currentChat.value = chatObj;
      await loadData();
      return chatObj;
    } finally {
      creatingChat.value = false;
    }
  };

  const openChat = async (id: string, leafId?: string): Promise<Chat | null> => {
    if (liveChatRegistry.has(id)) {
      const chat = liveChatRegistry.get(id)!;
      if (leafId && leafId !== chat.currentLeafId) {
        const node = findNodeInBranch(chat.root.items, leafId);
        if (node) {
          chat.currentLeafId = leafId;
          storageService.updateChatContent(id, (curr) => ({ ...curr!, currentLeafId: leafId }));
        }
      }
      _currentChatGroup.value = null;
      _currentChat.value = chat;
      return chat;
    }
    const loaded = await storageService.loadChat(id);
    if (loaded) {
      if (leafId && leafId !== loaded.currentLeafId) {
        const node = findNodeInBranch(loaded.root.items, leafId);
        if (node) {
          loaded.currentLeafId = leafId;
          storageService.updateChatContent(id, (curr) => ({ ...curr!, currentLeafId: leafId }));
        }
      }
      const reactiveChat = reactive(loaded);
      registerLiveInstance(reactiveChat);
      _currentChatGroup.value = null;
      _currentChat.value = reactiveChat;
      return reactiveChat;
    } else {
      _currentChatGroup.value = null;
      _currentChat.value = null;
      return null;
    }
  };

  const openChatGroup = (id: string | null) => {
    if (id === null) {
      _currentChatGroup.value = null; return;
    }
    const group = chatGroups.value.find(g => g.id === id);
    if (group) {
      _currentChat.value = null; // Clear chat when opening a group
      _currentChatGroup.value = group;
    }
  };

  const deleteChat = async (id: string, injectAddToast?: (toast: AddToastOptions) => string) => {
    const { useToast } = await import('./useToast');
    const { addToast: originalAddToast } = useToast();
    const addToast = injectAddToast || originalAddToast;
    const chatData = await storageService.loadChat(id);
    if (!chatData) return;

    await storageService.updateHierarchy((curr) => {
      curr.items = curr.items.filter(i => {
        switch (i.type) {
        case 'chat':
          if (i.id === id) return false;
          break;
        case 'chat_group':
          i.chat_ids = i.chat_ids.filter(cid => cid !== id);
          break;
        default: {
          const _ex: never = i;
          throw new Error(`Unhandled hierarchy node type: ${_ex}`);
        }
        }
        return true;
      });
      return curr;
    });

    if (_currentChat.value && toRaw(_currentChat.value).id === id) _currentChat.value = null;
    await loadData();

    const cleanup = async () => {
      if (activeGenerations.has(id)) {
        activeGenerations.get(id)?.controller.abort(); activeGenerations.delete(id);
      }
      activeTaskCounts.delete('title:' + id);
      activeTaskCounts.delete('fetch:' + id);
      activeTaskCounts.delete('process:' + id);
      liveChatRegistry.delete(id);
      await storageService.deleteChat(id);
    };

    const toastId = addToast({
      message: `Chat "${chatData.title || 'Untitled'}" deleted`,
      actionLabel: 'Undo',
      onAction: async () => {
        const originalGroupId = chatData.groupId;
        await storageService.updateHierarchy((curr) => {
          if (originalGroupId) {
            const group = curr.items.find(i => {
              switch (i.type) {
              case 'chat_group': return i.id === originalGroupId;
              case 'chat': return false;
              default: {
                const _ex: never = i;
                throw new Error(`Unhandled hierarchy node type: ${_ex}`);
              }
              }
            }) as HierarchyChatGroupNode;
            if (group) {
              group.chat_ids.push(chatData.id); return curr;
            }
          }
          curr.items.push({ type: 'chat', id: chatData.id });
          return curr;
        });
        await loadData();
        await openChat(chatData.id);
      },
      onClose: async (reason) => {
        switch (reason) {
        case 'action':
          return;
        case 'timeout':
        case 'dismiss':
          await cleanup();
          break;
        default: {
          const _ex: never = reason;
          throw new Error(`Unhandled close reason: ${_ex}`);
        }
        }
      }    });

    if (!toastId) {
      await cleanup();
    }
  };

  const deleteAllChats = async () => {
    for (const [, item] of activeGenerations.entries()) item.controller.abort();
    activeGenerations.clear();
    activeTaskCounts.clear();
    liveChatRegistry.clear();

    const all = await storageService.listChats();
    for (const c of all) await storageService.deleteChat(c.id);
    const allGroups = await storageService.listChatGroups();
    for (const g of allGroups) await storageService.deleteChatGroup(g.id);

    await storageService.updateHierarchy((curr) => {
      curr.items = []; return curr;
    });
    _currentChat.value = null;
    await loadData();
  };

  const renameChat = async (id: string, newTitle: string) => {
    const liveChat = liveChatRegistry.get(id) || (_currentChat.value && toRaw(_currentChat.value).id === id ? _currentChat.value : null);
    if (liveChat) {
      liveChat.title = newTitle;
      liveChat.updatedAt = Date.now();
      if (_currentChat.value && toRaw(_currentChat.value).id === id) triggerRef(_currentChat);
    }

    await updateChatMeta(id, (curr) => {
      if (!curr) throw new Error('Chat not found');
      return { ...curr, title: newTitle, updatedAt: Date.now() };
    });
    await loadData();
  };

  const updateChatModel = async (id: string, modelId: string) => {
    const liveChat = liveChatRegistry.get(id) || (_currentChat.value && toRaw(_currentChat.value).id === id ? _currentChat.value : null);
    if (liveChat) {
      liveChat.modelId = modelId;
      liveChat.updatedAt = Date.now();
      if (_currentChat.value && toRaw(_currentChat.value).id === id) triggerRef(_currentChat);
    }
    await updateChatMeta(id, (curr) => {
      if (!curr) throw new Error('Chat not found');
      return { ...curr, modelId, updatedAt: Date.now() };
    });
  };

  const updateChatGroupOverride = async (id: string, groupId: string | null) => {
    const liveChat = liveChatRegistry.get(id) || (_currentChat.value && toRaw(_currentChat.value).id === id ? _currentChat.value : null);
    if (liveChat) {
      liveChat.groupId = groupId;
      liveChat.updatedAt = Date.now();
      if (_currentChat.value && toRaw(_currentChat.value).id === id) triggerRef(_currentChat);
    }
    await updateChatMeta(id, (curr) => {
      if (!curr) throw new Error('Chat not found');
      return { ...curr, groupId, updatedAt: Date.now() };
    });
    await loadData();
  };

  const updateChatSettings = async (id: string, updates: Partial<Pick<Chat, 'endpointType' | 'endpointUrl' | 'endpointHttpHeaders' | 'systemPrompt' | 'lmParameters'>>) => {
    const liveChat = liveChatRegistry.get(id) || (_currentChat.value && toRaw(_currentChat.value).id === id ? _currentChat.value : null);
    if (liveChat) {
      Object.assign(liveChat, updates);
      liveChat.updatedAt = Date.now();
      if (_currentChat.value && toRaw(_currentChat.value).id === id) triggerRef(_currentChat);
    }
    await updateChatMeta(id, (curr) => {
      if (!curr) throw new Error('Chat not found');
      return { ...curr, ...updates, updatedAt: Date.now() };
    });
  };

  const {
    isImageMode,
    toggleImageMode,
    getResolution,
    updateResolution,
    getCount,
    updateCount,
    getPersistAs,
    updatePersistAs,
    setImageModel,
    getSelectedImageModel,
    getSortedImageModels,
    performBase64Generation: _performGeneration,
    handleImageGeneration: _handleImageGeneration,
    sendImageRequest: _sendImageRequest,
    imageModeMap,
    imageResolutionMap,
    imageCountMap,
    imagePersistAsMap,
    imageModelOverrideMap
  } = useImageGeneration();

  const handleImageGeneration = async ({ chatId, assistantId, prompt, width, height, count, persistAs, images, model, signal }: {
    chatId: string;
    assistantId: string;
    prompt: string;
    width: number;
    height: number;
    count: number;
    persistAs: ImageRequestParams['persistAs'] | undefined;
    images: { blob: Blob }[];
    model: string | undefined;
    signal: AbortSignal | undefined;
  }) => {
    const target = getLiveChat({ id: chatId } as Chat);
    if (!target) return;
    const resolved = resolveChatSettings(target, chatGroups.value, settings.value);

    await _handleImageGeneration({
      chatId,
      assistantId,
      prompt,
      width,
      height,
      count,
      persistAs,
      images,
      model,
      availableModels: availableModels.value,
      endpointUrl: resolved.endpointUrl,
      endpointHttpHeaders: resolved.endpointHttpHeaders ? [...resolved.endpointHttpHeaders] : undefined,
      storageType: settings.value.storageType,
      signal,
      getLiveChat: ({ chat }) => getLiveChat(chat),
      updateChatContent: ({ chatId, updater }) => updateChatContent(chatId, (curr) => {
        if (!curr) throw new Error('Chat content not found');
        return updater(curr);
      }),
      triggerChatRef: ({ chatId }) => {
        if (_currentChat.value && toRaw(_currentChat.value).id === chatId) triggerRef(_currentChat);
      },
      incTask: ({ chatId, type }) => incTask(chatId, type),
      decTask: ({ chatId, type }) => decTask(chatId, type)
    });
  };

  const generateResponse = async (chat: Chat | Readonly<Chat>, assistantId: string) => {
    const mutableChat = getLiveChat(chat);
    const assistantNode = findNodeInBranch(mutableChat.root.items, assistantId);
    if (!assistantNode) throw new Error('Assistant node not found');
    assistantNode.error = undefined;
    if (_currentChat.value && toRaw(_currentChat.value).id === mutableChat.id) triggerRef(_currentChat);

    const controller = new AbortController();
    activeGenerations.set(mutableChat.id, { controller, chat: mutableChat });
    storageService.notify({ type: 'chat_content_generation', id: mutableChat.id, status: 'started', timestamp: Date.now() });
    registerLiveInstance(mutableChat);

    const resolved = resolveChatSettings(mutableChat, chatGroups.value, settings.value);
    const type = resolved.endpointType;
    const url = resolved.endpointUrl;
    const resolvedModel = assistantNode.modelId || resolved.modelId;

    const parentNode = findParentInBranch(mutableChat.root.items, assistantId);
    const imageRequest = parentNode ? parseImageRequest(parentNode.content) : null;

    try {
      if (imageRequest) {
        const { width = 512, height = 512, model, count = 1, persistAs } = imageRequest;
        const prompt = stripNaidanSentinels(parentNode!.content).trim();

        const images: { blob: Blob }[] = [];
        if (parentNode?.attachments) {
          for (const att of parentNode.attachments) {
            if (att.mimeType.startsWith('image/')) {
              let blob: Blob | null = null;
              switch (att.status) {
              case 'memory':
                blob = att.blob || null;
                break;
              case 'persisted':
                blob = await storageService.getFile(att.binaryObjectId);
                break;
              case 'missing':
                blob = null;
                break;
              default: {
                const _ex: never = att;
                throw new Error(`Unhandled attachment status: ${_ex}`);
              }
              }
              if (blob) images.push({ blob });
            }
          }
        }

        await handleImageGeneration({ chatId: mutableChat.id, assistantId, prompt, width, height, count, persistAs, images, model, signal: controller.signal });
        return;
      }

      let provider: LLMProvider;
      switch (type) {
      case 'openai':
        provider = new OpenAIProvider({ endpoint: url, headers: resolved.endpointHttpHeaders });
        break;
      case 'ollama':
        provider = new OllamaProvider({ endpoint: url, headers: resolved.endpointHttpHeaders });
        break;
      case 'transformers_js':
        provider = new TransformersJsProvider();
        break;
      default: {
        const _ex: never = type;
        throw new Error(`Unsupported endpoint type: ${_ex}`);
      }
      }
      const finalMessages: ChatMessage[] = [];
      resolved.systemPromptMessages.forEach(content => finalMessages.push({ role: 'system', content }));

      const history = getChatBranch(mutableChat).filter(m => m.id !== assistantId);
      for (const m of history) {
        if (m.attachments && m.attachments.length > 0) {
          const content: MultimodalContent[] = [{ type: 'text', text: m.content }];
          for (const att of m.attachments) {
            let blob: Blob | null = null;
            switch (att.status) {
            case 'memory':
              blob = att.blob;
              break;
            case 'persisted':
              blob = await storageService.getFile(att.binaryObjectId);
              break;
            case 'missing':
              blob = null;
              break;
            default: {
              const _ex: never = att;
              throw new Error(`Unhandled attachment status: ${_ex}`);
            }
            }
            if (blob && att.mimeType.startsWith('image/')) {
              const b64 = await fileToDataUrl(blob);
              content.push({ type: 'image_url', image_url: { url: b64 } });
            }
          }
          finalMessages.push({ role: m.role, content });
        } else {
          finalMessages.push({ role: m.role, content: m.content });
        }
      }

      let lastSave = 0;
      let isSaving = false;
      await provider.chat({
        messages: finalMessages,
        model: resolvedModel,
        onChunk: async (chunk: string) => {
          assistantNode.content += chunk;
          if (_currentChat.value && toRaw(_currentChat.value).id === mutableChat.id) {
            triggerRef(_currentChat);
          }

          const now = Date.now();
          if (now - lastSave > 500 && !isSaving) {
            isSaving = true;
            try {
              await updateChatContent(mutableChat.id, (current) => ({ ...current, root: mutableChat.root, currentLeafId: mutableChat.currentLeafId }));
              lastSave = Date.now();
            } finally {
              isSaving = false;
            }
          }
        },
        parameters: resolved.lmParameters,
        signal: controller.signal
      });

      await updateChatContent(mutableChat.id, (current) => ({ ...current, root: mutableChat.root, currentLeafId: mutableChat.currentLeafId }));
      processThinking(assistantNode);
      mutableChat.updatedAt = Date.now();

      if (mutableChat.title === null && settings.value.autoTitleEnabled && (activeGenerations.has(mutableChat.id) || (_currentChat.value && toRaw(_currentChat.value).id === mutableChat.id))) {
        await generateChatTitle(mutableChat.id, controller.signal);
      }
    } catch (e) {
      // Close thinking tag if open
      const lastOpen = assistantNode.content.lastIndexOf('<think>');
      const lastClose = assistantNode.content.lastIndexOf('</think>');
      if (lastOpen > -1 && lastClose < lastOpen) {
        assistantNode.content += '</think>';
      }
      processThinking(assistantNode);

      if ((e as Error).name === 'AbortError') {
        assistantNode.content += '\n\n[Generation Aborted]';
        await updateChatContent(mutableChat.id, (current) => ({ ...current, root: mutableChat.root, currentLeafId: mutableChat.currentLeafId }));
      } else {
        assistantNode.error = (e as Error).message;
        await updateChatContent(mutableChat.id, (current) => ({ ...current, root: mutableChat.root, currentLeafId: mutableChat.currentLeafId }));
        if (_currentChat.value && toRaw(_currentChat.value).id !== mutableChat.id) {
          try {
            const { useToast } = await import('./useToast');
            const { addToast } = useToast();
            addToast({ message: `Generation failed in "${mutableChat.title || 'New Chat'}"`, actionLabel: 'View', onAction: async () => {
              await openChat(mutableChat.id);
            }, });
          } catch (toastErr) { /* ignore */ }
        }
      }
    } finally {
      if (activeGenerations.has(mutableChat.id)) {
        activeGenerations.delete(mutableChat.id);
        storageService.notify({ type: 'chat_content_generation', id: mutableChat.id, status: 'stopped', timestamp: Date.now() });

        // Update meta one last time in the background
        updateChatMeta(mutableChat.id, (curr) => {
          if (!curr) return mutableChat;
          return { ...curr, updatedAt: Date.now(), currentLeafId: mutableChat.currentLeafId };
        }).then(() => loadData()).catch(() => {});

        // Request storage persistence after the first assistant response
        const history = getChatBranch(mutableChat);
        const assistantMessages = history.filter(m => m.role === 'assistant');
        if (assistantMessages.length === 1) {
          const { requestPersistence } = useStoragePersistence();
          requestPersistence();
        }
      }
    }
  };

  const sendMessage = async (content: string, parentId?: string | null, attachments: Attachment[] = [], chatTarget?: Chat | Readonly<Chat>): Promise<boolean> => {
    const target = chatTarget || _currentChat.value;
    if (!target) return false;
    const rawTarget = toRaw(target);
    if (isProcessing(rawTarget.id)) return false;

    const chat = getLiveChat(target);
    incTask(chat.id, 'process');
    registerLiveInstance(chat);

    try {
      const { settings: globalSettings, setHeavyContentAlertDismissed, setOnboardingDraft, setIsOnboardingDismissed } = useSettings();
      const { showConfirm } = useConfirm();
      const resolved = resolveChatSettings(chat, chatGroups.value, settings.value);
      const type = resolved.endpointType;
      const url = resolved.endpointUrl;
      let resolvedModel = chat.modelId || resolved.modelId;

      if (url || type === 'transformers_js') {
        const models = await fetchAvailableModels(chat.id);
        if (models.length > 0) {
          const preferredModel = chat.modelId || resolved.modelId;
          if (preferredModel && models.includes(preferredModel)) resolvedModel = preferredModel;
          else if (preferredModel) resolvedModel = models[0] || '';
        }
      }

      if ((!url && type !== 'transformers_js') || !resolvedModel) {
        const models = await fetchAvailableModels(chat.id);
        setOnboardingDraft({ url, type, models, selectedModel: models[0] || '', });
        setIsOnboardingDismissed(false);
        return false;
      }

      const processedAttachments: Attachment[] = [];
      const canPersist = storageService.canPersistBinary;
      if (attachments.length > 0 && !canPersist && globalSettings.value.heavyContentAlertDismissed === false) {
        const confirmed = await showConfirm({
          title: 'Attachments cannot be saved',
          message: 'You are using Local Storage, which has a 5MB limit. Attachments will be available during this session but will NOT be saved to your history. Switch to OPFS storage in Settings to enable permanent saving.',
          confirmButtonText: 'Continue anyway', cancelButtonText: 'Cancel',
        });
        if (!confirmed) return false;
        setHeavyContentAlertDismissed(true);
      }

      for (const att of attachments) {
        switch (att.status) {
        case 'memory':
          if (canPersist) {
            try {
              await storageService.saveFile(att.blob, att.binaryObjectId, att.originalName);
              processedAttachments.push({ ...att, status: 'persisted' });
            } catch (e) {
              processedAttachments.push(att);
            }
          } else processedAttachments.push(att);
          break;
        case 'persisted':
        case 'missing':
          processedAttachments.push(att);
          break;
        default: {
          const _ex: never = att;
          throw new Error(`Unhandled attachment status: ${_ex}`);
        }
        }
      }

      let finalContent = content;
      const isImgMode = isImageMode({ chatId: chat.id });
      const imageModel = isImgMode ? getSelectedImageModel({ chatId: chat.id, availableModels: availableModels.value }) : undefined;
      const res = getResolution({ chatId: chat.id });
      const count = getCount({ chatId: chat.id });
      const persistAs = getPersistAs({ chatId: chat.id });

      if (isImgMode && !isImageRequest(content)) {
        if (!imageModel) {
          const { useGlobalEvents } = await import('../composables/useGlobalEvents');
          const { addErrorEvent } = useGlobalEvents();
          addErrorEvent({ source: 'useChat:sendMessage', message: 'No image generation model found (starting with x/z-image-turbo:).' });
          return false;
        }
        finalContent = createImageRequestMarker({ ...res, model: imageModel, count, persistAs }) + content;
      }

      const userMsg: MessageNode = { id: generateId(), role: 'user', content: finalContent, attachments: processedAttachments.length > 0 ? processedAttachments : undefined, timestamp: Date.now(), replies: { items: [] }, };

      const assistantContent = isImgMode
        ? createImageResponseMarker({ count }) + SENTINEL_IMAGE_PENDING
        : '';

      const assistantMsg: MessageNode = { id: generateId(), role: 'assistant', content: assistantContent, timestamp: Date.now(), modelId: imageModel || resolvedModel, replies: { items: [] }, };
      userMsg.replies.items.push(assistantMsg);

      if (!chat.root) chat.root = { items: [] };

      if (parentId === null) chat.root.items.push(userMsg);
      else {
        const pId = parentId || chat.currentLeafId;
        const parentNode = pId ? findNodeInBranch(chat.root.items, pId) : null;
        if (parentNode) parentNode.replies.items.push(userMsg);
        else chat.root.items.push(userMsg);
      }

      chat.currentLeafId = assistantMsg.id;
      if (_currentChat.value && toRaw(_currentChat.value).id === chat.id) triggerRef(_currentChat);
      await updateChatContent(chat.id, (current) => ({ ...current, root: chat.root, currentLeafId: chat.currentLeafId }));
      await updateChatMeta(chat.id, (curr) => {
        if (!curr) return chat;
        return { ...curr, updatedAt: Date.now(), currentLeafId: chat.currentLeafId };
      });
      generateResponse(chat, assistantMsg.id).catch(e => console.error('Background generation failed:', e));
      return true;
    } finally {
      decTask(chat.id, 'process');
    }
  };

  const regenerateMessage = async (failedMessageId: string) => {
    if (!_currentChat.value) return;
    const chatId = toRaw(_currentChat.value).id;
    if (isProcessing(chatId)) {
      abortChat(chatId);
      // Wait for the task to actually stop and decTask to be called
      while (isProcessing(chatId)) {
        await new Promise(r => setTimeout(r, 10));
      }
    }

    const chat = getLiveChat(_currentChat.value);
    incTask(chat.id, 'process');
    registerLiveInstance(chat);
    try {
      const failedNode = findNodeInBranch(chat.root.items, failedMessageId);
      if (!failedNode || failedNode.role !== 'assistant') return;
      const parent = findParentInBranch(chat.root.items, failedMessageId);
      if (!parent || parent.role !== 'user') return;
      const newAssistantMsg: MessageNode = { id: generateId(), role: 'assistant', content: '', timestamp: Date.now(), modelId: failedNode.modelId, replies: { items: [] }, };
      parent.replies.items.push(newAssistantMsg);
      chat.currentLeafId = newAssistantMsg.id;
      if (_currentChat.value && toRaw(_currentChat.value).id === chat.id) triggerRef(_currentChat);
      await updateChatContent(chat.id, (current) => ({ ...current, root: chat.root, currentLeafId: chat.currentLeafId }));
      await updateChatMeta(chat.id, (curr) => {
        if (!curr) return chat;
        return { ...curr, updatedAt: Date.now(), currentLeafId: chat.currentLeafId };
      });
      generateResponse(chat, newAssistantMsg.id).catch(e => console.error('Background generation failed:', e));
    } finally {
      decTask(chat.id, 'process');
    }
  };

  const generateChatTitle = async (chatId?: string, signal?: AbortSignal) => {
    const target = chatId ? liveChatRegistry.get(chatId) : _currentChat.value;
    if (!target) return;
    const mutableChat = getLiveChat(target);
    const taskId = mutableChat.id;
    const titleAtStart = mutableChat.title;
    incTask(taskId, 'title');
    registerLiveInstance(mutableChat);
    try {
      const resolved = resolveChatSettings(mutableChat, chatGroups.value, settings.value);
      if (!resolved.endpointUrl && resolved.endpointType !== 'transformers_js') {
        decTask(taskId, 'title'); return;
      }
      const history = getChatBranch(mutableChat);
      const content = stripNaidanSentinels(history[0]?.content || '');
      if (!content || typeof content !== 'string') {
        decTask(taskId, 'title'); return;
      }

      let generatedTitle = '';
      const endpointType = resolved.endpointType;
      let titleProvider: LLMProvider;
      switch (endpointType) {
      case 'openai':
        titleProvider = new OpenAIProvider({ endpoint: resolved.endpointUrl, headers: resolved.endpointHttpHeaders });
        break;
      case 'ollama':
        titleProvider = new OllamaProvider({ endpoint: resolved.endpointUrl, headers: resolved.endpointHttpHeaders });
        break;
      case 'transformers_js':
        titleProvider = new TransformersJsProvider();
        break;
      default: {
        const _ex: never = endpointType;
        throw new Error(`Unsupported endpoint type for title generation: ${_ex}`);
      }
      }
      const titleGenModel = settings.value.titleModelId || history[history.length - 1]?.modelId || resolved.modelId;
      if (!titleGenModel) return;

      const lang = detectLanguage({
        content,
        fallbackLanguage: (() => {
          const t = typeof navigator;
          switch (t) {
          case 'undefined': return 'en';
          case 'object':
          case 'boolean':
          case 'string':
          case 'number':
          case 'function':
          case 'symbol':
          case 'bigint':
            return navigator.language;
          default: {
            const _ex: never = t;
            return _ex;
          }
          }
        })()
      });
      const systemPrompt = getTitleSystemPrompt(lang);
      const promptMsgs: ChatMessage[] = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `Message content to summarize: "${content.slice(0, 1000)}"` },
      ];

      await titleProvider.chat({
        messages: promptMsgs,
        model: titleGenModel,
        onChunk: (chunk: string) => {
          generatedTitle += chunk;
        },
        signal
      });

      const finalTitle = cleanGeneratedTitle(generatedTitle);
      if (finalTitle) {
        // If the user manually renamed it while we were generating, don't overwrite.
        // We only apply the title if it hasn't changed since we started.
        if (mutableChat.title === titleAtStart) {
          await updateChatMeta(mutableChat.id, (curr) => {
            if (!curr) return mutableChat;
            return { ...curr, title: finalTitle, updatedAt: Date.now() };
          });
          await loadData();
          if (_currentChat.value && toRaw(_currentChat.value).id === mutableChat.id) triggerRef(_currentChat);
        }
      }
    } finally {
      decTask(taskId, 'title');
    }
  };

  const abortChat = (chatId?: string) => {
    const id = chatId || (_currentChat.value ? toRaw(_currentChat.value).id : null);
    if (id) {
      if (activeGenerations.has(id)) {
        activeGenerations.get(id)?.controller.abort();
        activeGenerations.delete(id);
        storageService.notify({ type: 'chat_content_generation', id, status: 'stopped', timestamp: Date.now() });
      } else if (externalGenerations.has(id)) {
        storageService.notify({ type: 'chat_content_generation', id, status: 'abort_request', timestamp: Date.now() });
      }
    }
  };

  const forkChat = async (messageId: string, chatId?: string): Promise<string | null> => {
    const target = chatId ? liveChatRegistry.get(chatId) : _currentChat.value;
    if (!target) return null;
    const mutableChat = getLiveChat(target);
    const path = getChatBranch(mutableChat);
    const idx = path.findIndex(m => m.id === messageId);
    if (idx === -1) return null;
    const forkPath = path.slice(0, idx + 1);
    const clonedNodes: MessageNode[] = forkPath.map(n => ({ id: n.id, role: n.role, content: n.content, attachments: n.attachments, timestamp: n.timestamp, thinking: n.thinking, error: n.error, modelId: n.modelId, replies: { items: [] }, }));
    for (let i = 0; i < clonedNodes.length - 1; i++) clonedNodes[i]!.replies.items.push(clonedNodes[i+1]!);
    const newChatId = generateId();
    try {
      const newChatObj: Chat = reactive({
        ...toRaw(mutableChat),
        id: newChatId, title: `Fork of ${mutableChat.title || 'New Chat'}`,
        root: { items: [clonedNodes[0]!] }, currentLeafId: clonedNodes[clonedNodes.length - 1]?.id,
        originChatId: mutableChat.id, originMessageId: messageId,
        createdAt: Date.now(), updatedAt: Date.now(),
        modelId: mutableChat.modelId,
      });
      registerLiveInstance(newChatObj);
      await updateChatContent(newChatId, () => ({ root: newChatObj.root, currentLeafId: newChatObj.currentLeafId }));
      await updateChatMeta(newChatId, () => newChatObj);
      await storageService.updateHierarchy((curr) => {
        const node: HierarchyNode = { type: 'chat', id: newChatId };
        const chatGroupId = mutableChat.groupId;
        if (chatGroupId) {
          const group = curr.items.find(i => i.type === 'chat_group' && i.id === chatGroupId) as HierarchyChatGroupNode;
          if (group) {
            group.chat_ids.unshift(newChatId); return curr;
          }
        }
        const firstChatIdx = curr.items.findIndex(i => i.type === 'chat');
        const insertIdx = firstChatIdx !== -1 ? firstChatIdx : curr.items.length;
        curr.items.splice(insertIdx, 0, node);
        return curr;
      });
      await loadData();
      await openChat(newChatObj.id);
      return newChatObj.id;
    } finally { /* No explicit unregister here */ }
  };

  const editMessage = async (messageId: string, newContent: string) => {
    if (!_currentChat.value) return;
    const chatId = toRaw(_currentChat.value).id;
    if (isProcessing(chatId)) {
      abortChat(chatId);
      // Wait for the task to actually stop and decTask to be called
      while (isProcessing(chatId)) {
        await new Promise(r => setTimeout(r, 10));
      }
    }

    const chat = getLiveChat(_currentChat.value);
    const node = findNodeInBranch(chat.root.items, messageId); if (!node) return;
    switch (node.role) {
    case 'assistant': {
      const correctedNode: MessageNode = { id: generateId(), role: 'assistant', content: newContent, attachments: node.attachments, timestamp: Date.now(), modelId: node.modelId, replies: { items: [] }, };
      const parent = findParentInBranch(chat.root.items, messageId);
      if (parent) parent.replies.items.push(correctedNode);
      else chat.root.items.push(correctedNode);
      chat.currentLeafId = correctedNode.id;
      await updateChatContent(chat.id, (current) => ({ ...current, root: chat.root, currentLeafId: chat.currentLeafId }));
      if (_currentChat.value && toRaw(_currentChat.value).id === chat.id) triggerRef(_currentChat);
      break;
    }
    case 'user':
    case 'system': {
      const parent = findParentInBranch(chat.root.items, messageId);
      await sendMessage(newContent, parent ? parent.id : null, node.attachments, chat);
      break;
    }
    default: {
      const _ex: never = node.role;
      throw new Error(`Unhandled role: ${_ex}`);
    }
    }
  };

  const switchVersion = async (messageId: string) => {
    if (!_currentChat.value) return;
    const chat = getLiveChat(_currentChat.value);
    const node = findNodeInBranch(chat.root.items, messageId);
    if (node) {
      chat.currentLeafId = findDeepestLeaf(node).id;
      if (_currentChat.value && toRaw(_currentChat.value).id === chat.id) triggerRef(_currentChat);
      await updateChatContent(chat.id, (current) => ({ ...current, root: chat.root, currentLeafId: chat.currentLeafId }));
    }
  };

  const getSiblings = (messageId: string, chatId?: string) => {
    const target = chatId ? liveChatRegistry.get(chatId) : _currentChat.value;
    if (!target) return [];
    const mutableChat = getLiveChat(target);
    const parent = findParentInBranch(mutableChat.root.items, messageId);
    return parent ? parent.replies.items : mutableChat.root.items;
  };

  const toggleDebug = async () => {
    if (!_currentChat.value) return;
    const chat = getLiveChat(_currentChat.value);
    const newVal = !chat.debugEnabled;
    chat.debugEnabled = newVal;
    if (_currentChat.value && toRaw(_currentChat.value).id === chat.id) triggerRef(_currentChat);
    await updateChatMeta(chat.id, (curr) => {
      if (!curr) throw new Error('Chat not found');
      return { ...curr, debugEnabled: newVal, updatedAt: Date.now() };
    });
  };

  const commitFullHistoryManipulation = async (chatId: string, messages: HistoryItem[], systemPrompt: SystemPrompt | undefined) => {
    const target = liveChatRegistry.get(chatId) || (_currentChat.value && toRaw(_currentChat.value).id === chatId ? _currentChat.value : null);
    if (!target) return;
    const chat = getLiveChat(target);

    // Update system prompt (can be undefined to reset to inheritance)
    chat.systemPrompt = systemPrompt;

    // Persist any new 'memory' attachments
    const canPersist = storageService.canPersistBinary;
    for (const msg of messages) {
      if (msg.attachments) {
        for (let i = 0; i < msg.attachments.length; i++) {
          const att = msg.attachments[i]!;
          const status = att.status;
          switch (status) {
          case 'memory':
            if (canPersist) {
              try {
                await storageService.saveFile(att.blob, att.binaryObjectId, att.originalName);
                msg.attachments[i] = { ...att, status: 'persisted' };
              } catch (e) {
                console.error('Failed to persist attachment during manipulation:', e);
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
    }

    const newNodes = createBranchFromMessages(messages);

    if (newNodes.length > 0) {
      if (!chat.root) chat.root = { items: [] };
      chat.root.items.push(newNodes[0]!);
      chat.currentLeafId = newNodes[newNodes.length - 1]!.id;
    }

    chat.updatedAt = Date.now();
    if (_currentChat.value && toRaw(_currentChat.value).id === chat.id) triggerRef(_currentChat);

    await updateChatContent(chat.id, (current) => ({ ...current, root: chat.root, currentLeafId: chat.currentLeafId }));
    await updateChatMeta(chat.id, (curr) => {
      if (!curr) return chat;
      return { ...curr, updatedAt: Date.now(), currentLeafId: chat.currentLeafId };
    });
  };

  const generateImage = async ({ prompt, model, width, height, images, chat, signal }: {
    prompt: string,
    model: string,
    width: number,
    height: number,
    images: { blob: Blob }[],
    chat: Chat,
    signal: AbortSignal | undefined
  }) => {
    const resolved = resolveChatSettings(chat, chatGroups.value, settings.value);
    return await _performGeneration({
      prompt,
      model,
      width,
      height,
      images,
      endpointUrl: resolved.endpointUrl,
      endpointHttpHeaders: resolved.endpointHttpHeaders ? [...resolved.endpointHttpHeaders] : undefined,
      signal
    });
  };

  const sendImageRequest = async ({ prompt, width, height, count, persistAs, attachments }: {
    prompt: string;
    width: number;
    height: number;
    count: number;
    persistAs: ImageRequestParams['persistAs'];
    attachments: Attachment[];
  }): Promise<boolean> => {
    const target = _currentChat.value;
    if (!target) return false;
    return await _sendImageRequest({
      prompt,
      width,
      height,
      count,
      persistAs,
      chatId: toRaw(target).id,
      attachments,
      availableModels: availableModels.value,
      sendMessage: ({ content, parentId, attachments: atts }) => sendMessage(content, parentId || null, atts)
    });
  };

  const createChatGroup = async (name: string, options?: Partial<Pick<ChatGroup, 'modelId' | 'systemPrompt' | 'lmParameters'>>) => {
    const id = generateId();
    const newGroup: ChatGroup = {
      id,
      name,
      updatedAt: Date.now(),
      isCollapsed: false,
      items: [],
      ...options
    };
    await storageService.updateChatGroup(id, () => newGroup);
    await storageService.updateHierarchy((curr) => {
      curr.items.unshift({ type: 'chat_group', id, chat_ids: [] }); return curr;
    });
    await loadData();
    return id;
  };

  const deleteChatGroup = async (id: string) => {
    const group = chatGroups.value.find(g => g.id === id);
    if (!group) return;
    const items = [...group.items];
    for (const item of items) {
      switch (item.type) {
      case 'chat':
        await deleteChat(item.chat.id, () => '');
        break;
      case 'chat_group':
        // Nested groups not supported in UI but handled for exhaustiveness
        break;
      default: {
        const _ex: never = item;
        throw new Error(`Unhandled sidebar item type: ${_ex}`);
      }
      }
    }
    if (_currentChatGroup.value?.id === id) _currentChatGroup.value = null;
    await storageService.deleteChatGroup(id);
    await storageService.updateHierarchy((curr) => {
      curr.items = curr.items.filter(i => {
        switch (i.type) {
        case 'chat_group':
          return i.id !== id;
        case 'chat':
          return true;
        default: {
          const _ex: never = i;
          throw new Error(`Unhandled hierarchy node type: ${_ex}`);
        }
        }
      });
      return curr;
    });
    await loadData();
  };

  const setChatGroupCollapsed = async ({ groupId, isCollapsed }: { groupId: string; isCollapsed: boolean }) => {
    // 1. Update the item in the sidebar list immediately
    const item = rootItems.value.find(i => i.type === 'chat_group' && i.chatGroup.id === groupId);
    if (item && item.type === 'chat_group') {
      item.chatGroup.isCollapsed = isCollapsed;
      triggerRef(rootItems);
    }

    // 2. Update the dedicated "current group" ref
    if (_currentChatGroup.value?.id === groupId) {
      _currentChatGroup.value.isCollapsed = isCollapsed;
    }

    // 3. Persist to storage
    await storageService.updateChatGroup(groupId, (chatGroup) => {
      if (!chatGroup) throw new Error('Chat group not found');
      chatGroup.isCollapsed = isCollapsed;
      return chatGroup;
    });
  };

  const duplicateChatGroup = async (groupId: string) => {
    const originalGroup = chatGroups.value.find(g => g.id === groupId);
    if (!originalGroup) return;

    const newId = generateId();
    const newName = `Copy of ${originalGroup.name}`;
    const newGroup: ChatGroup = {
      ...toRaw(originalGroup),
      id: newId,
      name: newName,
      items: [], // Do not duplicate chats
      updatedAt: Date.now(),
      isCollapsed: false,
    };

    await storageService.updateChatGroup(newId, () => newGroup);
    await storageService.updateHierarchy((curr) => {
      const originalIndex = curr.items.findIndex(i => i.type === 'chat_group' && i.id === groupId);
      const newNode: HierarchyNode = { type: 'chat_group', id: newId, chat_ids: [] };
      if (originalIndex !== -1) {
        curr.items.splice(originalIndex + 1, 0, newNode);
      } else {
        curr.items.unshift(newNode);
      }
      return curr;
    });
    await loadData();
    return newId;
  };

  const renameChatGroup = async (groupId: string, newName: string) => {
    if (_currentChatGroup.value?.id === groupId) {
      _currentChatGroup.value.name = newName; _currentChatGroup.value.updatedAt = Date.now();
    }
    await storageService.updateChatGroup(groupId, (chatGroup) => {
      if (!chatGroup) throw new Error('Chat group not found');
      chatGroup.name = newName; chatGroup.updatedAt = Date.now(); return chatGroup;
    });
    await loadData();
  };

  const updateChatGroupMetadata = async (id: string, updates: Partial<Pick<ChatGroup, 'name' | 'endpoint' | 'modelId' | 'systemPrompt' | 'lmParameters'>>) => {
    if (_currentChatGroup.value?.id === id) {
      Object.assign(_currentChatGroup.value, updates); _currentChatGroup.value.updatedAt = Date.now();
    }
    await storageService.updateChatGroup(id, (curr) => {
      if (!curr) throw new Error('Chat group not found');
      return { ...curr, ...updates, updatedAt: Date.now() };
    });
    await loadData();
  };

  const persistSidebarStructure = async (topLevelItems: SidebarItem[]) => {
    rootItems.value = topLevelItems;
    syncLiveInstancesWithSidebar();
    const newHierarchy: Hierarchy = {
      items: topLevelItems.map(item => {
        switch (item.type) {
        case 'chat':
          return { type: 'chat', id: item.chat.id };
        case 'chat_group':
          return { type: 'chat_group', id: item.chatGroup.id, chat_ids: item.chatGroup.items.map(i => i.id.replace('chat:', '')) };
        default: {
          const _ex: never = item;
          return _ex;
        }
        }
      })
    };
    await storageService.updateHierarchy(() => newHierarchy);
  };

  const moveChatToGroup = async (chatId: string, targetGroupId: string | null) => {
    await storageService.updateHierarchy((curr) => {
      const node: HierarchyNode = { type: 'chat', id: chatId };
      curr.items = curr.items.filter(i => {
        switch (i.type) {
        case 'chat':
          return i.id !== chatId;
        case 'chat_group':
          i.chat_ids = i.chat_ids.filter(id => id !== chatId);
          return true;
        default: {
          const _ex: never = i;
          return _ex || true;
        }
        }
      });
      if (targetGroupId) {
        const g = curr.items.find(i => i.type === 'chat_group' && i.id === targetGroupId) as HierarchyChatGroupNode;
        if (g) g.chat_ids.unshift(chatId);
        else {
          const firstChatIdx = curr.items.findIndex(i => i.type === 'chat');
          const insertIdx = firstChatIdx !== -1 ? firstChatIdx : curr.items.length;
          curr.items.splice(insertIdx, 0, node);
        }
      } else {
        const firstChatIdx = curr.items.findIndex(i => i.type === 'chat');
        const insertIdx = firstChatIdx !== -1 ? firstChatIdx : curr.items.length;
        curr.items.splice(insertIdx, 0, node);
      }
      return curr;
    });
    if (_currentChat.value && toRaw(_currentChat.value).id === chatId) {
      _currentChat.value.groupId = targetGroupId; triggerRef(_currentChat);
    }
    await loadData();
  };

  const __testOnlySetCurrentChat = (chat: Chat | null) => {
    _currentChat.value = chat;
    if (chat) registerLiveInstance(chat);
  };
  const __testOnlySetCurrentChatGroup = (group: ChatGroup | null) => {
    _currentChatGroup.value = group;
  };
  const clearLiveChatRegistry = () => {
    liveChatRegistry.clear();
  };

  const clearActiveTaskCounts = () => {
    activeTaskCounts.clear();
  };

  return {
    rootItems, chats, chatGroups, sidebarItems, currentChat, currentChatGroup, resolvedSettings, inheritedSettings, activeMessages, streaming, generatingTitle, availableModels, fetchingModels,
    imageModeMap, imageResolutionMap, imageCountMap, imagePersistAsMap, imageModelOverrideMap,
    isImageMode, toggleImageMode, getResolution, updateResolution, getCount, updateCount, getPersistAs, updatePersistAs, setImageModel, getSelectedImageModel, getSortedImageModels,
    loadChats: loadData, fetchAvailableModels, createNewChat, openChat, openChatGroup, deleteChat, deleteAllChats, renameChat, updateChatModel, updateChatGroupOverride, updateChatSettings, generateChatTitle, sendMessage, regenerateMessage, forkChat, editMessage, switchVersion, getSiblings, toggleDebug, commitFullHistoryManipulation, generateImage, generateResponse, handleImageGeneration, sendImageRequest, createChatGroup, deleteChatGroup, duplicateChatGroup, setChatGroupCollapsed, renameChatGroup, updateChatGroupMetadata, persistSidebarStructure, abortChat, updateChatMeta, updateChatContent, moveChatToGroup,
    registerLiveInstance, unregisterLiveInstance, getLiveChat, isTaskRunning, isProcessing,
    __testOnly: {
      liveChatRegistry,
      activeGenerations,
      activeTaskCounts,
      clearLiveChatRegistry,
      clearActiveTaskCounts,
      __testOnlySetCurrentChat,
      __testOnlySetCurrentChatGroup,
    }
  };
}
