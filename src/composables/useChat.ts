import { ref, computed, shallowRef, reactive, triggerRef } from 'vue';
import { v7 as uuidv7 } from 'uuid';
import type { Chat, MessageNode, ChatGroup, SidebarItem, ChatSummary, Attachment, MultimodalContent, ChatMessage, Settings, EndpointType, Hierarchy, HierarchyNode, HierarchyChatGroupNode } from '../models/types';
import { storageService } from '../services/storage';
import { OpenAIProvider, OllamaProvider } from '../services/llm';
import { useSettings } from './useSettings';
import { useConfirm } from './useConfirm';
import { useGlobalEvents } from './useGlobalEvents';

const rootItems = ref<SidebarItem[]>([]);
const currentChat = shallowRef<Chat | null>(null);
const currentChatGroup = shallowRef<ChatGroup | null>(null);

const liveChatRegistry = reactive(new Map<string, Chat>());
const activeGenerations = reactive(new Map<string, { controller: AbortController, chat: Chat }>());
const activeTitleGenerations = reactive(new Set<string>());
const activeModelFetches = reactive(new Set<string>());
const activeProcessing = reactive(new Set<string>());

const streaming = computed(() => activeGenerations.size > 0);
const generatingTitle = computed(() => activeTitleGenerations.size > 0);
const fetchingModels = computed(() => activeModelFetches.size > 0);

const creatingChat = ref(false);
const availableModels = ref<string[]>([]);

// --- Lifecycle & Cleanup ---

if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', () => {
    for (const item of activeGenerations.values()) {
      item.controller.abort();
    }
  });
}

// --- Synchronization ---

function syncLiveInstancesWithSidebar() {
  const sync = (items: SidebarItem[], parentGroupId: string | null) => {
    for (const item of items) {
      if (item.type === 'chat') {
        const live = liveChatRegistry.get(item.chat.id);
        if (live) live.groupId = parentGroupId;
        if (currentChat.value?.id === item.chat.id) currentChat.value.groupId = parentGroupId;
      } else if (item.type === 'chat_group') {
        sync(item.chatGroup.items, item.chatGroup.id);
      }
    }
  };
  sync(rootItems.value, null);
}

let sidebarReloadTimeout: ReturnType<typeof setTimeout> | null = null;
let lastSidebarReload = 0;
const debouncedSidebarReload = () => {
  if (sidebarReloadTimeout) clearTimeout(sidebarReloadTimeout);
  
  const performReload = async () => {
    rootItems.value = await storageService.getSidebarStructure();
    syncLiveInstancesWithSidebar();
    lastSidebarReload = Date.now();
    sidebarReloadTimeout = null;
  };

  const now = Date.now();
  // If we haven't reloaded in 2 seconds, do it now regardless of debouncing
  if (now - lastSidebarReload > 2000) {
    performReload();
  } else {
    sidebarReloadTimeout = setTimeout(performReload, 200);
  }
};

storageService.subscribeToChanges(async (event) => {
  if (event.type === 'chat_meta_and_chat_group') {
    debouncedSidebarReload();

    if (event.id && currentChat.value?.id === event.id) {
      const fresh = await storageService.loadChat(event.id);
      if (fresh) {
        currentChat.value.title = fresh.title;
        currentChat.value.updatedAt = fresh.updatedAt;
        currentChat.value.modelId = fresh.modelId;
        triggerRef(currentChat);
      }
    }

    if (event.id && currentChatGroup.value?.id === event.id) {
      const allGroups = await storageService.listChatGroups();
      currentChatGroup.value = allGroups.find(g => g.id === event.id) || null;
    }
  } 
  
  if (event.type === 'chat_content' && event.id && currentChat.value?.id === event.id) {
    if (!activeGenerations.has(event.id)) {
      const fresh = await storageService.loadChat(event.id);
      if (fresh) {
        currentChat.value.root = fresh.root;
        currentChat.value.currentLeafId = fresh.currentLeafId;
        triggerRef(currentChat);
      }
    }
  }
  
  if (event.type === 'migration') {
    for (const item of activeGenerations.values()) item.controller.abort();
    activeGenerations.clear();
    activeTitleGenerations.clear();
    activeModelFetches.clear();
    liveChatRegistry.clear();

    rootItems.value = await storageService.getSidebarStructure();
    if (currentChat.value) {
      const fresh = await storageService.loadChat(currentChat.value.id);
      currentChat.value = fresh ? reactive(fresh) : null;
    }
    if (currentChatGroup.value) {
      const allGroups = await storageService.listChatGroups();
      currentChatGroup.value = allGroups.find(g => g.id === currentChatGroup.value?.id) || null;
    }
  }
});

