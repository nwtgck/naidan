import { ref, computed, shallowRef, reactive, triggerRef } from 'vue';
import { v7 as uuidv7 } from 'uuid';
import type { Chat, MessageNode, ChatGroup, SidebarItem, ChatSummary } from '../models/types';
import { storageService } from '../services/storage';
import { OpenAIProvider, OllamaProvider } from '../services/llm';
import { useSettings } from './useSettings';

const rootItems = ref<SidebarItem[]>([]);
const currentChat = shallowRef<Chat | null>(null);
const streaming = ref(false);
const availableModels = ref<string[]>([]);
const fetchingModels = ref(false);
let abortController: AbortController | null = null;

// --- Helpers ---

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

export function processThinking(node: MessageNode) {
  const thinkRegex = /<think>([\s\S]*?)<\/think>/;
  const match = node.content.match(thinkRegex);
  if (match && match[1]) {
    node.thinking = match[1].trim();
    node.content = node.content.replace(thinkRegex, '').trim();
  }
}

/**
 * Calculates the best restoration index for a deleted item based on its bidirectional context.
 */
export function findRestorationIndex(
  items: SidebarItem[],
  prevId: string | null,
  nextId: string | null,
): number {
  if (items.length === 0) return 0;

  const prevIdx = prevId ? items.findIndex(item => item.id === prevId) : -1;
  if (prevIdx !== -1) {
    // Priority 1: Right after the previous item
    return prevIdx + 1;
  }

  const nextIdx = nextId ? items.findIndex(item => item.id === nextId) : -1;
  if (nextIdx !== -1) {
    // Priority 2: Right before the next item
    return nextIdx;
  }

  // Priority 3: Default to top
  return 0;
}

export interface AddToastOptions {
  message: string;
  actionLabel?: string;
  onAction?: () => void | Promise<void>;
  duration?: number;
}

