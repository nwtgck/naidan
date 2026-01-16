import { ref, computed, shallowRef, reactive, triggerRef } from 'vue';
import { v7 as uuidv7 } from 'uuid';
import type { Chat, MessageNode, ChatGroup, SidebarItem, ChatSummary, Attachment, MultimodalContent, ChatMessage } from '../models/types';
import { storageService } from '../services/storage';
import { OpenAIProvider, OllamaProvider } from '../services/llm';
import { useSettings } from './useSettings';
import { useConfirm } from './useConfirm';

const rootItems = ref<SidebarItem[]>([]);
const currentChat = shallowRef<Chat | null>(null);

// Registry for chats with active background tasks (streaming, titling, etc.)
// This ensures we keep the reactive instance alive and synchronized across the UI.
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
    // Abort all active generations on page unload to prevent orphaned requests
    for (const item of activeGenerations.values()) {
      item.controller.abort();
    }
  });
}

// --- Registry Helpers ---

function registerLiveInstance(chat: Chat) {
  liveChatRegistry.set(chat.id, chat);
}

function unregisterLiveInstance(chatId: string) {
  // Only remove if no tasks are pending for this chat
  const hasGeneration = activeGenerations.has(chatId);
  const hasTitleGen = activeTitleGenerations.has(chatId);
  const hasModelFetch = activeModelFetches.has(chatId);
  const hasProcessing = activeProcessing.has(chatId);
  
  if (!hasGeneration && !hasTitleGen && !hasModelFetch && !hasProcessing) {
    liveChatRegistry.delete(chatId);
  }
}