// --- Registry Helpers ---

function registerLiveInstance(chat: Chat) { liveChatRegistry.set(chat.id, chat); }

function unregisterLiveInstance(chatId: string) {
  if (!activeGenerations.has(chatId) && !activeTitleGenerations.has(chatId) && !activeModelFetches.has(chatId) && !activeProcessing.has(chatId)) {
    liveChatRegistry.delete(chatId);
  }
}

// --- Internal Logic ---

async function fileToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

function getChatBranch(chat: Chat): MessageNode[] {
  if (chat.root.items.length === 0) return [];
  const path: MessageNode[] = [];
  const targetId = chat.currentLeafId;
  let curr: MessageNode | null = chat.root.items.find(item => 
    item.id === targetId || findNodeInBranch(item.replies.items, targetId || ''),
  ) || chat.root.items[chat.root.items.length - 1] || null;

  while (curr) {
    path.push(curr);
    if (curr.id === targetId) break;
    const next: MessageNode | undefined = curr.replies.items.find(item => 
      item.id === targetId || findNodeInBranch(item.replies.items, targetId || ''),
    ) || curr.replies.items[curr.replies.items.length - 1];
    curr = next || null;
  }
  return path;
}

function findNodeInBranch(items: MessageNode[], targetId: string): MessageNode | null {
  for (const item of items) {
    if (item.id === targetId) return item;
    const found = findNodeInBranch(item.replies.items, targetId);
    if (found) return found;
  }
  return null;
}

function findParentInBranch(items: MessageNode[], childId: string): MessageNode | null {
  for (const item of items) {
    if (item.replies.items.some(child => child.id === childId)) return item;
    const found = findParentInBranch(item.replies.items, childId);
    if (found) return found;
  }
  return null;
}

function findDeepestLeaf(node: MessageNode): MessageNode {
  if (node.replies.items.length === 0) return node;
  return findDeepestLeaf(node.replies.items[node.replies.items.length - 1]!);
}

export function resolveChatSettings(chat: Chat, groups: ChatGroup[], globalSettings: Settings) {
  const group = chat.groupId ? groups.find(g => g.id === chat.groupId) : null;
  const endpointType = chat.endpointType || group?.endpoint?.type || globalSettings.endpointType;
  const endpointUrl = chat.endpointUrl || group?.endpoint?.url || globalSettings.endpointUrl || '';
  const endpointHttpHeaders = chat.endpointHttpHeaders || group?.endpoint?.httpHeaders || globalSettings.endpointHttpHeaders;
  const modelId = chat.modelId || group?.modelId || globalSettings.defaultModelId || '';

  let systemPrompts: string[] = [];
  if (globalSettings.systemPrompt) systemPrompts.push(globalSettings.systemPrompt);
  if (group?.systemPrompt) {
    if (group.systemPrompt.behavior === 'override') systemPrompts = group.systemPrompt.content ? [group.systemPrompt.content] : [];
    else if (group.systemPrompt.content) systemPrompts.push(group.systemPrompt.content);
  }
  if (chat.systemPrompt) {
    if (chat.systemPrompt.behavior === 'override') systemPrompts = chat.systemPrompt.content ? [chat.systemPrompt.content] : [];
    else if (chat.systemPrompt.content) systemPrompts.push(chat.systemPrompt.content);
  }

  const lmParameters = { ...(globalSettings.lmParameters || {}), ...(group?.lmParameters || {}), ...(chat.lmParameters || {}), };

  return {
    endpointType, endpointUrl, endpointHttpHeaders, modelId, systemPromptMessages: systemPrompts, lmParameters,
    sources: {
      endpointType: chat.endpointType ? 'chat' : (group?.endpoint?.type ? 'chat_group' : 'global'),
      endpointUrl: chat.endpointUrl ? 'chat' : (group?.endpoint?.url ? 'chat_group' : 'global'),
      modelId: chat.modelId ? 'chat' : (group?.modelId ? 'chat_group' : 'global'),
    } as const,
  };
}

