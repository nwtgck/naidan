import { generateId } from '@/utils/id';
import { ref, computed, reactive, triggerRef, readonly, toRaw, type ComputedRef } from 'vue';
import type { Chat, MessageNode, UserMessageNode, AssistantMessageNode, SystemMessageNode, ChatGroup, SidebarItem, ChatSummary, EndpointType, Hierarchy, HierarchyNode, HierarchyChatGroupNode, SystemPrompt, LmParameters, Reasoning, Settings } from '@/models/types';
import { EMPTY_LM_PARAMETERS } from '@/models/types';
import { storageService } from '@/services/storage';
import { OpenAIProvider } from '@/services/lm/openai';
import { OllamaProvider } from '@/services/lm/ollama';
import { TransformersJsProvider } from '@/services/transformers-js/provider';
import { transformersJsService } from '@/services/transformers-js';
import { useSettings } from './useSettings';
import { useConfirm } from './useConfirm';
import { useGlobalEvents } from './useGlobalEvents';
import { useStoragePersistence } from './useStoragePersistence';
import { useImageGeneration } from './useImageGeneration';
import { findDeepestLeaf, findNodeInBranch, findParentInBranch, getChatBranchIterator, createBranchFromMessages, getAllMessages, type HistoryItem } from '@/utils/chat-tree';
import { resolveChatSettings } from '@/utils/chat-settings-resolver';

import { useChatTools } from './useChatTools';
import { useChatWeshPreferences } from './useChatWeshPreferences';
import { getEnabledTools } from '@/services/tools/factory';
import { useChatDisplayFlow } from './useChatDisplayFlow';
import { createChatDataStore } from './chat/chat-data-store';
import { createChatRuntimeStore } from './chat/chat-runtime-store';
import { createContextCompactRuntime } from './chat/context-compact-runtime';
import { createContextCompactService } from './chat/context-compact-service';
import { createChatGenerationService } from './chat/chat-generation-service';
import { createChatImageService } from './chat/chat-image-service';
import { createChatMetadataService } from './chat/chat-metadata-service';
import { createChatTitleService } from './chat/chat-title-service';
import { getOPFSTmpManager } from '@/services/opfs-tmp-manager';
import { shouldIncludeWritableTmpMount } from '@/services/wesh/mount-policy';
import {
  type ContextCompactProgress,
} from '@/services/context-compact';

const volatileAssistantErrors = reactive(new Map<string, Map<string, string>>());
const volatileToolOutputs = reactive(new Map<string, string>());
const chatTmpDirectories = reactive(new Map<string, {
  handle: FileSystemDirectoryHandle;
  mountPath: '/tmp';
}>());
const chatRuntimeStore = createChatRuntimeStore({});
const contextCompactRuntime = createContextCompactRuntime({});

const streaming = computed(() => chatRuntimeStore.activeGenerations.size > 0 || chatRuntimeStore.externalGenerations.size > 0);
const isGeneratingTitle = ({ chatId }: { chatId: string }) => chatRuntimeStore.isGeneratingTitle({ chatId });
const generatingTitle = computed(() => {
  if (!_currentChat.value) return false;
  return isGeneratingTitle({ chatId: toRaw(_currentChat.value).id });
});
const contextCompactProgress = computed<ContextCompactProgress>(() => {
  return getContextCompactProgress({ chatId: _currentChat.value ? toRaw(_currentChat.value).id : undefined });
});
const fetchingModels = computed(() => {
  if (chatRuntimeStore.getTaskCount({ key: { kind: 'fetch', chatId: undefined } }) > 0) return true;
  if (!_currentChat.value) return false;
  return chatRuntimeStore.getTaskCount({
    key: {
      kind: 'fetch',
      chatId: toRaw(_currentChat.value).id,
    },
  }) > 0;
});

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
    for (const item of chatRuntimeStore.activeGenerations.values()) {
      item.controller.abort();
    }
  });
}

function isTaskRunning({ chatId }: { chatId: string }) {
  return chatRuntimeStore.isTaskRunning({ chatId });
}

function isProcessing({ chatId }: { chatId: string }) {
  return chatRuntimeStore.isProcessing({ chatId });
}

function setContextCompactProgress({
  chatId,
  progress,
}: {
  chatId: string;
  progress: ContextCompactProgress;
}) {
  contextCompactRuntime.setProgress({ chatId, progress });
}

function getContextCompactProgress({
  chatId,
}: {
  chatId: string | undefined;
}): ContextCompactProgress {
  return contextCompactRuntime.getProgress({ chatId });
}

function setVolatileAssistantError({ chatId, messageId, error }: {
  chatId: string;
  messageId: string;
  error: string;
}) {
  const existing = volatileAssistantErrors.get(chatId);
  if (existing) {
    existing.set(messageId, error);
    return;
  }

  volatileAssistantErrors.set(chatId, new Map([[messageId, error]]));
}

function clearVolatileAssistantError({ chatId, messageId }: {
  chatId: string;
  messageId: string;
}) {
  const existing = volatileAssistantErrors.get(chatId);
  if (!existing) return;

  existing.delete(messageId);
  if (existing.size === 0) {
    volatileAssistantErrors.delete(chatId);
  }
}

function applyVolatileAssistantErrorsToChat({ chat }: { chat: Chat }) {
  const errors = volatileAssistantErrors.get(chat.id);
  if (!errors || errors.size === 0) return;

  for (const [messageId, error] of errors.entries()) {
    const node = findNodeInBranch({ items: chat.root.items, targetId: messageId });
    if (!node || node.role !== 'assistant') continue;
    node.error = error;
  }
}


async function ensureChatTmpDirectory({
  chatId,
}: {
  chatId: string;
}): Promise<{
  handle: FileSystemDirectoryHandle;
  mountPath: '/tmp';
}> {
  const existing = chatTmpDirectories.get(chatId);
  if (existing) {
    return existing;
  }

  const created = {
    handle: await getOPFSTmpManager().createTmpDirectory({ prefix: chatId }),
    mountPath: '/tmp' as const,
  };
  chatTmpDirectories.set(chatId, created);
  return created;
}

function getChatTmpDirectory({
  chatId,
}: {
  chatId: string;
}): {
  handle: FileSystemDirectoryHandle;
  mountPath: '/tmp';
} | undefined {
  return chatTmpDirectories.get(chatId);
}

