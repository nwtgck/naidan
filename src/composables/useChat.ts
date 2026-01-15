import { ref, computed, shallowRef, reactive, triggerRef } from 'vue';
import { v7 as uuidv7 } from 'uuid';
import type { Chat, MessageNode, ChatGroup, SidebarItem, ChatSummary, Attachment, MultimodalContent, ChatMessage } from '../models/types';
import { storageService } from '../services/storage';
import { OpenAIProvider, OllamaProvider } from '../services/llm';
import { useSettings } from './useSettings';
import { useConfirm } from './useConfirm';

const rootItems = ref<SidebarItem[]>([]);
const currentChat = shallowRef<Chat | null>(null);
const streaming = ref(false);
const generatingTitle = ref(false);
const availableModels = ref<string[]>([]);
const fetchingModels = ref(false);
let abortController: AbortController | null = null;

// --- Helpers ---

async function fileToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
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

export function processThinking(node: MessageNode) {
  const thinkRegex = /<think>([\s\S]*?)<\/think>/gi;
  const matches = [...node.content.matchAll(thinkRegex)];
  
  if (matches.length > 0) {
    const thoughts = matches.map(m => m[1]?.trim()).filter(Boolean).join('\n\n---\n\n');
    node.thinking = node.thinking ? `${node.thinking}\n\n---\n\n${thoughts}` : thoughts;
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

    // 2. Check inside chat groups
    for (const item of rootItems.value) {
      if (item.type === 'chat_group') {
        const nestedIdx = item.chatGroup.items.findIndex(n => n.type === 'chat' && n.chat.id === chatId);
        if (nestedIdx !== -1) return { index: nestedIdx };
      }
    }
    
    return { index: 0 };
  }

  const sidebarItems = computed(() => rootItems.value);

  const insertSidebarItem = (rootItems: SidebarItem[], newItem: SidebarItem, chatGroupId: string | null) => {
    if (chatGroupId) {
      const findAndAdd = (items: SidebarItem[]) => {
        for (const item of items) {
          if (item.type === 'chat_group' && item.chatGroup.id === chatGroupId) {
            item.chatGroup.items.unshift(newItem);
            return true;
          }
          if (item.type === 'chat_group' && findAndAdd(item.chatGroup.items)) return true;
        }
        return false;
      };
      findAndAdd(rootItems);
    } else {
      const firstChatIdx = rootItems.findIndex(item => item.type === 'chat');
      const insertIdx = firstChatIdx !== -1 ? firstChatIdx : rootItems.length;
      rootItems.splice(insertIdx, 0, newItem);
    }
  };

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
    rootItems.value.forEach(item => {
      if (item.type === 'chat_group') all.push(item.chatGroup);
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

  const createNewChat = async (chatGroupId: string | null = null) => {
    const chatObj: Chat = {
      id: uuidv7(),
      title: null,
      groupId: chatGroupId,
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

    insertSidebarItem(newRootItems, newSidebarItem, chatGroupId);

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
        if (item.type === 'chat_group' && findContext(item.chatGroup.items, item.chatGroup.id)) return true;
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
          // Robustly find the chat group in the latest rootItems
          const groupItem = rootItems.value.find(item => item.type === 'chat_group' && item.chatGroup.id === parentId);
          if (groupItem && groupItem.type === 'chat_group') {
            targetList = groupItem.chatGroup.items;
          }
        } else {
          targetList = rootItems.value;
        }

        // If targetList is still null (e.g. parent chat group was also deleted), fallback to rootItems
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
    const all = await storageService.listChats();
    for (const c of all) await storageService.deleteChat(c.id);
    const allGroups = await storageService.listChatGroups();
    for (const g of allGroups) await storageService.deleteChatGroup(g.id);
    currentChat.value = null;
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

  const generateResponse = async (assistantId: string) => {
    if (!currentChat.value) return;
    
    const assistantNode = findNodeInBranch(currentChat.value.root.items, assistantId);
    if (!assistantNode) throw new Error('Assistant node not found');

    // Reset error
    assistantNode.error = undefined;
    triggerRef(currentChat);

    streaming.value = true;
    abortController = new AbortController();

    const type = currentChat.value.endpointType || settings.value.endpointType;
    const url = currentChat.value.endpointUrl || settings.value.endpointUrl || '';
    const resolvedModel = assistantNode.modelId || '';

    try {
      const provider = type === 'ollama' ? new OllamaProvider() : new OpenAIProvider();

      // --- Resolve System Prompt & Parameters ---
      const activeProfile = (settings.value.providerProfiles || []).find(p => p.endpointUrl === url && p.endpointType === type);
      
      const globalSystemPrompt = activeProfile?.systemPrompt || settings.value.systemPrompt;
      const chatPromptObj = currentChat.value.systemPrompt;
      
      const finalMessages: ChatMessage[] = [];
      
      if (chatPromptObj) {
        if (chatPromptObj.behavior === 'append') {
          if (globalSystemPrompt) finalMessages.push({ role: 'system', content: globalSystemPrompt });
          if (chatPromptObj.content) finalMessages.push({ role: 'system', content: chatPromptObj.content });
        } else {
          // override
          if (chatPromptObj.content) {
            finalMessages.push({ role: 'system', content: chatPromptObj.content });
          } else if (globalSystemPrompt) {
            finalMessages.push({ role: 'system', content: globalSystemPrompt });
          }
        }
      } else if (globalSystemPrompt) {
        finalMessages.push({ role: 'system', content: globalSystemPrompt });
      }

      // Add conversation history
      const history = activeMessages.value.filter(m => m.id !== assistantId);
      for (const m of history) {
        if (m.attachments && m.attachments.length > 0) {
          const content: MultimodalContent[] = [{ type: 'text', text: m.content }];
          for (const att of m.attachments) {
            let blob: Blob | null = null;
            if (att.status === 'memory') {
              blob = att.blob;
            } else if (att.status === 'persisted') {
              blob = await storageService.getFile(att.id, att.originalName);
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

      // 2. Resolve LM Parameters (Deep Merge: Chat > Profile > Global)
      const resolvedParams = {
        ...(settings.value.lmParameters || {}),
        ...(activeProfile?.lmParameters || {}),
        ...(currentChat.value.lmParameters || {}),
      };

      await provider.chat(finalMessages, resolvedModel, url, (chunk) => {
        assistantNode.content += chunk;
        triggerRef(currentChat);
      }, resolvedParams, abortController.signal);

      processThinking(assistantNode);
      currentChat.value.updatedAt = Date.now();
      await saveCurrentChat();
      await loadData();

      if (currentChat.value.title === null && settings.value.autoTitleEnabled) {
        await generateChatTitle();
      }
    } catch (e) {
      if ((e as Error).name === 'AbortError') {
        assistantNode.content += '\n\n[Generation Aborted]';
      } else {
        assistantNode.error = (e as Error).message;
      }
      console.error(e);
    } finally {
      streaming.value = false;
      abortController = null;
      await saveCurrentChat();
    }
  };

  const sendMessage = async (content: string, parentId?: string | null, attachments: Attachment[] = []) => {
    if (!currentChat.value || streaming.value) return;

    const { isOnboardingDismissed, onboardingDraft, settings: globalSettings } = useSettings();
    const { showConfirm } = useConfirm();

    // --- Model & Endpoint Resolution ---
    const type = currentChat.value.endpointType || settings.value.endpointType;
    const url = currentChat.value.endpointUrl || settings.value.endpointUrl || '';
    
    let resolvedModel = currentChat.value.overrideModelId || settings.value.defaultModelId || '';

    if (url) {
      const models = await fetchAvailableModels();
      if (models.length > 0) {
        const preferredModel = currentChat.value.overrideModelId || settings.value.defaultModelId;
        if (preferredModel && models.includes(preferredModel)) {
          resolvedModel = preferredModel;
        } else if (preferredModel) {
          // If a preferred model was set but is not available, fallback to first
          resolvedModel = models[0] || '';
        }
        // If NO preferred model was set at all, resolvedModel remains '', triggering onboarding below
      }
    }

    if (!url || !resolvedModel) {
      const models = await fetchAvailableModels();
      onboardingDraft.value = { 
        url, 
        type, 
        models, 
        selectedModel: models[0] || '',
      };
      isOnboardingDismissed.value = false;
      return;
    }

    // Process attachments for saving
    const processedAttachments: Attachment[] = [];
    const canPersist = storageService.canPersistBinary;
    
    // Check if we need to ask for permission for LocalStorage persistence
    if (attachments.length > 0 && !canPersist && globalSettings.value.heavyContentAlertDismissed === false) {
      const confirmed = await showConfirm({
        title: 'Attachments cannot be saved',
        message: 'You are using Local Storage, which has a 5MB limit. Attachments will be available during this session but will NOT be saved to your history. Switch to OPFS storage in Settings to enable permanent saving.',
        confirmButtonText: 'Continue anyway',
        cancelButtonText: 'Cancel',
      });
      if (!confirmed) return;
      globalSettings.value.heavyContentAlertDismissed = true;
    }

    for (const att of attachments) {
      if (att.status === 'memory') {
        if (canPersist) {
          try {
            await storageService.saveFile(att.blob, att.id, att.originalName);
            processedAttachments.push({
              id: att.id,
              originalName: att.originalName,
              mimeType: att.mimeType,
              size: att.size,
              uploadedAt: att.uploadedAt,
              status: 'persisted',
            });
          } catch (e) {
            console.error('Failed to save file to OPFS:', e);
            processedAttachments.push(att); // keep as memory
          }
        } else {
          processedAttachments.push(att); // keep as memory (skipped from persistence by mapper)
        }
      } else {
        processedAttachments.push(att);
      }
    }

    const userMsg: MessageNode = {
      id: uuidv7(),
      role: 'user',
      content,
      attachments: processedAttachments.length > 0 ? processedAttachments : undefined,
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

    await generateResponse(assistantMsg.id);
  };

  const regenerateMessage = async (failedMessageId: string) => {
    if (!currentChat.value || streaming.value) return;
    
    // 1. Find the failed node
    const failedNode = findNodeInBranch(currentChat.value.root.items, failedMessageId);
    if (!failedNode || failedNode.role !== 'assistant') return;

    // 2. Find its parent (the User message)
    const parent = findParentInBranch(currentChat.value.root.items, failedMessageId);
    if (!parent || parent.role !== 'user') return;

    // 3. Create a NEW sibling assistant node
    const newAssistantMsg: MessageNode = {
      id: uuidv7(),
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
      modelId: failedNode.modelId, // Reuse the same model ID from the failed attempt
      replies: { items: [] },
    };

    // 4. Add to parent
    parent.replies.items.push(newAssistantMsg);

    // 5. Update state
    currentChat.value.currentLeafId = newAssistantMsg.id;
    triggerRef(currentChat);
    await saveCurrentChat();

    // 6. Generate
    await generateResponse(newAssistantMsg.id);
  };

  const generateChatTitle = async () => {
    if (!currentChat.value) return;
    const type = currentChat.value.endpointType || settings.value.endpointType;
    const url = currentChat.value.endpointUrl || settings.value.endpointUrl || '';
    if (!url) return;

    const history = activeMessages.value;
    const content = history[0]?.content || ''; // Use the first user message for title generation
    if (!content || typeof content !== 'string') return;

    const chatIdAtStart = currentChat.value.id;
    generatingTitle.value = true;
    try {
      let generatedTitle = '';
      const titleProvider = type === 'ollama' ? new OllamaProvider() : new OpenAIProvider();
      
      // Determine model to use for title generation
      let titleGenModel = settings.value.titleModelId;
      if (!titleGenModel) {
        // Fallback to current model of the last message or default
        const lastMsg = history[history.length - 1];
        titleGenModel = lastMsg?.modelId || settings.value.defaultModelId;
      }

      if (!titleGenModel) return;

      const promptMsg: ChatMessage = {
        role: 'user',
        content: `Generate a concise title (a short phrase) for this conversation based on the following message. The title MUST be in the same language as the message. Respond ONLY with the title text, no quotes or prefix.

Message: "${content}"`,
      };
      await titleProvider.chat([promptMsg], titleGenModel, url, (chunk) => { generatedTitle += chunk; });
      const finalTitle = generatedTitle.trim().replace(/^["']|["']$/g, '');
      
      if (finalTitle && currentChat.value?.id === chatIdAtStart) {
        currentChat.value.title = finalTitle;
        await saveCurrentChat();
        await loadData();
      }
    } catch (e) {
      console.warn('Failed to generate title:', e);
    } finally {
      generatingTitle.value = false;
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
      id: n.id, 
      role: n.role, 
      content: n.content, 
      attachments: n.attachments,
      timestamp: n.timestamp, 
      thinking: n.thinking,
      error: n.error,
      modelId: n.modelId,
      replies: { items: [] },
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
      originChatId: currentChat.value.id,
      originMessageId: messageId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    await storageService.saveChat(newChatObj, 0);
    const newRootItems = JSON.parse(JSON.stringify(rootItems.value)) as SidebarItem[];
    const newSummary: ChatSummary = { id: newChatObj.id, title: newChatObj.title, updatedAt: newChatObj.updatedAt, groupId: newChatObj.groupId };
    const newSidebarItem: SidebarItem = { id: `chat:${newChatObj.id}`, type: 'chat', chat: newSummary };

    insertSidebarItem(newRootItems, newSidebarItem, newChatObj.groupId ?? null);
    
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
        attachments: node.attachments,
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
      await sendMessage(newContent, parent ? parent.id : null, node.attachments);
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

  const createChatGroup = async (name: string) => {
    const newGroup: ChatGroup = {
      id: uuidv7(), name, updatedAt: Date.now(), isCollapsed: false, items: [],
    };
    const newRootItems = [{ id: `chat_group:${newGroup.id}`, type: 'chat_group' as const, chatGroup: newGroup }, ...rootItems.value];
    await persistSidebarStructure(newRootItems);
    await loadData();
  };

  const deleteChatGroup = async (id: string) => {
    await storageService.deleteChatGroup(id);
    await loadData();
  };

  const toggleChatGroupCollapse = async (groupId: string) => {
    const chatGroup = chatGroups.value.find(g => g.id === groupId);
    if (chatGroup) {
      chatGroup.isCollapsed = !chatGroup.isCollapsed;
      await persistSidebarStructure(rootItems.value);
    }
  };

  const renameChatGroup = async (groupId: string, newName: string) => {
    const chatGroup = chatGroups.value.find(g => g.id === groupId);
    if (chatGroup) {
      chatGroup.name = newName;
      chatGroup.updatedAt = Date.now();
      await persistSidebarStructure(rootItems.value);
      await loadData();
    }
  };

  const persistSidebarStructure = async (topLevelItems: SidebarItem[]) => {
    rootItems.value = topLevelItems;
    for (let i = 0; i < topLevelItems.length; i++) {
      const item = topLevelItems[i]!;
      if (item.type === 'chat_group') {
        await storageService.saveChatGroup(item.chatGroup, i);
        for (let j = 0; j < item.chatGroup.items.length; j++) {
          const nested = item.chatGroup.items[j]!;
          if (nested.type === 'chat') {
            const chat = await storageService.loadChat(nested.chat.id);
            if (chat) {
              chat.groupId = item.chatGroup.id;
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
    chatGroups,
    sidebarItems,
    currentChat,
    activeMessages,
    streaming,
    generatingTitle,
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
    generateChatTitle,
    sendMessage,
    regenerateMessage,
    forkChat,
    editMessage,
    switchVersion,
    getSiblings,
    toggleDebug,
    createChatGroup,
    deleteChatGroup,
    toggleChatGroupCollapse,
    renameChatGroup,
    persistSidebarStructure,
    abortChat,
    saveCurrentChat,
  };
}