export function processThinking(node: MessageNode) {
  const thinkRegex = /<think>([\s\S]*?)<\/think>/gi;
  const matches = [...node.content.matchAll(thinkRegex)];
  if (matches.length > 0) {
    const thoughts = matches.map(m => m[1]?.trim()).filter(Boolean).join('\n\n---\n\n');
    node.thinking = node.thinking ? `${node.thinking}\n\n---\n\n${thoughts}` : thoughts;
    node.content = node.content.replace(thinkRegex, '').trim();
  }
}

export function findRestorationIndex(items: SidebarItem[], prevId: string | null, nextId: string | null): number {
  if (items.length === 0) return 0;
  const prevIdx = prevId ? items.findIndex(item => item.id === prevId) : -1;
  if (prevIdx !== -1) return prevIdx + 1;
  const nextIdx = nextId ? items.findIndex(item => item.id === nextId) : -1;
  if (nextIdx !== -1) return nextIdx;
  return 0;
}

export interface AddToastOptions { message: string; actionLabel?: string; onAction?: () => void | Promise<void>; duration?: number; }

export function useChat() {
  const { settings } = useSettings();

  const sidebarItems = computed(() => rootItems.value);

  const chats = computed(() => {
    const all: ChatSummary[] = [];
    const collect = (items: SidebarItem[]) => {
      items.forEach(item => {
        if (item.type === 'chat') all.push(item.chat);
        else collect(item.chatGroup.items);
      });
    };
    collect(rootItems.value);
    return all;
  });

  const chatGroups = computed(() => {
    const all: ChatGroup[] = [];
    rootItems.value.forEach(item => { if (item.type === 'chat_group') all.push(item.chatGroup); });
    return all;
  });

  const resolvedSettings = computed(() => {
    if (!currentChat.value) return null;
    return resolveChatSettings(currentChat.value, chatGroups.value, settings.value);
  });

  const inheritedSettings = computed(() => {
    if (!currentChat.value) return null;
    const chat = currentChat.value;
    const virtualChat: Chat = { ...chat, modelId: undefined, endpointType: undefined, endpointUrl: undefined, endpointHttpHeaders: undefined, systemPrompt: undefined, lmParameters: undefined, };
    return resolveChatSettings(virtualChat, chatGroups.value, settings.value);
  });

  const activeMessages = computed(() => {
    if (!currentChat.value) return [];
    return getChatBranch(currentChat.value);
  });

  const loadData = async () => { rootItems.value = await storageService.getSidebarStructure(); };

  const fetchAvailableModels = async (chat?: Chat, customEndpoint?: { type: EndpointType, url: string, headers?: [string, string][] }) => {
    const taskId = chat?.id || 'custom-fetch';
    activeModelFetches.add(taskId);
    if (chat) registerLiveInstance(chat);
    
    let type: EndpointType;
    let url: string;
    let headers: [string, string][] | undefined;

    if (customEndpoint) {
      type = customEndpoint.type; url = customEndpoint.url; headers = customEndpoint.headers;
    } else if (chat) {
      const group = chat.groupId ? chatGroups.value.find(g => g.id === chat.groupId) : null;
      type = chat.endpointType || group?.endpoint?.type || settings.value.endpointType;
      url = chat.endpointUrl || group?.endpoint?.url || settings.value.endpointUrl || '';
      headers = chat.endpointHttpHeaders || group?.endpoint?.httpHeaders || settings.value.endpointHttpHeaders;
    } else {
      type = settings.value.endpointType;
      url = settings.value.endpointUrl || '';
      headers = settings.value.endpointHttpHeaders;
    }

    if (!url) {
      activeModelFetches.delete(taskId);
      if (chat) unregisterLiveInstance(taskId);
      return [];
    }
    
    try {
      const provider = type === 'ollama' ? new OllamaProvider() : new OpenAIProvider();
      const models = await provider.listModels(url, headers);
      const result = Array.isArray(models) ? models : [];
      if (chat && chat.id === currentChat.value?.id) availableModels.value = result;
      return result;
    } catch (e) {
      const { addErrorEvent } = useGlobalEvents();
      addErrorEvent({ source: 'useChat:fetchAvailableModels', message: 'Failed to fetch models for resolution', details: e instanceof Error ? e : String(e), });
      return [];
    } finally {
      activeModelFetches.delete(taskId);
      if (chat) unregisterLiveInstance(taskId);
    }
  };

  const saveChatMeta = async (chat: Chat) => { await storageService.saveChatMeta(chat); };
  const saveChatContent = async (chat: Chat) => { await storageService.saveChatContent(chat.id, chat); };

  const createNewChat = async (chatGroupId: string | null = null, modelId: string | null = null) => {
    if (creatingChat.value) return null;
    currentChatGroup.value = null;
    creatingChat.value = true;
    const chatId = uuidv7();
    try {
      const chatObj: Chat = reactive({
        id: chatId, title: null, groupId: chatGroupId, root: { items: [] },
        createdAt: Date.now(), updatedAt: Date.now(), debugEnabled: false,
        modelId: modelId ?? undefined,
      });

      registerLiveInstance(chatObj);
      await saveChatContent(chatObj);
      await saveChatMeta(chatObj);

      await storageService.updateHierarchy((current) => {
        if (chatGroupId) {
          const group = current.items.find(i => i.type === 'chat_group' && i.id === chatGroupId) as HierarchyChatGroupNode;
          if (group) {
            group.chat_ids.unshift(chatId);
            return current;
          }
        }
        
        const firstChatIdx = current.items.findIndex(i => i.type === 'chat');
        const insertIdx = firstChatIdx !== -1 ? firstChatIdx : current.items.length;
        current.items.splice(insertIdx, 0, { type: 'chat', id: chatId });
        return current;
      });
      
      currentChat.value = chatObj;
      await loadData();
      return chatId;
    } finally {
      creatingChat.value = false;
      unregisterLiveInstance(chatId);
    }
  };

  const openChat = async (id: string) => {
    currentChatGroup.value = null;
    if (liveChatRegistry.has(id)) { currentChat.value = liveChatRegistry.get(id)!; return; }
    const loaded = await storageService.loadChat(id);
    if (loaded) currentChat.value = reactive(loaded);
    else currentChat.value = null;
  };

  const openChatGroup = (id: string) => {
    const group = chatGroups.value.find(g => g.id === id);
    if (group) currentChatGroup.value = group;
  };

  const deleteChat = async (id: string, injectAddToast?: (toast: AddToastOptions) => string) => {
    const { useToast } = await import('./useToast');
    const { addToast: originalAddToast } = useToast();
    const addToast = injectAddToast || originalAddToast;
    const chatData = await storageService.loadChat(id);
    if (!chatData) return;

    if (activeGenerations.has(id)) {
      activeGenerations.get(id)?.controller.abort();
      activeGenerations.delete(id);
    }
    activeTitleGenerations.delete(id);
    activeModelFetches.delete(id);
    liveChatRegistry.delete(id);

    await storageService.deleteChat(id);
    await storageService.updateHierarchy((curr) => {
      curr.items = curr.items.filter(i => {
        if (i.type === 'chat' && i.id === id) return false;
        if (i.type === 'chat_group') i.chat_ids = i.chat_ids.filter(cid => cid !== id);
        return true;
      });
      return curr;
    });

    if (currentChat.value?.id === id) currentChat.value = null;
    await loadData();

    addToast({
      message: `Chat "${chatData.title || 'Untitled'}" deleted`,
      actionLabel: 'Undo',
      onAction: async () => {
        const originalGroupId = chatData.groupId;
        await saveChatContent(chatData);
        await saveChatMeta(chatData);
        await storageService.updateHierarchy((curr) => {
          if (originalGroupId) {
            const group = curr.items.find(i => i.type === 'chat_group' && i.id === originalGroupId) as HierarchyChatGroupNode;
            if (group) {
              group.chat_ids.push(chatData.id);
              return curr;
            }
          }
          curr.items.push({ type: 'chat', id: chatData.id });
          return curr;
        });
        await loadData();
        await openChat(chatData.id);
      },
    });
  };

  const deleteAllChats = async () => {
    for (const [, item] of activeGenerations.entries()) item.controller.abort();
    activeGenerations.clear();
    activeTitleGenerations.clear();
    activeModelFetches.clear();
    liveChatRegistry.clear();

    const all = await storageService.listChats();
    for (const c of all) await storageService.deleteChat(c.id);
    const allGroups = await storageService.listChatGroups();
    for (const g of allGroups) await storageService.deleteChatGroup(g.id);
    
    await storageService.updateHierarchy((curr) => { curr.items = []; return curr; });
    currentChat.value = null;
    await loadData();
  };

  const renameChat = async (id: string, newTitle: string) => {
    const liveChat = liveChatRegistry.get(id);
    if (liveChat) {
      liveChat.title = newTitle; liveChat.updatedAt = Date.now();
      await saveChatMeta(liveChat);
      if (currentChat.value?.id === id) triggerRef(currentChat);
      await loadData();
      return;
    }
    const chat = await storageService.loadChat(id);
    if (chat) {
      chat.title = newTitle; chat.updatedAt = Date.now();
      await saveChatMeta(chat);
      if (currentChat.value?.id === id) {
        currentChat.value.title = newTitle; currentChat.value.updatedAt = chat.updatedAt;
        triggerRef(currentChat);
      }
      await loadData();
    }
  };

  const generateResponse = async (chat: Chat, assistantId: string) => {
    const assistantNode = findNodeInBranch(chat.root.items, assistantId);
    if (!assistantNode) throw new Error('Assistant node not found');
    assistantNode.error = undefined;
    if (currentChat.value?.id === chat.id) triggerRef(currentChat);

    const controller = new AbortController();
    activeGenerations.set(chat.id, { controller, chat });
    registerLiveInstance(chat);

    const resolved = resolveChatSettings(chat, chatGroups.value, settings.value);
    const type = resolved.endpointType;
    const url = resolved.endpointUrl;
    const resolvedModel = assistantNode.modelId || resolved.modelId;

    try {
      const provider = type === 'ollama' ? new OllamaProvider() : new OpenAIProvider();
      const headers = resolved.endpointHttpHeaders;
      const finalMessages: ChatMessage[] = [];
      resolved.systemPromptMessages.forEach(content => finalMessages.push({ role: 'system', content }));

      const history = getChatBranch(chat).filter(m => m.id !== assistantId);
      for (const m of history) {
        if (m.attachments && m.attachments.length > 0) {
          const content: MultimodalContent[] = [{ type: 'text', text: m.content }];
          for (const att of m.attachments) {
            let blob: Blob | null = null;
            if (att.status === 'memory') blob = att.blob;
            else if (att.status === 'persisted') blob = await storageService.getFile(att.id, att.originalName);
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
      await provider.chat(finalMessages, resolvedModel, url, async (chunk) => {
        assistantNode.content += chunk;
        if (currentChat.value?.id === chat.id) triggerRef(currentChat);
        
        const now = Date.now();
        if (now - lastSave > 500 && !isSaving) {
          isSaving = true;
          try {
            await saveChatContent(chat);
            lastSave = Date.now();
          } finally {
            isSaving = false;
          }
        }
      }, resolved.lmParameters, headers, controller.signal);

      // Ensure the final state is saved after streaming completes
      await saveChatContent(chat);

      processThinking(assistantNode);
      chat.updatedAt = Date.now();
      
      if (activeGenerations.has(chat.id) || currentChat.value?.id === chat.id) {
        await saveChatMeta(chat);
        await loadData();
      }

      if (chat.title === null && settings.value.autoTitleEnabled && (activeGenerations.has(chat.id) || currentChat.value?.id === chat.id)) {
        await generateChatTitle(chat, controller.signal);
      }
    } catch (e) {
      if ((e as Error).name === 'AbortError') assistantNode.content += '\n\n[Generation Aborted]';
      else {
        assistantNode.error = (e as Error).message;
        if (currentChat.value?.id !== chat.id) {
          try {
            const { useToast } = await import('./useToast');
            const { addToast } = useToast();
            addToast({ message: `Generation failed in "${chat.title || 'New Chat'}"`, actionLabel: 'View', onAction: () => openChat(chat.id), });
          } catch (toastErr) {
            // Ignore toast errors if component is being unmounted
          }
        }
      }
    } finally {
      const isStillActive = activeGenerations.has(chat.id);
      if (isStillActive) {
        await saveChatMeta(chat);
        activeGenerations.delete(chat.id);
        unregisterLiveInstance(chat.id);
      }
    }
  };

  const sendMessage = async (content: string, parentId?: string | null, attachments: Attachment[] = [], chatTarget?: Chat): Promise<boolean> => {
    const chat = chatTarget || currentChat.value;
    if (!chat || activeGenerations.has(chat.id) || activeProcessing.has(chat.id)) return false;
    activeProcessing.add(chat.id);
    registerLiveInstance(chat);

    try {
      const { isOnboardingDismissed, onboardingDraft, settings: globalSettings } = useSettings();
      const { showConfirm } = useConfirm();
      const resolved = resolveChatSettings(chat, chatGroups.value, settings.value);
      const type = resolved.endpointType;
      const url = resolved.endpointUrl;
      let resolvedModel = chat.modelId || resolved.modelId;

      if (url) {
        const models = await fetchAvailableModels(chat);
        if (models.length > 0) {
          const preferredModel = chat.modelId || resolved.modelId;
          if (preferredModel && models.includes(preferredModel)) resolvedModel = preferredModel;
          else if (preferredModel) resolvedModel = models[0] || '';
        }
      }

      if (!url || !resolvedModel) {
        const models = await fetchAvailableModels(chat);
        onboardingDraft.value = { url, type, models, selectedModel: models[0] || '', };
        isOnboardingDismissed.value = false;
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
        globalSettings.value.heavyContentAlertDismissed = true;
      }

      for (const att of attachments) {
        if (att.status === 'memory') {
          if (canPersist) {
            try {
              await storageService.saveFile(att.blob, att.id, att.originalName);
              processedAttachments.push({ id: att.id, originalName: att.originalName, mimeType: att.mimeType, size: att.size, uploadedAt: att.uploadedAt, status: 'persisted', });
            } catch (e) { processedAttachments.push(att); }
          } else processedAttachments.push(att);
        } else processedAttachments.push(att);
      }

      const userMsg: MessageNode = { id: uuidv7(), role: 'user', content, attachments: processedAttachments.length > 0 ? processedAttachments : undefined, timestamp: Date.now(), replies: { items: [] }, };
      const assistantMsg: MessageNode = { id: uuidv7(), role: 'assistant', content: '', timestamp: Date.now(), modelId: resolvedModel, replies: { items: [] }, };
      userMsg.replies.items.push(assistantMsg);

      if (parentId === null) chat.root.items.push(userMsg);
      else {
        const pId = parentId || chat.currentLeafId;
        const parentNode = pId ? findNodeInBranch(chat.root.items, pId) : null;
        if (parentNode) parentNode.replies.items.push(userMsg);
        else chat.root.items.push(userMsg);
      }

      chat.currentLeafId = assistantMsg.id;
      if (currentChat.value?.id === chat.id) triggerRef(currentChat);
      await saveChatContent(chat);
      await saveChatMeta(chat);
      await generateResponse(chat, assistantMsg.id);
      return true;
    } finally {
      activeProcessing.delete(chat.id);
      unregisterLiveInstance(chat.id);
    }
  };

  const regenerateMessage = async (failedMessageId: string) => {
    const chat = currentChat.value;
    if (!chat || activeGenerations.has(chat.id)) return; 
    activeProcessing.add(chat.id);
    registerLiveInstance(chat);
    try {
      const failedNode = findNodeInBranch(chat.root.items, failedMessageId);
      if (!failedNode || failedNode.role !== 'assistant') return;
      const parent = findParentInBranch(chat.root.items, failedMessageId);
      if (!parent || parent.role !== 'user') return;
      const newAssistantMsg: MessageNode = { id: uuidv7(), role: 'assistant', content: '', timestamp: Date.now(), modelId: failedNode.modelId, replies: { items: [] }, };
      parent.replies.items.push(newAssistantMsg);
      chat.currentLeafId = newAssistantMsg.id;
      if (currentChat.value?.id === chat.id) triggerRef(currentChat);
      await saveChatContent(chat);
      await saveChatMeta(chat);
      await generateResponse(chat, newAssistantMsg.id);
    } finally {
      activeProcessing.delete(chat.id); unregisterLiveInstance(chat.id);
    }
  };

  const generateChatTitle = async (chat: Chat, signal?: AbortSignal) => {
    const taskId = chat.id;
    activeTitleGenerations.add(taskId);
    registerLiveInstance(chat);
    const resolved = resolveChatSettings(chat, chatGroups.value, settings.value);
    if (!resolved.endpointUrl) { activeTitleGenerations.delete(taskId); unregisterLiveInstance(taskId); return; }
    const history = getChatBranch(chat);
    const content = history[0]?.content || '';
    if (!content || typeof content !== 'string') { activeTitleGenerations.delete(taskId); unregisterLiveInstance(taskId); return; }
    const hadTitleAtStart = chat.title !== null;
    try {
      let generatedTitle = '';
      const titleProvider = resolved.endpointType === 'ollama' ? new OllamaProvider() : new OpenAIProvider();
      const titleGenModel = settings.value.titleModelId || history[history.length - 1]?.modelId || resolved.modelId;
      if (!titleGenModel) return;
      const promptMsg: ChatMessage = { role: 'user', content: `Generate a concise title... Message: "${content}"`, };
      await titleProvider.chat([promptMsg], titleGenModel, resolved.endpointUrl, (chunk) => { generatedTitle += chunk; }, {}, resolved.endpointHttpHeaders, signal);
      const finalTitle = generatedTitle.trim().replace(/^["']|["']$/g, '');
      if (finalTitle && (hadTitleAtStart || chat.title === null)) {
        chat.title = finalTitle;
        if (activeGenerations.has(chat.id) || currentChat.value?.id === chat.id || liveChatRegistry.has(chat.id)) {
          await saveChatMeta(chat);
          await loadData();
          if (currentChat.value?.id === chat.id) triggerRef(currentChat);
        }
      }
    } finally { activeTitleGenerations.delete(taskId); unregisterLiveInstance(taskId); }
  };

  const abortChat = () => {
    if (currentChat.value && activeGenerations.has(currentChat.value.id)) {
      activeGenerations.get(currentChat.value.id)?.controller.abort();
      activeGenerations.delete(currentChat.value.id);
    }
  };

  const forkChat = async (chat: Chat, messageId: string): Promise<string | null> => {
    const path = getChatBranch(chat);
    const idx = path.findIndex(m => m.id === messageId);
    if (idx === -1) return null;
    const forkPath = path.slice(0, idx + 1);
    const clonedNodes: MessageNode[] = forkPath.map(n => ({ id: n.id, role: n.role, content: n.content, attachments: n.attachments, timestamp: n.timestamp, thinking: n.thinking, error: n.error, modelId: n.modelId, replies: { items: [] }, }));
    for (let i = 0; i < clonedNodes.length - 1; i++) clonedNodes[i]!.replies.items.push(clonedNodes[i+1]!);
    const newChatId = uuidv7();
    try {
      const newChatObj: Chat = reactive({ 
        ...chat, 
        id: newChatId, 
        title: `Fork of ${chat.title}`, 
        root: { items: [clonedNodes[0]!] }, 
        currentLeafId: clonedNodes[clonedNodes.length - 1]?.id, 
        originChatId: chat.id, 
        originMessageId: messageId, 
        createdAt: Date.now(), 
        updatedAt: Date.now(),
        modelId: chat.modelId, // Explicitly carry over modelId
      });
      registerLiveInstance(newChatObj);
      await saveChatContent(newChatObj);
      await saveChatMeta(newChatObj);
      await storageService.updateHierarchy((curr) => {
        const node: HierarchyNode = { type: 'chat', id: newChatId };
        const chatGroupId = chat.groupId;

        if (chatGroupId) {
          const group = curr.items.find(i => i.type === 'chat_group' && i.id === chatGroupId) as HierarchyChatGroupNode;
          if (group) {
            group.chat_ids.unshift(newChatId);
            return curr;
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
    } finally { unregisterLiveInstance(newChatId); }
  };

  const editMessage = async (messageId: string, newContent: string) => {
    const chat = currentChat.value; if (!chat) return;
    const node = findNodeInBranch(chat.root.items, messageId); if (!node) return;
    if (node.role === 'assistant') {
      const correctedNode: MessageNode = { id: uuidv7(), role: 'assistant', content: newContent, attachments: node.attachments, timestamp: Date.now(), modelId: node.modelId, replies: { items: [] }, };
      const parent = findParentInBranch(chat.root.items, messageId);
      if (parent) parent.replies.items.push(correctedNode);
      else chat.root.items.push(correctedNode);
      chat.currentLeafId = correctedNode.id;
      await saveChatContent(chat);
      if (currentChat.value?.id === chat.id) triggerRef(currentChat);
    } else {
      const parent = findParentInBranch(chat.root.items, messageId);
      await sendMessage(newContent, parent ? parent.id : null, node.attachments, chat);
    }
  };

  const switchVersion = async (messageId: string) => {
    const chat = currentChat.value; if (!chat) return;
    const node = findNodeInBranch(chat.root.items, messageId);
    if (node) {
      chat.currentLeafId = findDeepestLeaf(node).id;
      if (currentChat.value?.id === chat.id) triggerRef(currentChat);
      await saveChatContent(chat);
    }
  };

  const getSiblings = (chat: Chat, messageId: string): MessageNode[] => {
    if (chat.root.items.some(m => m.id === messageId)) return chat.root.items;
    const parent = findParentInBranch(chat.root.items, messageId);
    return parent ? parent.replies.items : [];
  };

  const toggleDebug = async () => {
    const chat = currentChat.value; if (!chat) return;
    chat.debugEnabled = !chat.debugEnabled;
    if (currentChat.value?.id === chat.id) triggerRef(currentChat);
    await saveChatMeta(chat);
  };

  const createChatGroup = async (name: string) => {
    const id = uuidv7();
    const newGroup: ChatGroup = { id, name, updatedAt: Date.now(), isCollapsed: false, items: [], };
    await storageService.updateChatGroup(id, () => newGroup);
    await storageService.updateHierarchy((curr) => {
      curr.items.unshift({ type: 'chat_group', id, chat_ids: [] });
      return curr;
    });
    await loadData();
    return id;
  };

  const deleteChatGroup = async (id: string) => {
    const group = chatGroups.value.find(g => g.id === id);
    if (!group) return;
    const items = [...group.items];
    for (const item of items) if (item.type === 'chat') await deleteChat(item.chat.id, () => '');
    if (currentChatGroup.value?.id === id) currentChatGroup.value = null;
    await storageService.deleteChatGroup(id);
    await storageService.updateHierarchy((curr) => {
      curr.items = curr.items.filter(i => i.type !== 'chat_group' || i.id !== id);
      return curr;
    });
    await loadData();
  };

  const toggleChatGroupCollapse = async (groupId: string) => {
    await storageService.updateChatGroup(groupId, (chatGroup) => {
      if (!chatGroup) throw new Error('Chat group not found');
      chatGroup.isCollapsed = !chatGroup.isCollapsed;
      return chatGroup;
    });
  };

  const renameChatGroup = async (groupId: string, newName: string) => {
    await storageService.updateChatGroup(groupId, (chatGroup) => {
      if (!chatGroup) throw new Error('Chat group not found');
      chatGroup.name = newName; 
      chatGroup.updatedAt = Date.now();
      return chatGroup;
    });
    await loadData();
  };

  const updateChatGroup = async (id: string, updater: (current: ChatGroup | null) => ChatGroup | Promise<ChatGroup>) => {
    await storageService.updateChatGroup(id, updater);
  };

  const persistSidebarStructure = async (topLevelItems: SidebarItem[]) => {
    rootItems.value = topLevelItems;
    syncLiveInstancesWithSidebar();
    
    const newHierarchy: Hierarchy = {
      items: topLevelItems.map(item => {
        if (item.type === 'chat') return { type: 'chat', id: item.chat.id };
        else return { type: 'chat_group', id: item.chatGroup.id, chat_ids: item.chatGroup.items.map(i => i.id.replace('chat:', '')) };
      })
    };
    await storageService.updateHierarchy(() => newHierarchy);
  };

  const moveChatToGroup = async (chatId: string, targetGroupId: string | null) => {
    await storageService.updateHierarchy((curr) => {
      const node: HierarchyNode = { type: 'chat', id: chatId };
      curr.items = curr.items.filter(i => {
        if (i.type === 'chat' && i.id === chatId) return false;
        if (i.type === 'chat_group') i.chat_ids = i.chat_ids.filter(id => id !== chatId);
        return true;
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
    if (currentChat.value?.id === chatId) { currentChat.value.groupId = targetGroupId; triggerRef(currentChat); }
    await loadData();
  };

  const saveChat = async (chat: Chat) => {
    await saveChatContent(chat);
    await saveChatMeta(chat);
  };

  return {
    rootItems, chats, chatGroups, sidebarItems, currentChat, currentChatGroup, resolvedSettings, inheritedSettings, activeMessages, streaming, activeGenerations, generatingTitle, availableModels, fetchingModels,
    loadChats: loadData, fetchAvailableModels, createNewChat, openChat, openChatGroup, deleteChat, deleteAllChats, renameChat, generateChatTitle, sendMessage, regenerateMessage, forkChat, editMessage, switchVersion, getSiblings, toggleDebug, createChatGroup, deleteChatGroup, toggleChatGroupCollapse, renameChatGroup, persistSidebarStructure, updateChatGroup, abortChat, saveChatMeta, saveChatContent, moveChatToGroup, saveChat,
  };
}