const chatDataStore = createChatDataStore({
  applyVolatileAssistantErrorsToChat,
  hasActiveGeneration: ({ chatId }) => chatRuntimeStore.activeGenerations.has(chatId),
  isTaskRunning,
  onExternalGenerationStarted: ({ chatId }) => {
    chatRuntimeStore.setExternalGeneration({ chatId });
  },
  onExternalGenerationStopped: ({ chatId }) => {
    chatRuntimeStore.deleteExternalGeneration({ chatId });
  },
  onExternalGenerationAbortRequest: ({ chatId }) => {
    chatRuntimeStore.getActiveGeneration({ chatId })?.controller.abort();
  },
  onMigration: (_args) => {
    for (const item of chatRuntimeStore.activeGenerations.values()) item.controller.abort();
    chatRuntimeStore.clearActiveGenerations({});
    chatRuntimeStore.clearActiveTaskCounts({});
    chatTmpDirectories.clear();
  },
});
const rootItems = chatDataStore.rootItems;
const _currentChat = chatDataStore.currentChatRef;
const _currentChatGroup = chatDataStore.currentChatGroupRef;
const liveChatRegistry = chatDataStore.liveChatRegistry;
const registerLiveInstance = chatDataStore.registerLiveInstance;
const unregisterLiveInstance = chatDataStore.unregisterLiveInstance;
const getLiveChat = chatDataStore.getLiveChat;
const loadData = chatDataStore.loadData;
const updateChatContent = chatDataStore.updateChatContent;
const updateChatMeta = chatDataStore.updateChatMeta;