export function useChat() {
  const { settings } = useSettings();

  /**
   * Helper to find the correct relative index for a chat within its hierarchy.
   * This ensures we persist the order correctly relative to its siblings.
   */
  function findChatPosition(chatId: string): { index: number } {
    // 1. Check root level
    const rootIdx = rootItems.value.findIndex(item => item.type === 'chat' && item.chat.id === chatId);
    if (rootIdx !== -1) return { index: rootIdx };

    // 2. Check inside groups
    for (const item of rootItems.value) {
      if (item.type === 'group') {
        const nestedIdx = item.group.items.findIndex(n => n.type === 'chat' && n.chat.id === chatId);
        if (nestedIdx !== -1) return { index: nestedIdx };
      }
    }
    
    return { index: 0 };
  }

  const sidebarItems = computed(() => rootItems.value);

  const chats = computed(() => {
    const all: ChatSummary[] = [];
    const collect = (items: SidebarItem[]) => {
      items.forEach(item => {
        if (item.type === 'chat') all.push(item.chat);
        else collect(item.group.items);
      });
    };
    collect(rootItems.value);
    return all;
  });

  const groups = computed(() => {
    const all: ChatGroup[] = [];
    rootItems.value.forEach(item => {
      if (item.type === 'group') all.push(item.group);
    });
    return all;
  });

  const activeMessages = computed(() => {
    if (!currentChat.value || currentChat.value.root.items.length === 0) return [];
    const path: MessageNode[] = [];
    const targetId = currentChat.value.currentLeafId;
    let curr: MessageNode | null = currentChat.value.root.items.find(item => 
      item.id === targetId || findNodeInBranch(item.replies.items, targetId || ''),
    ) || currentChat.value.root.items[currentChat.value.root.items.length - 1] || null;

    while (curr) {
      path.push(curr);
      if (curr.id === targetId) break;
      const next: MessageNode | undefined = curr.replies.items.find(item => 
        item.id === targetId || findNodeInBranch(item.replies.items, targetId || ''),
      ) || curr.replies.items[curr.replies.items.length - 1];
      curr = next || null;
    }
    return path;
  });

  const loadData = async () => {
    rootItems.value = await storageService.getSidebarStructure();
  };

  const fetchAvailableModels = async () => {
    const type = currentChat.value?.endpointType || settings.value.endpointType;
    const url = currentChat.value?.endpointUrl || settings.value.endpointUrl || '';
    if (!url) return [];
    
    fetchingModels.value = true;
    try {
      const provider = type === 'ollama' ? new OllamaProvider() : new OpenAIProvider();
      const models = await provider.listModels(url);
      const result = Array.isArray(models) ? models : [];
      availableModels.value = result;
      return result;
    } catch (e) {
      console.warn('Failed to fetch models for resolution:', e);
      return [];
    } finally {
      fetchingModels.value = false;
    }
  };

  const saveCurrentChat = async () => {
    if (!currentChat.value) return;
    // CRITICAL: Find the correct relative index to avoid "jumping"
    const { index } = findChatPosition(currentChat.value.id);
    await storageService.saveChat(currentChat.value, index);
  };

  const createNewChat = async (groupId: string | null = null) => {
    const chatObj: Chat = {
      id: uuidv7(),
      title: null,
      groupId,
      root: { items: [] },
      modelId: '', // Default to empty to follow global settings
      createdAt: Date.now(),
      updatedAt: Date.now(),
      debugEnabled: false,
    };
    
    // Initial save
    await storageService.saveChat(chatObj, 0);
    currentChat.value = reactive(chatObj);

    const newRootItems = JSON.parse(JSON.stringify(rootItems.value)) as SidebarItem[];
    const newSummary: ChatSummary = { id: chatObj.id, title: chatObj.title, updatedAt: chatObj.updatedAt, groupId: chatObj.groupId };
    const newSidebarItem: SidebarItem = { id: `chat:${chatObj.id}`, type: 'chat', chat: newSummary };

    if (groupId) {
      const findAndAdd = (items: SidebarItem[]) => {
        for (const item of items) {
          if (item.type === 'group' && item.group.id === groupId) {
            item.group.items.unshift(newSidebarItem);
            return true;
          }
          if (item.type === 'group' && findAndAdd(item.group.items)) return true;
        }
        return false;
      };
      findAndAdd(newRootItems);
    } else {
      const firstChatIdx = newRootItems.findIndex(item => item.type === 'chat');
      const insertIdx = firstChatIdx !== -1 ? firstChatIdx : newRootItems.length;
      newRootItems.splice(insertIdx, 0, newSidebarItem);
    }

    await persistSidebarStructure(newRootItems);
    await loadData();
  };

  const openChat = async (id: string) => {
    const loaded = await storageService.loadChat(id);
    if (loaded) {
      currentChat.value = reactive(loaded);
    } else {
      currentChat.value = null;
    }
  };

  const deleteChat = async (
    id: string, 
    injectAddToast?: (toast: AddToastOptions) => string,
  ) => {
    const { useToast } = await import('./useToast');
    const { addToast: originalAddToast } = useToast();
    const addToast = injectAddToast || originalAddToast;
    const chatData = await storageService.loadChat(id);
    if (!chatData) return;

    // Capture bidirectional context for robust restoration
    let parentId: string | null = null;
    let prevId: string | null = null;
    let nextId: string | null = null;

    // Search for current position in sidebarItems
    const findContext = (items: SidebarItem[], pId: string | null): boolean => {
      const idx = items.findIndex(item => item.type === 'chat' && item.chat.id === id);
      if (idx !== -1) {
        parentId = pId;
        prevId = idx > 0 ? items[idx - 1]!.id : null;
        nextId = idx < items.length - 1 ? items[idx + 1]!.id : null;
        return true;
      }
      for (const item of items) {
        if (item.type === 'group' && findContext(item.group.items, item.group.id)) return true;
      }
      return false;
    };
    findContext(rootItems.value, null);

    await storageService.deleteChat(id);
    if (currentChat.value?.id === id) currentChat.value = null;
    await loadData();

    addToast({
      message: `Chat "${chatData.title || 'Untitled'}" deleted`,
      actionLabel: 'Undo',
      onAction: async () => {
        let targetIndex = 0;
        let targetList: SidebarItem[] | null = null;

        if (parentId) {
          // Robustly find the group in the latest rootItems
          const groupItem = rootItems.value.find(item => item.type === 'group' && item.group.id === parentId);
          if (groupItem && groupItem.type === 'group') {
            targetList = groupItem.group.items;
          }
        } else {
          targetList = rootItems.value;
        }

        // If targetList is still null (e.g. parent group was also deleted), fallback to rootItems
        const finalTargetList = targetList || rootItems.value;
        targetIndex = findRestorationIndex(finalTargetList, prevId, nextId);

        chatData.groupId = targetList ? parentId : null;
        await storageService.saveChat(chatData, targetIndex);
        await loadData();
        await openChat(chatData.id);
      },
    });
  };

  const deleteAllChats = async () => {
    const { isOnboardingDismissed } = useSettings();
    const all = await storageService.listChats();
    for (const c of all) await storageService.deleteChat(c.id);
    const allGroups = await storageService.listGroups();
    for (const g of allGroups) await storageService.deleteGroup(g.id);
    currentChat.value = null;
    isOnboardingDismissed.value = false;
    await loadData();
  };

  const renameChat = async (id: string, newTitle: string) => {
    const chat = await storageService.loadChat(id);
    if (chat) {
      chat.title = newTitle;
      chat.updatedAt = Date.now();
      const { index } = findChatPosition(id);
      await storageService.saveChat(chat, index);
      if (currentChat.value?.id === id) {
        currentChat.value.title = newTitle;
        currentChat.value.updatedAt = chat.updatedAt;
        triggerRef(currentChat);
      }
      await loadData();
    }
  };

  const sendMessage = async (content: string, parentId?: string | null) => {
    if (!currentChat.value || streaming.value) return;

    const { isOnboardingDismissed, onboardingDraft } = useSettings();

    // Determine the intended model early
    const type = currentChat.value.endpointType || settings.value.endpointType;
    const url = currentChat.value.endpointUrl || settings.value.endpointUrl || '';
    const baseModel = currentChat.value.overrideModelId || settings.value.defaultModelId || currentChat.value.modelId;
    
    if (!url) {
      isOnboardingDismissed.value = false;
      return;
    }

    if (!baseModel) {
      // If we have a URL but no model, try to fetch models to help with onboarding model selection
      const models = await fetchAvailableModels();
      if (models.length > 0) {
        onboardingDraft.value = {
          url,
          type,
          models,
          selectedModel: models[0] || '',
        };
      }
      isOnboardingDismissed.value = false;
      return;
    }

    // Dynamic Model Resolution:
    let resolvedModel = baseModel;
    const available = await fetchAvailableModels();
    if (available.length > 0 && !available.includes(baseModel)) {
      if (settings.value.defaultModelId && available.includes(settings.value.defaultModelId)) {
        resolvedModel = settings.value.defaultModelId;
      } else {
        resolvedModel = available[0] || baseModel;
      }
    }

    const userMsg: MessageNode = {
      id: uuidv7(),
      role: 'user',
      content,
      timestamp: Date.now(),
      replies: { items: [] },
    };

    const assistantMsg: MessageNode = {
      id: uuidv7(),
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
      modelId: resolvedModel,
      replies: { items: [] },
    };
    userMsg.replies.items.push(assistantMsg);

    if (parentId === null) {
      currentChat.value.root.items.push(userMsg);
    } else {
      const pId = parentId || currentChat.value.currentLeafId;
      const parentNode = pId ? findNodeInBranch(currentChat.value.root.items, pId) : null;
      if (parentNode) parentNode.replies.items.push(userMsg);
      else currentChat.value.root.items.push(userMsg);
    }

    currentChat.value.currentLeafId = assistantMsg.id;
    triggerRef(currentChat);
    await saveCurrentChat();

    const assistantNode = findNodeInBranch(currentChat.value.root.items, assistantMsg.id);
    if (!assistantNode) throw new Error('Assistant node not found');

    streaming.value = true;
    abortController = new AbortController();
    try {
      const provider = type === 'ollama' ? new OllamaProvider() : new OpenAIProvider();

      await provider.chat(activeMessages.value.filter(m => m.id !== assistantMsg.id), resolvedModel, url, (chunk) => {
        assistantNode.content += chunk;
        triggerRef(currentChat);
      }, abortController.signal);

      processThinking(assistantNode);
      currentChat.value.updatedAt = Date.now();
      await saveCurrentChat();
      await loadData();

      if (currentChat.value.title === null && settings.value.autoTitleEnabled) {
        const chatIdAtStart = currentChat.value.id;
        try {
          let generatedTitle = '';
          const titleProvider = type === 'ollama' ? new OllamaProvider() : new OpenAIProvider();
          const titleGenModel = settings.value.titleModelId || resolvedModel;
          const promptNode: MessageNode = {
            id: uuidv7(), role: 'user', timestamp: Date.now(), replies: { items: [] },
            content: `Generate a short title (2-3 words) for: "${content}". Respond ONLY with the title.`,
          };
          await titleProvider.chat([promptNode], titleGenModel, url, (chunk) => { generatedTitle += chunk; });
          const finalTitle = generatedTitle.trim().replace(/^["']|["']$/g, '');
          if (finalTitle && currentChat.value?.id === chatIdAtStart && currentChat.value.title === null) {
            currentChat.value.title = finalTitle;
            await saveCurrentChat();
            await loadData();
          }
        } catch (_e) { /* ignore */ }
      }
    } catch (e) {
      if ((e as Error).name === 'AbortError') {
        assistantNode.content += '\n\n[Generation Aborted]';
      } else {
        assistantNode.content += '\n\n[Error: ' + (e as Error).message + ']';
      }
      console.error(e);
    } finally {
      streaming.value = false;
      abortController = null;
      await saveCurrentChat();
    }
  };

  const abortChat = () => {
    if (abortController) {
      abortController.abort();
      abortController = null;
      streaming.value = false;
    }
  };

  const forkChat = async (messageId: string): Promise<string | null> => {
    if (!currentChat.value) return null;
    const path = activeMessages.value;
    const idx = path.findIndex(m => m.id === messageId);
    if (idx === -1) return null;
    const forkPath = path.slice(0, idx + 1);

    const clonedNodes: MessageNode[] = forkPath.map(n => ({
      id: n.id, role: n.role, content: n.content, timestamp: n.timestamp, thinking: n.thinking, replies: { items: [] },
    }));

    for (let i = 0; i < clonedNodes.length - 1; i++) {
      clonedNodes[i]!.replies.items.push(clonedNodes[i+1]!);
    }

    const newChatObj: Chat = {
      ...currentChat.value,
      id: uuidv7(),
      title: `Fork of ${currentChat.value.title}`,
      root: { items: [clonedNodes[0]!] },
      currentLeafId: clonedNodes[clonedNodes.length - 1]?.id,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    await storageService.saveChat(newChatObj, 0);
    const originalIdx = rootItems.value.findIndex(item => item.type === 'chat' && item.chat.id === currentChat.value?.id);
    const newRootItems = [...rootItems.value];
    newRootItems.splice(originalIdx + 1, 0, { id: `chat:${newChatObj.id}`, type: 'chat', chat: { id: newChatObj.id, title: newChatObj.title, updatedAt: newChatObj.updatedAt, groupId: newChatObj.groupId } });
    
    await persistSidebarStructure(newRootItems);
    await loadData();
    await openChat(newChatObj.id);
    return newChatObj.id;
  };

  const editMessage = async (messageId: string, newContent: string) => {
    if (!currentChat.value) return;
    const node = findNodeInBranch(currentChat.value.root.items, messageId);
    if (!node) return;

    if (node.role === 'assistant') {
      const correctedNode: MessageNode = {
        id: uuidv7(), 
        role: 'assistant', 
        content: newContent, 
        timestamp: Date.now(), 
        modelId: node.modelId,
        replies: { items: [] },
      };
      const parent = findParentInBranch(currentChat.value.root.items, messageId);
      if (parent) parent.replies.items.push(correctedNode);
      else currentChat.value.root.items.push(correctedNode);
      currentChat.value.currentLeafId = correctedNode.id;
      await saveCurrentChat();
      triggerRef(currentChat);
    } else {
      const parent = findParentInBranch(currentChat.value.root.items, messageId);
      await sendMessage(newContent, parent ? parent.id : null);
    }
  };

  const switchVersion = async (messageId: string) => {
    if (!currentChat.value) return;
    const node = findNodeInBranch(currentChat.value.root.items, messageId);
    if (node) {
      currentChat.value.currentLeafId = findDeepestLeaf(node).id;
      triggerRef(currentChat);
      await saveCurrentChat();
    }
  };

  const getSiblings = (messageId: string): MessageNode[] => {
    if (!currentChat.value) return [];
    if (currentChat.value.root.items.some(m => m.id === messageId)) return currentChat.value.root.items;
    const parent = findParentInBranch(currentChat.value.root.items, messageId);
    return parent ? parent.replies.items : [];
  };

  const toggleDebug = async () => {
    if (!currentChat.value) return;
    currentChat.value.debugEnabled = !currentChat.value.debugEnabled;
    triggerRef(currentChat);
    await saveCurrentChat();
  };

  const createGroup = async (name: string) => {
    const newGroup: ChatGroup = {
      id: uuidv7(), name, updatedAt: Date.now(), isCollapsed: false, items: [],
    };
    const newRootItems = [{ id: `group:${newGroup.id}`, type: 'group' as const, group: newGroup }, ...rootItems.value];
    await persistSidebarStructure(newRootItems);
    await loadData();
  };

  const deleteGroup = async (id: string) => {
    await storageService.deleteGroup(id);
    await loadData();
  };

  const toggleGroupCollapse = async (groupId: string) => {
    const group = groups.value.find(g => g.id === groupId);
    if (group) {
      group.isCollapsed = !group.isCollapsed;
      await persistSidebarStructure(rootItems.value);
    }
  };

  const renameGroup = async (groupId: string, newName: string) => {
    const group = groups.value.find(g => g.id === groupId);
    if (group) {
      group.name = newName;
      group.updatedAt = Date.now();
      await persistSidebarStructure(rootItems.value);
      await loadData();
    }
  };

  const persistSidebarStructure = async (topLevelItems: SidebarItem[]) => {
    rootItems.value = topLevelItems;
    for (let i = 0; i < topLevelItems.length; i++) {
      const item = topLevelItems[i]!;
      if (item.type === 'group') {
        await storageService.saveGroup(item.group, i);
        for (let j = 0; j < item.group.items.length; j++) {
          const nested = item.group.items[j]!;
          if (nested.type === 'chat') {
            const chat = await storageService.loadChat(nested.chat.id);
            if (chat) {
              chat.groupId = item.group.id;
              await storageService.saveChat(chat, j);
            }
          }
        }
      } else {
        const chat = await storageService.loadChat(item.chat.id);
        if (chat) {
          chat.groupId = null;
          await storageService.saveChat(chat, i);
        }
      }
    }
  };

  return {
    // --- State & Getters ---
    rootItems,
    chats,
    groups,
    sidebarItems,
    currentChat,
    activeMessages,
    streaming,
    availableModels,
    fetchingModels,

    // --- Actions ---
    loadChats: loadData,
    fetchAvailableModels,
    createNewChat,
    openChat,
    deleteChat,
    deleteAllChats,
    renameChat,
    sendMessage,
    forkChat,
    editMessage,
    switchVersion,
    getSiblings,
    toggleDebug,
    createGroup,
    deleteGroup,
    toggleGroupCollapse,
    renameGroup,
    persistSidebarStructure,
    abortChat,
    saveCurrentChat,
  };
}
