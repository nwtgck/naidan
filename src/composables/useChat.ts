import { ref, computed, shallowRef, reactive, triggerRef } from 'vue';
import { v7 as uuidv7 } from 'uuid';
import type { Chat, MessageNode } from '../models/types';
import { storageService } from '../services/storage';
import type { ChatSummary } from '../services/storage/interface';
import { OpenAIProvider, OllamaProvider } from '../services/llm';
import { useSettings } from './useSettings';
import sampleContent from '../assets/sample-showcase.md?raw';

const chats = ref<ChatSummary[]>([]);
const currentChat = shallowRef<Chat | null>(null);
const streaming = ref(false);
const lastDeletedChat = ref<Chat | null>(null);

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

function processThinking(node: MessageNode) {
  const thinkRegex = /<think>([\s\S]*?)<\/think>/;
  const match = node.content.match(thinkRegex);
  if (match && match[1]) {
    node.thinking = match[1].trim();
    node.content = node.content.replace(thinkRegex, '').trim();
  }
}

export function useChat() {
  const { settings } = useSettings();

  const activeMessages = computed(() => {
    if (!currentChat.value || currentChat.value.root.items.length === 0) return [];
    
    const path: MessageNode[] = [];
    const targetId = currentChat.value.currentLeafId;
    
    // Start with the best root candidate
    let curr: MessageNode | null = currentChat.value.root.items.find(item => 
      item.id === targetId || findNodeInBranch(item.replies.items, targetId || '')
    ) || currentChat.value.root.items[currentChat.value.root.items.length - 1] || null;

    while (curr) {
      path.push(curr);
      if (curr.id === targetId) break;
      
      const next: MessageNode | undefined = curr.replies.items.find(item => 
        item.id === targetId || findNodeInBranch(item.replies.items, targetId || '')
      ) || curr.replies.items[curr.replies.items.length - 1];
      
      curr = next || null;
    }
    return path;
  });

  const loadChats = async () => {
    chats.value = await storageService.listChats();
  };

  const createNewChat = async () => {
    const chatObj: Chat = {
      id: uuidv7(),
      title: 'New Chat',
      root: { items: [] },
      modelId: settings.value.defaultModelId || 'gpt-3.5-turbo',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      debugEnabled: false,
    };
    currentChat.value = reactive(chatObj);
    await storageService.saveChat(currentChat.value);
    await loadChats();
  };

  const openChat = async (id: string) => {
    const loaded = await storageService.loadChat(id);
    if (loaded) {
      currentChat.value = reactive(loaded);
    } else {
      currentChat.value = null;
    }
  };

  const deleteChat = async (id: string) => {
    const chatData = await storageService.loadChat(id);
    if (chatData) lastDeletedChat.value = chatData;
    await storageService.deleteChat(id);
    if (currentChat.value?.id === id) currentChat.value = null;
    await loadChats();
  };

  const undoDelete = async () => {
    if (!lastDeletedChat.value) return;
    await storageService.saveChat(lastDeletedChat.value);
    const restoredId = lastDeletedChat.value.id;
    lastDeletedChat.value = null;
    await loadChats();
    await openChat(restoredId);
  };

  const deleteAllChats = async () => {
    const all = await storageService.listChats();
    for (const c of all) await storageService.deleteChat(c.id);
    currentChat.value = null;
    lastDeletedChat.value = null;
    await loadChats();
  };

  const renameChat = async (id: string, newTitle: string) => {
    if (currentChat.value?.id === id) {
      currentChat.value.title = newTitle;
      currentChat.value.updatedAt = Date.now();
      await storageService.saveChat(currentChat.value);
    } else {
      const chat = await storageService.loadChat(id);
      if (chat) {
        chat.title = newTitle;
        chat.updatedAt = Date.now();
        await storageService.saveChat(chat);
      }
    }
    await loadChats();
  };

  const sendMessage = async (content: string, parentId?: string | null) => {
    if (!currentChat.value) return;
    if (streaming.value) return;

    const userMsg: MessageNode = {
      id: uuidv7(),
      role: 'user',
      content,
      timestamp: Date.now(),
      replies: { items: [] }
    };

    const assistantMsg: MessageNode = {
      id: uuidv7(),
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
      replies: { items: [] }
    };
    userMsg.replies.items.push(assistantMsg);

    // Determine where to attach this message
    if (parentId === null) {
      // Explicitly requested to be a new root branch
      currentChat.value.root.items.push(userMsg);
    } else if (parentId) {
      // Explicitly requested to branch from a specific node
      const parentNode = findNodeInBranch(currentChat.value.root.items, parentId);
      if (parentNode) {
        parentNode.replies.items.push(userMsg);
      } else {
        // Fallback: if ID provided but not found, add to root
        currentChat.value.root.items.push(userMsg);
      }
    } else if (currentChat.value.currentLeafId && currentChat.value.root.items.length > 0) {
      // Automatic continuation from current leaf
      const parentNode = findNodeInBranch(currentChat.value.root.items, currentChat.value.currentLeafId);
      if (parentNode) {
        parentNode.replies.items.push(userMsg);
      } else {
        // Extreme fallback
        currentChat.value.root.items.push(userMsg);
      }
    } else {
      // First message in an empty chat
      currentChat.value.root.items.push(userMsg);
    }

    currentChat.value.currentLeafId = assistantMsg.id;
    // Deep save
    await storageService.saveChat(currentChat.value);

    streaming.value = true;
    try {
      const endpointType = currentChat.value.endpointType || settings.value.endpointType;
      const endpointUrl = currentChat.value.endpointUrl || settings.value.endpointUrl;
      const model = currentChat.value.overrideModelId || currentChat.value.modelId || settings.value.defaultModelId || 'gpt-3.5-turbo';
      const provider = endpointType === 'ollama' ? new OllamaProvider() : new OpenAIProvider();

      const context = activeMessages.value.filter(m => m.id !== assistantMsg.id);

      await provider.chat(context as any, model, endpointUrl, (chunk) => {
        assistantMsg.content += chunk;
        if (currentChat.value) triggerRef(currentChat);
      });

      processThinking(assistantMsg);
      currentChat.value.updatedAt = Date.now();
      await storageService.saveChat(currentChat.value);
      await loadChats(); 
    } catch (e) {
      assistantMsg.content += '\n\n[Error: ' + (e as Error).message + ']';
      if (currentChat.value) triggerRef(currentChat);
      await storageService.saveChat(currentChat.value);
    } finally {
      streaming.value = false;
    }
  };

  const forkChat = async (messageId: string): Promise<string | null> => {
    if (!currentChat.value || currentChat.value.root.items.length === 0) return null;
    
    const path = activeMessages.value;
    const idx = path.findIndex(m => m.id === messageId);
    if (idx === -1) return null;
    const forkPath = path.slice(0, idx + 1);

    const clonedNodes: MessageNode[] = forkPath.map(n => ({
      id: n.id,
      role: n.role,
      content: n.content,
      timestamp: n.timestamp,
      thinking: n.thinking,
      replies: { items: [] }
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

    const newChat = reactive(newChatObj);
    await storageService.saveChat(newChat);
    await loadChats();
    currentChat.value = newChat;
    return newChat.id;
  };

  const editMessage = async (messageId: string, newContent: string) => {
    if (!currentChat.value || currentChat.value.root.items.length === 0) return;
    const parent = findParentInBranch(currentChat.value.root.items, messageId);
    // If no parent found, it means we are editing a root-level message.
    // We pass null to signal root branching.
    await sendMessage(newContent, parent ? parent.id : null);
  };

  const switchVersion = async (messageId: string) => {
    if (!currentChat.value || currentChat.value.root.items.length === 0) return;
    const node = findNodeInBranch(currentChat.value.root.items, messageId);
    if (node) {
      currentChat.value.currentLeafId = findDeepestLeaf(node).id;
      await storageService.saveChat(currentChat.value);
    }
  };

  const getSiblings = (messageId: string): MessageNode[] => {
    if (!currentChat.value || currentChat.value.root.items.length === 0) return [];
    if (currentChat.value.root.items.some(m => m.id === messageId)) return currentChat.value.root.items;
    const parent = findParentInBranch(currentChat.value.root.items, messageId);
    return parent ? parent.replies.items : [];
  };

  const toggleDebug = async () => {
    if (!currentChat.value) return;
    currentChat.value.debugEnabled = !currentChat.value.debugEnabled;
    await storageService.saveChat(currentChat.value);
  };

  /**
   * Creates a comprehensive sample chat for debugging and showcasing features.
   * IMPORTANT: When adding new rendering capabilities (e.g., new markdown plugins, 
   * custom components, or LLM response types), update this sample chat to 
   * ensure the new features are covered and can be verified easily.
   */
  const createSampleChat = async () => {
    const now = Date.now();
    const m2: MessageNode = {
      id: uuidv7(),
      role: 'assistant',
      content: sampleContent,
      timestamp: now,
      replies: { items: [] }
    };
    processThinking(m2);
    const m1: MessageNode = {
      id: uuidv7(),
      role: 'user',
      content: 'Show me your tree-based branching and rendering capabilities!',
      timestamp: now - 5000,
      replies: { items: [m2] }
    };
    const sampleChatObj: Chat = {
      id: uuidv7(),
      title: '🚀 Sample: Tree Showcase',
      root: { items: [m1] },
      currentLeafId: m2.id,
      modelId: 'gpt-4-showcase',
      createdAt: now,
      updatedAt: now,
      debugEnabled: true,
    };
    currentChat.value = reactive(sampleChatObj);
    await storageService.saveChat(currentChat.value);
    await loadChats();
  };

  return {
    chats,
    currentChat,
    activeMessages,
    streaming,
    loadChats,
    createNewChat,
    openChat,
    deleteChat,
    undoDelete,
    deleteAllChats,
    renameChat,
    sendMessage,
    forkChat,
    editMessage,
    switchVersion,
    getSiblings,
    toggleDebug,
    createSampleChat,
    lastDeletedChat
  };
}