transformersJsService.subscribeModelList(async () => {
  const { fetchAvailableModels, currentChat, resolvedSettings } = useChat();
  const type = resolvedSettings.value?.endpointType;
  if (type) {
    switch (type) {
    case 'transformers_js':
      await fetchAvailableModels({ chatId: currentChat.value?.id, customEndpoint: undefined });
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

export interface AddToastOptions { message: string; actionLabel?: string; onAction?: () => void | Promise<void>; duration?: number; }

// Facade for broad existing callers. Prefer adding new state and feature logic to
// dedicated chat stores/services instead of growing this module further.
export function useChat() {
  const { settings } = useSettings();
  const { getNaidanSysfsMountSelection } = useChatWeshPreferences();

  const currentChat = computed(() => _currentChat.value ? readonly(_currentChat.value) : null);
  const currentChatGroup = computed(() => _currentChatGroup.value ? readonly(_currentChatGroup.value) : null);
  const sidebarItems = computed(() => rootItems.value);

  const chats = computed(() => {
    const all: ChatSummary[] = [];
    const collect = ({ items }: { items: SidebarItem[] }) => {
      items.forEach(item => {
        switch (item.type) {
        case 'chat':
          all.push(item.chat);
          break;
        case 'chat_group':
          collect({ items: item.chatGroup.items });
          break;
        default: {
          const _ex: never = item;
          return _ex;
        }
        }
      });
    };
    collect({ items: rootItems.value });
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
    return resolveChatSettings({ chat: toRaw(_currentChat.value), groups: chatGroups.value, globalSettings: settings.value });
  });

  const inheritedSettings = computed(() => {
    if (!_currentChat.value) return null;
    const chat = toRaw(_currentChat.value);
    const virtualChat: Chat = { ...chat, modelId: undefined, endpointType: undefined, endpointUrl: undefined, endpointHttpHeaders: undefined, systemPrompt: undefined, lmParameters: undefined, };
    return resolveChatSettings({ chat: virtualChat, groups: chatGroups.value, globalSettings: settings.value });
  });

  const activeMessages = computed(() => {
    if (!_currentChat.value) return [];
    return Array.from(getChatBranchIterator({ chat: _currentChat.value }));
  });

  const allMessages = computed(() => {
    if (!_currentChat.value) return [];
    return getAllMessages({ chat: _currentChat.value });
  });

  const fetchAvailableModels = async ({ chatId, customEndpoint }: { chatId?: string, customEndpoint?: { type: EndpointType, url: string, headers?: readonly (readonly [string, string])[] } }) => {
    const mutableChat = chatId ? liveChatRegistry.get(chatId) : undefined;
    if (mutableChat) {
      chatRuntimeStore.startTask({
        key: {
          kind: 'fetch',
          chatId: mutableChat.id,
        },
      });
    } else if (!customEndpoint) {
      chatRuntimeStore.startTask({
        key: {
          kind: 'fetch',
          chatId: undefined,
        },
      });
    }

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
        chatRuntimeStore.finishTask({
          key: {
            kind: 'fetch',
            chatId: mutableChat.id,
          },
        });
      } else if (!customEndpoint) {
        chatRuntimeStore.finishTask({
          key: {
            kind: 'fetch',
            chatId: undefined,
          },
        });
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
        chatRuntimeStore.finishTask({
          key: {
            kind: 'fetch',
            chatId: mutableChat.id,
          },
        });
      } else if (!customEndpoint) {
        chatRuntimeStore.finishTask({
          key: {
            kind: 'fetch',
            chatId: undefined,
          },
        });
      }
    }
  };

  const addMountToChat = async ({ chatId, mount }: { chatId: string; mount: import('@/models/types').Mount }) => {
    await storageService.addMountToChat({ chatId, mount });
    await ensureChatTmpDirectory({ chatId });
    const existing = liveChatRegistry.get(chatId);
    if (existing) {
      existing.mounts = [...(existing.mounts ?? []), mount];
      if (_currentChat.value && toRaw(_currentChat.value).id === chatId) triggerRef(_currentChat);
    }
  };

  const removeMountFromChat = async ({ chatId, volumeId }: { chatId: string; volumeId: string }) => {
    await storageService.removeMountFromChat({ chatId, volumeId });
    const existing = liveChatRegistry.get(chatId);
    if (existing) {
      existing.mounts = (existing.mounts ?? []).filter(m => !(m.type === 'volume' && m.volumeId === volumeId));
      if (_currentChat.value && toRaw(_currentChat.value).id === chatId) triggerRef(_currentChat);
    }
  };

  const updateChatMount = async ({ chatId, volumeId, readOnly }: { chatId: string; volumeId: string; readOnly: boolean }) => {
    await storageService.updateChatMount({ chatId, volumeId, readOnly });
    const existing = liveChatRegistry.get(chatId);
    if (existing) {
      existing.mounts = (existing.mounts ?? []).map(m =>
        m.type === 'volume' && m.volumeId === volumeId ? { ...m, readOnly } : m
      );
      if (_currentChat.value && toRaw(_currentChat.value).id === chatId) triggerRef(_currentChat);
    }
  };

  const addMountToChatGroup = async ({ groupId, mount }: { groupId: string; mount: import('@/models/types').Mount }) => {
    await storageService.addMountToChatGroup({ groupId, mount });
    if (_currentChatGroup.value?.id === groupId) {
      _currentChatGroup.value.mounts = [...(_currentChatGroup.value.mounts ?? []), mount];
    }
  };

  const removeMountFromChatGroup = async ({ groupId, volumeId }: { groupId: string; volumeId: string }) => {
    await storageService.removeMountFromChatGroup({ groupId, volumeId });
    if (_currentChatGroup.value?.id === groupId) {
      _currentChatGroup.value.mounts = (_currentChatGroup.value.mounts ?? []).filter(
        m => !(m.type === 'volume' && m.volumeId === volumeId)
      );
    }
  };

  const updateChatGroupMount = async ({ groupId, volumeId, mountPath, readOnly }: { groupId: string; volumeId: string; mountPath: string; readOnly: boolean }) => {
    await storageService.updateChatGroupMount({ groupId, volumeId, mountPath, readOnly });
    if (_currentChatGroup.value?.id === groupId) {
      _currentChatGroup.value.mounts = (_currentChatGroup.value.mounts ?? []).map(m =>
        m.type === 'volume' && m.volumeId === volumeId ? { ...m, mountPath, readOnly } : m
      );
    }
  };

  const createNewChat = async ({ groupId, modelId, systemPrompt }: {
    groupId: string | undefined;
    modelId: string | undefined;
    systemPrompt: SystemPrompt | undefined;
  }): Promise<Chat | null> => {
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

      registerLiveInstance({ chat: chatObj });
      await updateChatContent({ id: chatId, updater: () => ({ root: chatObj.root, currentLeafId: chatObj.currentLeafId }) });
      await updateChatMeta({ id: chatId, updater: () => chatObj });

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

      const { setCurrentChatId } = useChatTools();
      setCurrentChatId({ chatId: chatId });
      _currentChat.value = chatObj;
      await loadData({});
      return chatObj;
    } finally {
      creatingChat.value = false;
    }
  };

  function hasMountsForChat({ chat }: { chat: Pick<Chat, 'mounts' | 'groupId'> }): boolean {
    if (settings.value.mounts && settings.value.mounts.length > 0) return true;
    if (chat.mounts && chat.mounts.length > 0) return true;
    if (chat.groupId) {
      const group = chatGroups.value.find(g => g.id === chat.groupId);
      if (group?.mounts && group.mounts.length > 0) return true;
    }
    return false;
  }

  const openChat = async ({ id, leafId }: { id: string, leafId?: string }): Promise<Chat | null> => {
    const { setToolEnabled, setCurrentChatId } = useChatTools();
    setCurrentChatId({ chatId: id });
    const chat = await chatDataStore.openChat({
      id,
      leafId,
    });
    if (!chat) {
      setCurrentChatId({ chatId: null });
      return null;
    }

    if (hasMountsForChat({ chat })) {
      setToolEnabled({ name: 'shell_execute', enabled: true });
    }
    return chat;
  };

  const openChatAtMessage = async ({ chatId, messageId }: { chatId: string, messageId: string }): Promise<Chat | null> => {
    const { setToolEnabled, setCurrentChatId } = useChatTools();
    setCurrentChatId({ chatId });
    const chat = await chatDataStore.openChatAtMessage({ chatId, messageId });
    if (!chat) {
      setCurrentChatId({ chatId: null });
      return null;
    }
    if (hasMountsForChat({ chat })) {
      setToolEnabled({ name: 'shell_execute', enabled: true });
    }
    return chat;
  };

  const openChatGroup = ({ id }: { id: string | null }) => {
    chatDataStore.openChatGroup({ id });
  };

  const deleteChat = async ({ id, injectAddToast }: { id: string, injectAddToast?: (toast: AddToastOptions) => string }) => {
    const { useToast } = await import('./useToast');
    const { addToast: originalAddToast } = useToast();
    const addToast = injectAddToast || originalAddToast;
    const chatData = await storageService.loadChat({ id });
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
    await loadData({});

    const cleanup = async (_params: Record<string, never>) => {
      if (chatRuntimeStore.activeGenerations.has(id)) {
        chatRuntimeStore.getActiveGeneration({ chatId: id })?.controller.abort();
        chatRuntimeStore.deleteActiveGeneration({ chatId: id });
      }
      chatRuntimeStore.clearTasksForChat({ chatId: id });
      liveChatRegistry.delete(id);
      chatTmpDirectories.delete(id);
      await storageService.deleteChat({ id });
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
        await loadData({});
        await openChat({ id: chatData.id });
      },
      onClose: async (reason) => {
        switch (reason) {
        case 'action':
          return;
        case 'timeout':
        case 'dismiss':
          await cleanup({});
          break;
        default: {
          const _ex: never = reason;
          throw new Error(`Unhandled close reason: ${_ex}`);
        }
        }
      }    });

    if (!toastId) {
      await cleanup({});
    }
  };

  const deleteAllChats = async (_params: Record<string, never>) => {
    for (const [, item] of chatRuntimeStore.activeGenerations.entries()) item.controller.abort();
    chatRuntimeStore.clearActiveGenerations({});
    chatRuntimeStore.clearActiveTaskCounts({});
    liveChatRegistry.clear();
    chatTmpDirectories.clear();

    const all = await storageService.listChats();
    for (const c of all) await storageService.deleteChat({ id: c.id });
    const allGroups = await storageService.listChatGroups();
    for (const g of allGroups) await storageService.deleteChatGroup({ id: g.id });

    await storageService.updateHierarchy((curr) => {
      curr.items = []; return curr;
    });
    _currentChat.value = null;
    await loadData({});
  };

  const chatMetadataService = createChatMetadataService({
    getChatTarget: ({ id }) => {
      const liveChat = liveChatRegistry.get(id);
      if (liveChat) return liveChat;
      if (_currentChat.value && toRaw(_currentChat.value).id === id) {
        return _currentChat.value;
      }
      return null;
    },
    getCurrentChat: () => (_currentChat.value ? getLiveChat({ chat: _currentChat.value }) : null),
    triggerCurrentChat: ({ chatId }) => {
      if (_currentChat.value && toRaw(_currentChat.value).id === chatId) {
        triggerRef(_currentChat);
      }
    },
    updateChatMeta,
    loadData,
  });
  const renameChat = chatMetadataService.renameChat;
  const updateChatModel = chatMetadataService.updateChatModel;
  const updateChatGroupOverride = chatMetadataService.updateChatGroupOverride;
  const updateChatSettings = chatMetadataService.updateChatSettings;

  const {
    isImageMode,
    toggleImageMode,
    getResolution,
    updateResolution,
    getCount,
    updateCount,
    getSteps,
    updateSteps,
    getSeed,
    updateSeed,
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
    imageProgressMap,
    imageModelOverrideMap
  } = useImageGeneration();

  const chatImageService = createChatImageService({
    getCurrentChat: () => (_currentChat.value ? getLiveChat({ chat: _currentChat.value }) : null),
    getLiveChat: ({ chat }) => getLiveChat({ chat }),
    getAvailableModels: () => availableModels.value,
    getStorageType: () => settings.value.storageType,
    resolveSettings: ({ chat }) => {
      const resolved = resolveChatSettings({ chat, groups: chatGroups.value, globalSettings: settings.value });
      return {
        endpointUrl: resolved.endpointUrl,
        endpointHttpHeaders: resolved.endpointHttpHeaders ? [...resolved.endpointHttpHeaders] : undefined,
      };
    },
    performGeneration: _performGeneration,
    handleImageGenerationImpl: _handleImageGeneration,
    sendImageRequestImpl: _sendImageRequest,
    updateChatContent,
    triggerCurrentChat: ({ chatId }) => {
      if (_currentChat.value && toRaw(_currentChat.value).id === chatId) {
        triggerRef(_currentChat);
      }
    },
    startProcessing: ({ chatId }) => {
      chatRuntimeStore.startTask({ key: { kind: 'process', chatId } });
    },
    finishProcessing: ({ chatId }) => {
      chatRuntimeStore.finishTask({ key: { kind: 'process', chatId } });
    },
    sendMessage: ({ content, parentId, attachments }) => sendMessage({ content, parentId, attachments }),
  });
  const handleImageGeneration = chatImageService.handleImageGeneration;
  const chatTitleService = createChatTitleService({
    getCurrentChatId: () => (_currentChat.value ? toRaw(_currentChat.value).id : null),
    getChatTarget: ({ chatId }) => (chatId ? liveChatRegistry.get(chatId) || null : _currentChat.value),
    getLiveChat: ({ chat }) => getLiveChat({ chat }),
    registerLiveInstance,
    resolveSettings: ({ chat }) => {
      const resolved = resolveChatSettings({ chat, groups: chatGroups.value, globalSettings: settings.value });
      return {
        endpointType: resolved.endpointType,
        endpointUrl: resolved.endpointUrl,
        endpointHttpHeaders: resolved.endpointHttpHeaders,
        modelId: resolved.modelId,
        titleModelId: resolved.titleModelId,
        lmParameters: resolved.lmParameters,
      };
    },
    updateChatMeta,
    loadData,
    triggerCurrentChat: ({ chatId }) => {
      if (_currentChat.value && toRaw(_currentChat.value).id === chatId) {
        triggerRef(_currentChat);
      }
    },
    runtimeStore: chatRuntimeStore,
    getFallbackLanguage: (_args) => {
      const typeOfNavigator = typeof navigator;
      switch (typeOfNavigator) {
      case 'undefined':
        return 'en';
      case 'object':
      case 'boolean':
      case 'string':
      case 'number':
      case 'function':
      case 'symbol':
      case 'bigint':
        return navigator.language;
      default: {
        const _ex: never = typeOfNavigator;
        return _ex;
      }
      }
    },
  });
  const generateChatTitle = chatTitleService.generateChatTitle;
  const abortTitleGeneration = chatTitleService.abortTitleGeneration;
  const { enabledToolNames } = useChatTools();
  const chatGenerationService = createChatGenerationService({
    getCurrentChat: () => _currentChat.value,
    getLiveChat,
    registerLiveInstance,
    isProcessing,
    startProcessing: ({ chatId }) => {
      chatRuntimeStore.startTask({ key: { kind: 'process', chatId } });
    },
    finishProcessing: ({ chatId }) => {
      chatRuntimeStore.finishTask({ key: { kind: 'process', chatId } });
    },
    triggerCurrentChat: ({ chatId }) => {
      if (_currentChat.value && toRaw(_currentChat.value).id === chatId) {
        triggerRef(_currentChat);
      }
    },
    resolveSettings: ({ chat }) => {
      const resolved = resolveChatSettings({ chat, groups: chatGroups.value, globalSettings: settings.value });
      return {
        endpointType: resolved.endpointType,
        endpointUrl: resolved.endpointUrl,
        endpointHttpHeaders: resolved.endpointHttpHeaders,
        modelId: resolved.modelId,
        lmParameters: resolved.lmParameters,
        systemPromptMessages: resolved.systemPromptMessages,
        autoTitleEnabled: resolved.autoTitleEnabled,
      };
    },
    fetchAvailableModels: ({ chatId }) => fetchAvailableModels({ chatId, customEndpoint: undefined }),
    canPersistBinary: () => storageService.canPersistBinary,
    persistAttachment: async ({ attachment }) => {
      switch (attachment.status) {
      case 'memory':
        if (storageService.canPersistBinary) {
          try {
            await storageService.saveFile(attachment.blob, attachment.binaryObjectId, attachment.originalName);
            return { ...attachment, status: 'persisted' };
          } catch {
            return attachment;
          }
        }
        return attachment;
      case 'persisted':
      case 'missing':
        return attachment;
      default: {
        const _ex: never = attachment;
        throw new Error(`Unhandled attachment status: ${_ex}`);
      }
      }
    },
    confirmTemporaryAttachments: async (_args) => {
      if (settings.value.heavyContentAlertDismissed !== false) {
        return true;
      }
      return await useConfirm().showConfirm({
        title: 'Attachments cannot be saved',
        message: 'You are using Local Storage, which has a 5MB limit. Attachments will be available during this session but will NOT be saved to your history. Switch to OPFS storage in Settings to enable permanent saving.',
        confirmButtonText: 'Continue anyway',
        cancelButtonText: 'Cancel',
      });
    },
    dismissHeavyContentAlert: (_args) => {
      useSettings().setHeavyContentAlertDismissed?.({ dismissed: true });
    },
    showOnboardingDraft: ({ url, type, models }) => {
      useSettings().setOnboardingDraft?.({ draft: { url: url || '', type, models, selectedModel: models[0] || '' } });
      useSettings().setIsOnboardingDismissed?.({ dismissed: false });
    },
    isImageMode,
    getSelectedImageModel,
    getResolution,
    getCount,
    getSteps,
    getSeed,
    getPersistAs,
    getAvailableModels: () => availableModels.value,
    reportMissingImageModel: async (_args) => {
      const { useGlobalEvents } = await import('../composables/useGlobalEvents');
      const { addErrorEvent } = useGlobalEvents();
      addErrorEvent({ source: 'useChat:sendMessage', message: 'No image generation model found (starting with x/z-image-turbo:).' });
    },
    setActiveGeneration: ({ chatId, generation }) => {
      chatRuntimeStore.setActiveGeneration({ chatId, generation });
    },
    deleteActiveGeneration: ({ chatId }) => {
      chatRuntimeStore.deleteActiveGeneration({ chatId });
    },
    hasActiveGeneration: ({ chatId }) => chatRuntimeStore.activeGenerations.has(chatId),
    handleImageGeneration,
    loadBinaryObject: ({ id }) => storageService.getFile({ binaryObjectId: id }),
    persistToolContent: async ({ text, type, toolCallId }) => {
      const BINARY_THRESHOLD = 100 * 1024;
      if (text.length > BINARY_THRESHOLD) {
        const blob = new Blob([text], { type: 'text/plain' });
        const binaryId = generateId();
        await storageService.saveFile(blob, binaryId, `tool_${type}_${toolCallId}.txt`);
        return { type: 'binary_object', id: binaryId };
      }
      return { type: 'text', text };
    },
    updateChatContent,
    updateChatMeta,
    reloadAfterGenerationMetaUpdate: async (_args) => {
      await loadData({});
    },
    setVolatileAssistantError,
    clearVolatileAssistantError,
    setVolatileToolOutput: ({ toolCallId, output }) => {
      volatileToolOutputs.set(toolCallId, output);
    },
    appendVolatileToolOutput: ({ toolCallId, text }) => {
      const previous = volatileToolOutputs.get(toolCallId) || '';
      volatileToolOutputs.set(toolCallId, previous + text);
    },
    deleteVolatileToolOutput: ({ toolCallId }) => {
      volatileToolOutputs.delete(toolCallId);
    },
    notifyGenerationStatus: ({ chatId, status }) => {
      storageService.notify({ type: 'chat_content_generation', id: chatId, status, timestamp: Date.now() });
    },
    getEnabledToolsForChat: async ({ chat }) => {
      const shellExecuteEnabled = enabledToolNames.value.includes('shell_execute');
      const chatTmpDirectory = shellExecuteEnabled && shouldIncludeWritableTmpMount({ storageType: settings.value.storageType })
        ? await ensureChatTmpDirectory({ chatId: chat.id })
        : undefined;
      const chatGroupMounts = chat.groupId
        ? (_currentChatGroup.value?.id === chat.groupId
          ? _currentChatGroup.value.mounts
          : (await storageService.loadChatGroup({ id: chat.groupId }))?.mounts)
        : undefined;
      return await getEnabledTools({
        enabledNames: enabledToolNames.value,
        settings: settings.value as unknown as Settings,
        chatGroupMounts,
        chatMounts: chat.mounts,
        chatId: chat.id,
        chatGroupId: chat.groupId ?? undefined,
        naidanSysfsVisibility: getNaidanSysfsMountSelection({ chatId: chat.id }),
        tmpHandle: chatTmpDirectory?.handle,
      });
    },
    requestPersistence: (_args) => {
      const { requestPersistence } = useStoragePersistence();
      requestPersistence();
    },
    showGenerationFailedToast: async ({ chat }) => {
      if (_currentChat.value && toRaw(_currentChat.value).id === chat.id) {
        return;
      }
      try {
        const { useToast } = await import('./useToast');
        const { addToast } = useToast();
        addToast({
          message: `Generation failed in "${chat.title || 'New Chat'}"`,
          actionLabel: 'View',
          onAction: async () => {
            await openChat({ id: chat.id });
          },
        });
      } catch {
        // ignore
      }
    },
    generateChatTitle: ({ chatId, signal, titleModelIdOverride }) => generateChatTitle({
      chatId,
      signal,
      titleModelIdOverride,
    }),
    reorderSidebarChatAfterSend: ({ chatId }) => reorderSidebarChatAfterSend({ chatId }),
  });
  const generateResponse = chatGenerationService.generateResponse;
  const sendMessage = chatGenerationService.sendMessage;

  const regenerateMessage = async ({ failedMessageId }: { failedMessageId: string }) => {
    if (!_currentChat.value) return;
    const chatId = toRaw(_currentChat.value).id;
    if (isProcessing({ chatId })) {
      abortChat({ chatId });
      // Wait for the task to actually stop and decTask to be called
      while (isProcessing({ chatId })) {
        await new Promise(r => setTimeout(r, 10));
      }
    }

    const chat = getLiveChat({ chat: _currentChat.value });
    chatRuntimeStore.startTask({
      key: {
        kind: 'process',
        chatId: chat.id,
      },
    });
    registerLiveInstance({ chat });
    try {
      const failedNode = findNodeInBranch({ items: chat.root.items, targetId: failedMessageId });
      if (!failedNode || failedNode.role !== 'assistant') return;
      const parent = findParentInBranch({ items: chat.root.items, childId: failedMessageId });
      if (!parent || parent.role !== 'user') return;
      const newAssistantMsg: AssistantMessageNode = {
        id: generateId(),
        role: 'assistant',
        content: '',
        timestamp: Date.now(),
        modelId: failedNode.modelId,
        replies: { items: [] },
        attachments: undefined,
        thinking: undefined,
        error: undefined,
        lmParameters: failedNode.lmParameters || EMPTY_LM_PARAMETERS,
        toolCalls: undefined,
        results: undefined,
      };
      parent.replies.items.push(newAssistantMsg);
      chat.currentLeafId = newAssistantMsg.id;
      if (_currentChat.value && toRaw(_currentChat.value).id === chat.id) triggerRef(_currentChat);
      await updateChatContent({ id: chat.id, updater: (current) => ({ ...current, root: chat.root, currentLeafId: chat.currentLeafId }) });
      await updateChatMeta({ id: chat.id, updater: (curr) => {
        if (!curr) return chat;
        return { ...curr, updatedAt: Date.now(), currentLeafId: chat.currentLeafId };
      } });
      let markGenerationReady: (() => void) | undefined;
      const generationReady = new Promise<void>(resolve => {
        markGenerationReady = resolve;
      });
      generateResponse({
        chat,
        assistantId: newAssistantMsg.id,
        lmParameters: failedNode.lmParameters,
        onReady: (_args) => {
          markGenerationReady?.();
          markGenerationReady = undefined;
        },
      }).catch(e => {
        markGenerationReady?.();
        markGenerationReady = undefined;
        console.error('Background generation failed:', e);
      });
      await generationReady;
    } finally {
      chatRuntimeStore.finishTask({
        key: {
          kind: 'process',
          chatId: chat.id,
        },
      });
    }
  };

  const abortChat = ({ chatId }: { chatId: string | undefined }) => {
    const id = chatId || (_currentChat.value ? toRaw(_currentChat.value).id : null);
    if (id) {
      abortContextCompact({ chatId: id });
      if (chatRuntimeStore.activeGenerations.has(id)) {
        chatRuntimeStore.getActiveGeneration({ chatId: id })?.controller.abort();
        storageService.notify({ type: 'chat_content_generation', id, status: 'abort_request', timestamp: Date.now() });
      } else if (chatRuntimeStore.hasExternalGeneration({ chatId: id })) {
        storageService.notify({ type: 'chat_content_generation', id, status: 'abort_request', timestamp: Date.now() });
      }
      // Also abort title generation for this chat
      abortTitleGeneration({ chatId: id });
    }
  };

  const { addErrorEvent } = useGlobalEvents();
  const contextCompactService = createContextCompactService({
    getCurrentChat: () => (_currentChat.value ? getLiveChat({ chat: _currentChat.value }) : null),
    getLiveChat,
    isProcessing,
    registerLiveInstance,
    resolveSettings: ({ chat }) => {
      const resolved = resolveChatSettings({ chat, groups: chatGroups.value, globalSettings: settings.value });
      return {
        endpointType: resolved.endpointType,
        endpointUrl: resolved.endpointUrl,
        endpointHttpHeaders: resolved.endpointHttpHeaders,
        modelId: resolved.modelId,
        lmParameters: resolved.lmParameters,
      };
    },
    getPromptMode: ({ chatId }) => {
      const mountSelection = getNaidanSysfsMountSelection({ chatId });
      switch (mountSelection) {
      case 'none':
        return 'without_message_ids';
      case 'current_chat_only':
      case 'current_chat_with_chat_group':
      case 'all_chats':
        return 'with_message_ids';
      default: {
        const _ex: never = mountSelection;
        throw new Error(`Unhandled naidan sysfs mount selection: ${_ex}`);
      }
      }
    },
    runtime: contextCompactRuntime,
    updateChatContent,
    updateChatMeta,
    triggerCurrentChat: ({ chatId }) => {
      if (_currentChat.value && toRaw(_currentChat.value).id === chatId) {
        triggerRef(_currentChat);
      }
    },
    addErrorEvent,
    startProcessing: ({ chatId }) => {
      chatRuntimeStore.startTask({ key: { kind: 'process', chatId } });
    },
    finishProcessing: ({ chatId }) => {
      chatRuntimeStore.finishTask({ key: { kind: 'process', chatId } });
    },
  });
  const abortContextCompact = contextCompactService.abortContextCompact;
  const compactCurrentBranch = async ({
    keepRecentMessages,
    instructionOverride,
  }: {
    keepRecentMessages: number;
    instructionOverride: string | undefined;
  }): Promise<boolean> => {
    const result = await contextCompactService.compactCurrentBranch({
      keepRecentMessages,
      instructionOverride,
    });
    return result.status === 'compacted';
  };

  const forkChat = async ({ messageId, chatId }: { messageId: string, chatId?: string }): Promise<string | null> => {
    const target = chatId ? liveChatRegistry.get(chatId) : _currentChat.value;
    if (!target) return null;
    const mutableChat = getLiveChat({ chat: target });
    const path = Array.from(getChatBranchIterator({ chat: mutableChat }));
    const idx = path.findIndex(m => m.id === messageId);
    if (idx === -1) return null;
    const forkPath = path.slice(0, idx + 1);
    const clonedNodes: MessageNode[] = forkPath.map(n => {
      const common = { id: n.id, content: n.content, timestamp: n.timestamp, replies: { items: [] } };
      switch (n.role) {
      case 'user':
        return {
          ...common,
          role: 'user',
          attachments: n.attachments,
          thinking: undefined,
          error: undefined,
          modelId: undefined,
          lmParameters: n.lmParameters || { reasoning: { effort: undefined } },
          toolCalls: undefined,
          results: undefined,
        } as UserMessageNode;
      case 'assistant':
        return {
          ...common,
          role: 'assistant',
          attachments: undefined,
          thinking: n.thinking,
          error: n.error,
          modelId: n.modelId,
          lmParameters: n.lmParameters || { reasoning: { effort: undefined } },
          toolCalls: n.toolCalls,
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
          results: n.results,
        } as import('../models/types').ToolMessageNode;
      default: {
        const _ex: never = n;
        throw new Error(`Unhandled role: ${(_ex as { role: string }).role}`);
      }
      }
    });
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
      registerLiveInstance({ chat: newChatObj });
      await updateChatContent({ id: newChatId, updater: () => ({ root: newChatObj.root, currentLeafId: newChatObj.currentLeafId }) });
      await updateChatMeta({ id: newChatId, updater: () => newChatObj });
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
      await loadData({});
      await openChat({ id: newChatObj.id });
      return newChatObj.id;
    } finally { /* No explicit unregister here */ }
  };

  const editMessage = async ({ messageId, newContent, lmParameters }: { messageId: string, newContent: string, lmParameters?: LmParameters }) => {
    if (!_currentChat.value) return;
    const chatId = toRaw(_currentChat.value).id;
    if (isProcessing({ chatId })) {
      abortChat({ chatId });
      // Wait for the task to actually stop and decTask to be called
      while (isProcessing({ chatId })) {
        await new Promise(r => setTimeout(r, 10));
      }
    }

    const chat = getLiveChat({ chat: _currentChat.value });
    const node = findNodeInBranch({ items: chat.root.items, targetId: messageId }); if (!node) return;
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
      await updateChatContent({ id: chat.id, updater: (current) => ({ ...current, root: chat.root, currentLeafId: chat.currentLeafId }) });
      if (_currentChat.value && toRaw(_currentChat.value).id === chat.id) triggerRef(_currentChat);
      break;
    }
    case 'user': {
      const parent = findParentInBranch({ items: chat.root.items, childId: messageId });
      await sendMessage({ content: newContent, parentId: parent ? parent.id : null, attachments: node.attachments, chatTarget: chat, lmParameters: lmParameters });
      break;
    }
    case 'system': {
      const parent = findParentInBranch({ items: chat.root.items, childId: messageId });
      await sendMessage({ content: newContent, parentId: parent ? parent.id : null, attachments: undefined, chatTarget: chat, lmParameters: lmParameters });
      break;
    }
    case 'tool':
      break;
    default: {
      const _ex: never = node;
      throw new Error(`Unhandled role: ${(_ex as { role: string }).role}`);
    }
    }
  };

  const switchVersion = async ({ messageId }: { messageId: string }) => {
    if (!_currentChat.value) return;
    const chat = getLiveChat({ chat: _currentChat.value });
    const node = findNodeInBranch({ items: chat.root.items, targetId: messageId });
    if (node) {
      chat.currentLeafId = findDeepestLeaf({ node }).id;
      if (_currentChat.value && toRaw(_currentChat.value).id === chat.id) triggerRef(_currentChat);
      await updateChatContent({ id: chat.id, updater: (current) => ({ ...current, root: chat.root, currentLeafId: chat.currentLeafId }) });
    }
  };

  const getSiblings = ({ messageId, chatId }: { messageId: string, chatId?: string }) => {
    const target = chatId ? liveChatRegistry.get(chatId) : _currentChat.value;
    if (!target) return [];
    const mutableChat = getLiveChat({ chat: target });
    const parent = findParentInBranch({ items: mutableChat.root.items, childId: messageId });
    return parent ? parent.replies.items : mutableChat.root.items;
  };

  const toggleDebug = chatMetadataService.toggleDebug;

  const getReasoningEffort = ({ chatId }: { chatId: string }) => {
    const chat = liveChatRegistry.get(chatId) || (_currentChat.value && toRaw(_currentChat.value).id === chatId ? _currentChat.value : null);
    return chat?.lmParameters?.reasoning?.effort;
  };

  const updateReasoningEffort = chatMetadataService.updateReasoningEffort;

  const commitFullHistoryManipulation = async ({ chatId, messages, systemPrompt }: { chatId: string, messages: HistoryItem[], systemPrompt: SystemPrompt | undefined }) => {
    const target = liveChatRegistry.get(chatId) || (_currentChat.value && toRaw(_currentChat.value).id === chatId ? _currentChat.value : null);
    if (!target) return;
    const chat = getLiveChat({ chat: target });

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

    const newNodes = createBranchFromMessages({ messages });

    if (newNodes.length > 0) {
      if (!chat.root) chat.root = { items: [] };
      chat.root.items.push(newNodes[0]!);
      chat.currentLeafId = newNodes[newNodes.length - 1]!.id;
    }

    chat.updatedAt = Date.now();
    if (_currentChat.value && toRaw(_currentChat.value).id === chat.id) triggerRef(_currentChat);

    await updateChatContent({ id: chat.id, updater: (current) => ({ ...current, root: chat.root, currentLeafId: chat.currentLeafId }) });
    await updateChatMeta({ id: chat.id, updater: (curr) => {
      if (!curr) return chat;
      return { ...curr, updatedAt: Date.now(), currentLeafId: chat.currentLeafId };
    } });
  };

  const generateImage = chatImageService.generateImage;
  const sendImageRequest = chatImageService.sendImageRequest;

  const createChatGroup = async ({ name, options }: { name: string, options?: Partial<Pick<ChatGroup, 'modelId' | 'systemPrompt' | 'lmParameters'>> }) => {
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
    await loadData({});
    return id;
  };

  const deleteChatGroup = async ({ id }: { id: string }) => {
    const group = chatGroups.value.find(g => g.id === id);
    if (!group) return;
    const items = [...group.items];
    for (const item of items) {
      await deleteChat({ id: item.chat.id, injectAddToast: () => '' });
    }
    if (_currentChatGroup.value?.id === id) _currentChatGroup.value = null;
    await storageService.deleteChatGroup({ id });
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
    await loadData({});
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

  const duplicateChatGroup = async ({ groupId }: { groupId: string }) => {
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
    await loadData({});
    return newId;
  };

  const renameChatGroup = async ({ groupId, newName }: { groupId: string, newName: string }) => {
    if (_currentChatGroup.value?.id === groupId) {
      _currentChatGroup.value.name = newName; _currentChatGroup.value.updatedAt = Date.now();
    }
    await storageService.updateChatGroup(groupId, (chatGroup) => {
      if (!chatGroup) throw new Error('Chat group not found');
      chatGroup.name = newName; chatGroup.updatedAt = Date.now(); return chatGroup;
    });
    await loadData({});
  };

  const updateChatGroupMetadata = async ({ id, updates }: { id: string, updates: Partial<Pick<ChatGroup, 'name' | 'endpoint' | 'modelId' | 'autoTitleEnabled' | 'titleModelId' | 'systemPrompt' | 'lmParameters'>> }) => {
    if (_currentChatGroup.value?.id === id) {
      Object.assign(_currentChatGroup.value, updates); _currentChatGroup.value.updatedAt = Date.now();
    }
    await storageService.updateChatGroup(id, (curr) => {
      if (!curr) throw new Error('Chat group not found');
      return { ...curr, ...updates, updatedAt: Date.now() };
    });
    await loadData({});
  };

  const persistSidebarStructure = async ({ topLevelItems }: { topLevelItems: SidebarItem[] }) => {
    chatDataStore.replaceSidebarItems({ items: topLevelItems });
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

  const reorderSidebarChatAfterSend = async ({ chatId }: { chatId: string }) => {
    const reorderSetting = settings.value.experimental?.sidebarSendMessageReorder ?? 'disabled';
    switch (reorderSetting) {
    case 'disabled':
      return;
    case 'move_sent_chat':
      break;
    default: {
      const _ex: never = reorderSetting;
      throw new Error(`Unhandled sidebar send reorder setting: ${_ex}`);
    }
    }

    await storageService.updateHierarchy((curr) => {
      let chatNode: HierarchyNode | undefined;
      let sourceGroup: HierarchyChatGroupNode | undefined;

      curr.items = curr.items.filter(i => {
        switch (i.type) {
        case 'chat':
          if (i.id === chatId) {
            chatNode = i;
            return false;
          }
          return true;
        case 'chat_group': {
          const chatIndex = i.chat_ids.indexOf(chatId);
          if (chatIndex !== -1) {
            sourceGroup = i;
            i.chat_ids.splice(chatIndex, 1);
          }
          return true;
        }
        default: {
          const _ex: never = i;
          throw new Error(`Unhandled hierarchy node type: ${_ex}`);
        }
        }
      });

      if (sourceGroup) {
        sourceGroup.chat_ids.unshift(chatId);
        return curr;
      }

      const node = chatNode ?? { type: 'chat', id: chatId };
      const firstTopLevelChatIndex = curr.items.findIndex(i => i.type === 'chat');
      const insertIndex = firstTopLevelChatIndex === -1 ? curr.items.length : firstTopLevelChatIndex;
      curr.items.splice(insertIndex, 0, node);
      return curr;
    });

    await loadData({});
  };

  const moveChatToGroup = async ({ chatId, targetGroupId }: { chatId: string, targetGroupId: string | null }) => {
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
    await loadData({});
  };

  const __testOnlySetCurrentChat = ({ chat }: { chat: Chat | null }) => {
    _currentChat.value = chat;
    if (chat) registerLiveInstance({ chat });
  };
  const __testOnlySetCurrentChatGroup = ({ group }: { group: ChatGroup | null }) => {
    _currentChatGroup.value = group;
  };
  const __testOnlySetContextCompactProgress = ({
    chatId,
    progress,
  }: {
    chatId: string;
    progress: ContextCompactProgress;
  }) => {
    setContextCompactProgress({
      chatId,
      progress,
    });
  };
  const clearLiveChatRegistry = (_params: Record<string, never>) => {
    liveChatRegistry.clear();
  };

  const clearActiveTaskCounts = (_params: Record<string, never>) => {
    chatRuntimeStore.clearActiveTaskCounts({});
  };

  const getVolatileToolOutput = ({ toolCallId }: { toolCallId: string }) => {
    return volatileToolOutputs.get(toolCallId);
  };

  const {
    chatFlow,
    isThinkingActive,
    isWaitingResponse
  } = useChatDisplayFlow({
    chat: currentChat as unknown as ComputedRef<Chat | null>,
    isProcessing
  });

  return {
    rootItems, chats, chatGroups, sidebarItems, currentChat, currentChatGroup, resolvedSettings, inheritedSettings, activeMessages, allMessages, streaming, generatingTitle, availableModels, fetchingModels,
    imageModeMap, imageResolutionMap, imageCountMap, imagePersistAsMap, imageProgressMap, imageModelOverrideMap,
    isImageMode, toggleImageMode, getResolution, updateResolution, getCount, updateCount, getSteps, updateSteps, getSeed, updateSeed, getPersistAs, updatePersistAs, setImageModel, getSelectedImageModel, getSortedImageModels, getReasoningEffort, updateReasoningEffort,
    loadChats: loadData, fetchAvailableModels, createNewChat, openChat, openChatAtMessage, openChatGroup, deleteChat, deleteAllChats, renameChat, updateChatModel, updateChatGroupOverride, updateChatSettings, generateChatTitle, sendMessage, regenerateMessage, forkChat, editMessage, switchVersion, getSiblings, toggleDebug, commitFullHistoryManipulation, generateImage, generateResponse, handleImageGeneration, sendImageRequest, createChatGroup, deleteChatGroup, duplicateChatGroup, setChatGroupCollapsed, renameChatGroup, updateChatGroupMetadata, persistSidebarStructure, abortChat, abortTitleGeneration, updateChatMeta, updateChatContent, moveChatToGroup, addMountToChat, removeMountFromChat, updateChatMount, addMountToChatGroup, removeMountFromChatGroup, updateChatGroupMount, compactCurrentBranch, abortContextCompact, getContextCompactProgress,
    registerLiveInstance, unregisterLiveInstance, getLiveChat, isTaskRunning, isProcessing, isGeneratingTitle, ensureChatTmpDirectory, getChatTmpDirectory,
    getVolatileToolOutput,
    chatFlow, isThinkingActive, isWaitingResponse, contextCompactProgress,
    TEST_ONLY: {
      liveChatRegistry,
      activeGenerations: chatRuntimeStore.activeGenerations,
      activeTaskCounts: chatRuntimeStore.TEST_ONLY.activeTaskCounts,
      compactProgressByChat: contextCompactRuntime.TEST_ONLY.compactProgressByChat,
      activeContextCompactions: contextCompactRuntime.activeContextCompactions,
      chatTmpDirectories,
      clearLiveChatRegistry,
      clearActiveTaskCounts,
      volatileToolOutputs,
      __testOnlySetCurrentChat,
      __testOnlySetCurrentChatGroup,
      __testOnlySetContextCompactProgress,
    }
  };
}