// --- Helpers ---

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
    if (!currentChat.value) return [];
    return getChatBranch(currentChat.value);
  });

  const loadData = async () => {
    rootItems.value = await storageService.getSidebarStructure();
  };

  const fetchAvailableModels = async (chat: Chat) => {
    const taskId = chat.id;
    activeModelFetches.add(taskId);
    registerLiveInstance(chat);
    
    const type = chat.endpointType || settings.value.endpointType;
    const url = chat.endpointUrl || settings.value.endpointUrl || '';
    if (!url) {
      activeModelFetches.delete(taskId);
      unregisterLiveInstance(taskId);
      return [];
    }
    
    try {
      const provider = type === 'ollama' ? new OllamaProvider() : new OpenAIProvider();
      const models = await provider.listModels(url);
      const result = Array.isArray(models) ? models : [];
      if (chat.id === currentChat.value?.id) {
        availableModels.value = result;
      }
      return result;
    } catch (e) {
      console.warn('Failed to fetch models for resolution:', e);
      return [];
    } finally {
      activeModelFetches.delete(taskId);
      unregisterLiveInstance(taskId);
    }
  };

  const saveChat = async (chat: Chat) => {
    // CRITICAL: Find the correct relative index to avoid "jumping"
    const { index } = findChatPosition(chat.id);
    await storageService.saveChat(chat, index);
  };

  const createNewChat = async (chatGroupId: string | null = null) => {
    if (creatingChat.value) return;
    creatingChat.value = true;
    const chatId = uuidv7();
    try {
      const chatObj: Chat = reactive({
        id: chatId,
        title: null,
        groupId: chatGroupId,
        root: { items: [] },
        modelId: '', // Default to empty to follow global settings
        createdAt: Date.now(),
        updatedAt: Date.now(),
        debugEnabled: false,
      });

      // Register immediately so persistSidebarStructure can save its content
      registerLiveInstance(chatObj);
      
      const newSummary: ChatSummary = { id: chatObj.id, title: chatObj.title, updatedAt: chatObj.updatedAt, groupId: chatObj.groupId };
      const newSidebarItem: SidebarItem = { id: `chat:${chatObj.id}`, type: 'chat', chat: newSummary };

      const newRootItems = JSON.parse(JSON.stringify(rootItems.value)) as SidebarItem[];
      insertSidebarItem(newRootItems, newSidebarItem, chatGroupId);

      // Order matters: persist structure first then the specific chat to ensure storage consistency
      await persistSidebarStructure(newRootItems);
      
      currentChat.value = chatObj;
      await loadData();
    } finally {
      creatingChat.value = false;
      unregisterLiveInstance(chatId);
    }
  };

  const openChat = async (id: string) => {
    // If there is an active background task for this chat, use the live instance
    if (liveChatRegistry.has(id)) {
      currentChat.value = liveChatRegistry.get(id)!;
      return;
    }

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

    // Abort and clear from registry if any
    if (activeGenerations.has(id)) {
      activeGenerations.get(id)?.controller.abort();
      activeGenerations.delete(id);
    }
    activeTitleGenerations.delete(id);
    activeModelFetches.delete(id);
    liveChatRegistry.delete(id);

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
    // Clear registry and abort generations
    for (const [, item] of activeGenerations.entries()) {
      item.controller.abort();
    }
    activeGenerations.clear();
    activeTitleGenerations.clear();
    activeModelFetches.clear();
    liveChatRegistry.clear();

    const all = await storageService.listChats();
    for (const c of all) await storageService.deleteChat(c.id);
    const allGroups = await storageService.listChatGroups();
    for (const g of allGroups) await storageService.deleteChatGroup(g.id);
    currentChat.value = null;
    await loadData();
  };

  const renameChat = async (id: string, newTitle: string) => {
    // Update live instance if it exists in registry
    const liveChat = liveChatRegistry.get(id);
    if (liveChat) {
      liveChat.title = newTitle;
      liveChat.updatedAt = Date.now();
      await saveChat(liveChat);
      if (currentChat.value?.id === id) triggerRef(currentChat);
      await loadData();
      return;
    }

    const chat = await storageService.loadChat(id);
    if (chat) {
      chat.title = newTitle;
      chat.updatedAt = Date.now();
      await saveChat(chat);
      if (currentChat.value?.id === id) {
        currentChat.value.title = newTitle;
        currentChat.value.updatedAt = chat.updatedAt;
        triggerRef(currentChat);
      }
      await loadData();
    }
  };

  const generateResponse = async (chat: Chat, assistantId: string) => {
    const assistantNode = findNodeInBranch(chat.root.items, assistantId);
    if (!assistantNode) throw new Error('Assistant node not found');

    // Reset error
    assistantNode.error = undefined;
    if (currentChat.value?.id === chat.id) triggerRef(currentChat);

    const controller = new AbortController();
    activeGenerations.set(chat.id, { controller, chat });
    registerLiveInstance(chat);

    const type = chat.endpointType || settings.value.endpointType;
    const url = chat.endpointUrl || settings.value.endpointUrl || '';
    const resolvedModel = assistantNode.modelId || '';

    try {
      const provider = type === 'ollama' ? new OllamaProvider() : new OpenAIProvider();

      // --- Resolve System Prompt & Parameters ---
      const activeProfile = (settings.value.providerProfiles || []).find(p => p.endpointUrl === url && p.endpointType === type);
      
      const globalSystemPrompt = activeProfile?.systemPrompt || settings.value.systemPrompt;
      const chatPromptObj = chat.systemPrompt;
      
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
      const history = getChatBranch(chat).filter(m => m.id !== assistantId);
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
        ...(chat.lmParameters || {}),
      };

      await provider.chat(finalMessages, resolvedModel, url, (chunk) => {
        assistantNode.content += chunk;
        if (currentChat.value?.id === chat.id) triggerRef(currentChat);
      }, resolvedParams, controller.signal);

      processThinking(assistantNode);
      chat.updatedAt = Date.now();
      
      // Guarded save: only save if chat wasn't deleted while generating
      if (activeGenerations.has(chat.id) || currentChat.value?.id === chat.id) {
        await saveChat(chat);
        await loadData();
      }

      if (chat.title === null && settings.value.autoTitleEnabled && (activeGenerations.has(chat.id) || currentChat.value?.id === chat.id)) {
        await generateChatTitle(chat, controller.signal);
      }
    } catch (e) {
      if ((e as Error).name === 'AbortError') {
        assistantNode.content += '\n\n[Generation Aborted]';
      } else {
        assistantNode.error = (e as Error).message;
        
        // Notify user if they are currently viewing a different chat
        if (currentChat.value?.id !== chat.id) {
          try {
            const { useToast } = await import('./useToast');
            const { addToast } = useToast();
            addToast({
              message: `Generation failed in "${chat.title || 'New Chat'}"`,
              actionLabel: 'View',
              onAction: () => openChat(chat.id),
            });
          } catch (toastErr) {
            console.error('Failed to show background error toast:', toastErr);
          }
        }
      }
      console.error(e);
    } finally {
      // Ensure we save the final state BEFORE removing from the registry.
      const isStillActive = activeGenerations.has(chat.id);
      if (isStillActive) {
        await saveChat(chat);
        activeGenerations.delete(chat.id);
        unregisterLiveInstance(chat.id);
      }
    }
  };

  const sendMessage = async (content: string, parentId?: string | null, attachments: Attachment[] = [], chatTarget?: Chat) => {
    const chat = chatTarget || currentChat.value;
    if (!chat || activeGenerations.has(chat.id) || activeProcessing.has(chat.id)) return;

    activeProcessing.add(chat.id);
    // Register immediately to ensure background tasks are tracked from the start
    registerLiveInstance(chat);

    try {
      const { isOnboardingDismissed, onboardingDraft, settings: globalSettings } = useSettings();
      const { showConfirm } = useConfirm();

      // --- Model & Endpoint Resolution ---
      const type = chat.endpointType || settings.value.endpointType;
      const url = chat.endpointUrl || settings.value.endpointUrl || '';
      
      let resolvedModel = chat.overrideModelId || settings.value.defaultModelId || '';

      if (url) {
        const models = await fetchAvailableModels(chat);
        if (models.length > 0) {
          const preferredModel = chat.overrideModelId || settings.value.defaultModelId;
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
        const models = await fetchAvailableModels(chat);
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
        chat.root.items.push(userMsg);
      } else {
        const pId = parentId || chat.currentLeafId;
        const parentNode = pId ? findNodeInBranch(chat.root.items, pId) : null;
        if (parentNode) parentNode.replies.items.push(userMsg);
        else chat.root.items.push(userMsg);
      }

      chat.currentLeafId = assistantMsg.id;
      if (currentChat.value?.id === chat.id) triggerRef(currentChat);
      await saveChat(chat);

      await generateResponse(chat, assistantMsg.id);
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
      // 1. Find the failed node
      const failedNode = findNodeInBranch(chat.root.items, failedMessageId);
      if (!failedNode || failedNode.role !== 'assistant') return;

      // 2. Find its parent (the User message)
      const parent = findParentInBranch(chat.root.items, failedMessageId);
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
      chat.currentLeafId = newAssistantMsg.id;
      if (currentChat.value?.id === chat.id) triggerRef(currentChat);
      await saveChat(chat);

      // 6. Generate
      await generateResponse(chat, newAssistantMsg.id);
    } finally {
      activeProcessing.delete(chat.id);
      unregisterLiveInstance(chat.id);
    }
  };

  const generateChatTitle = async (chat: Chat, signal?: AbortSignal) => {
    const taskId = chat.id;
    activeTitleGenerations.add(taskId);
    registerLiveInstance(chat);

    const type = chat.endpointType || settings.value.endpointType;
    const url = chat.endpointUrl || settings.value.endpointUrl || '';
    if (!url) {
      activeTitleGenerations.delete(taskId);
      unregisterLiveInstance(taskId);
      return;
    }

    const history = getChatBranch(chat);
    const content = history[0]?.content || ''; // Use the first user message for title generation
    if (!content || typeof content !== 'string') {
      activeTitleGenerations.delete(taskId);
      unregisterLiveInstance(taskId);
      return;
    }

    const hadTitleAtStart = chat.title !== null;
    const chatIdAtStart = chat.id;
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
      await titleProvider.chat([promptMsg], titleGenModel, url, (chunk) => { generatedTitle += chunk; }, {}, signal);
      const finalTitle = generatedTitle.trim().replace(/^["']|["']$/g, '');
      
      // Only apply if we got a title AND (it was a manual regeneration OR it's still null)
      if (finalTitle && (hadTitleAtStart || chat.title === null)) {
        chat.title = finalTitle;
        // Only save and refresh if the chat still exists
        if (activeGenerations.has(chat.id) || currentChat.value?.id === chat.id || liveChatRegistry.has(chat.id)) {
          await saveChat(chat);
          await loadData();
          if (currentChat.value?.id === chatIdAtStart) {
            triggerRef(currentChat);
          }
        }
      }
    } catch (e) {
      console.warn('Failed to generate title:', e);
    } finally {
      activeTitleGenerations.delete(taskId);
      unregisterLiveInstance(taskId);
    }
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
      });

      // Register immediately so persistSidebarStructure can save its content
      registerLiveInstance(newChatObj);

      const newSummary: ChatSummary = { id: newChatObj.id, title: newChatObj.title, updatedAt: newChatObj.updatedAt, groupId: newChatObj.groupId };
      const newSidebarItem: SidebarItem = { id: `chat:${newChatObj.id}`, type: 'chat', chat: newSummary };

      const newRootItems = JSON.parse(JSON.stringify(rootItems.value)) as SidebarItem[];
      insertSidebarItem(newRootItems, newSidebarItem, chat.groupId ?? null);
      
      await persistSidebarStructure(newRootItems);
      
      await loadData();
      await openChat(newChatObj.id);
      return newChatObj.id;
    } finally {
      unregisterLiveInstance(newChatId);
    }
  };

  const editMessage = async (messageId: string, newContent: string) => {
    const chat = currentChat.value;
    if (!chat) return;
    const node = findNodeInBranch(chat.root.items, messageId);
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
      const parent = findParentInBranch(chat.root.items, messageId);
      if (parent) parent.replies.items.push(correctedNode);
      else chat.root.items.push(correctedNode);
      chat.currentLeafId = correctedNode.id;
      await saveChat(chat);
      if (currentChat.value?.id === chat.id) triggerRef(currentChat);
    } else {
      const parent = findParentInBranch(chat.root.items, messageId);
      await sendMessage(newContent, parent ? parent.id : null, node.attachments, chat);
    }
  };

  const switchVersion = async (messageId: string) => {
    const chat = currentChat.value;
    if (!chat) return;
    const node = findNodeInBranch(chat.root.items, messageId);
    if (node) {
      chat.currentLeafId = findDeepestLeaf(node).id;
      if (currentChat.value?.id === chat.id) triggerRef(currentChat);
      await saveChat(chat);
    }
  };

  const getSiblings = (chat: Chat, messageId: string): MessageNode[] => {
    if (chat.root.items.some(m => m.id === messageId)) return chat.root.items;
    const parent = findParentInBranch(chat.root.items, messageId);
    return parent ? parent.replies.items : [];
  };

  const toggleDebug = async () => {
    const chat = currentChat.value;
    if (!chat) return;
    chat.debugEnabled = !chat.debugEnabled;
    if (currentChat.value?.id === chat.id) triggerRef(currentChat);
    await saveChat(chat);
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
            const chat = liveChatRegistry.get(nested.chat.id) || await storageService.loadChat(nested.chat.id);
            if (chat) {
              chat.groupId = item.chatGroup.id;
              await storageService.saveChat(chat, j);
            }
          }
        }
      } else {
        const chat = liveChatRegistry.get(item.chat.id) || await storageService.loadChat(item.chat.id);
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
    activeGenerations,
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
    saveChat,
  };
}
