import { ref, computed, shallowRef, reactive, triggerRef } from 'vue';
import { v7 as uuidv7 } from 'uuid';
import type { Chat, MessageNode, ChatGroup, SidebarItem, ChatSummary } from '../models/types';
import { storageService } from '../services/storage';
import { OpenAIProvider, OllamaProvider } from '../services/llm';
import { useSettings } from './useSettings';
import { buildSidebarItems } from '../models/mappers';
import sampleContent from '../assets/sample-showcase.md?raw';

const chats = ref<ChatSummary[]>([]);
const groups = ref<ChatGroup[]>([]);
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

  const sidebarItems = computed(() => buildSidebarItems(groups.value, chats.value));

  const activeMessages = computed(() => {
    if (!currentChat.value || currentChat.value.root.items.length === 0) return [];
    const path: MessageNode[] = [];
    const targetId = currentChat.value.currentLeafId;
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

  const loadData = async () => {
    chats.value = await storageService.listChats();
    groups.value = await storageService.listGroups();
  };

  const createNewChat = async (groupId: string | null = null) => {
    const siblings = chats.value.filter(c => (c.groupId || null) === (groupId || null));
    const maxOrder = siblings.reduce((max, c) => Math.max(max, c.order), -1);

    const chatObj: Chat = {
      id: uuidv7(),
      title: null,
      groupId,
      order: maxOrder + 1,
      root: { items: [] },
      modelId: settings.value.defaultModelId || 'gpt-3.5-turbo',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      debugEnabled: false,
    };
    currentChat.value = reactive(chatObj);
    await storageService.saveChat(currentChat.value);
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

  const deleteChat = async (id: string) => {
    const chatData = await storageService.loadChat(id);
    if (chatData) lastDeletedChat.value = chatData;
    await storageService.deleteChat(id);
    if (currentChat.value?.id === id) currentChat.value = null;
    await loadData();
  };

  const undoDelete = async () => {
    if (!lastDeletedChat.value) return;
    await storageService.saveChat(lastDeletedChat.value);
    const restoredId = lastDeletedChat.value.id;
    lastDeletedChat.value = null;
    await loadData();
    await openChat(restoredId);
  };

  const deleteAllChats = async () => {
    const all = await storageService.listChats();
    for (const c of all) await storageService.deleteChat(c.id);
    const allGroups = await storageService.listGroups();
    for (const g of allGroups) await storageService.deleteGroup(g.id);
    currentChat.value = null;
    lastDeletedChat.value = null;
    await loadData();
  };

  const renameChat = async (id: string, newTitle: string) => {
    if (currentChat.value?.id === id) {
      currentChat.value.title = newTitle;
      currentChat.value.updatedAt = Date.now();
      await storageService.saveChat(currentChat.value);
      triggerRef(currentChat);
    } else {
      const chat = await storageService.loadChat(id);
      if (chat) {
        chat.title = newTitle;
        chat.updatedAt = Date.now();
        await storageService.saveChat(chat);
      }
    }
    await loadData();
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

    if (parentId === null) {
      currentChat.value.root.items.push(userMsg);
    } else if (parentId) {
      const parentNode = findNodeInBranch(currentChat.value.root.items, parentId);
      if (parentNode) {
        parentNode.replies.items.push(userMsg);
      } else {
        currentChat.value.root.items.push(userMsg);
      }
    } else if (currentChat.value.currentLeafId && currentChat.value.root.items.length > 0) {
      const parentNode = findNodeInBranch(currentChat.value.root.items, currentChat.value.currentLeafId);
      if (parentNode) {
        parentNode.replies.items.push(userMsg);
      } else {
        currentChat.value.root.items.push(userMsg);
      }
    } else {
      currentChat.value.root.items.push(userMsg);
    }

    currentChat.value.currentLeafId = assistantMsg.id;
    triggerRef(currentChat);
    await storageService.saveChat(currentChat.value);

    const assistantNode = findNodeInBranch(currentChat.value.root.items, assistantMsg.id);
    if (!assistantNode) throw new Error('Assistant node not found in tree');

    streaming.value = true;
    try {
      const endpointType = currentChat.value.endpointType || settings.value.endpointType;
      const endpointUrl = currentChat.value.endpointUrl || settings.value.endpointUrl;
      const model = currentChat.value.overrideModelId || currentChat.value.modelId || settings.value.defaultModelId || 'gpt-3.5-turbo';
      const provider = endpointType === 'ollama' ? new OllamaProvider() : new OpenAIProvider();

      const context = activeMessages.value.filter(m => m.id !== assistantMsg.id);

      await provider.chat(context, model, endpointUrl, (chunk) => {
        assistantNode.content += chunk;
        triggerRef(currentChat);
      });

      processThinking(assistantNode);
      currentChat.value.updatedAt = Date.now();
      await storageService.saveChat(currentChat.value);
      triggerRef(currentChat);
      await loadData(); 

      if (currentChat.value.title === null && settings.value.autoTitleEnabled) {
        const chatIdAtStart = currentChat.value.id;
        try {
          let generatedTitle = '';
          const titleProvider = endpointType === 'ollama' ? new OllamaProvider() : new OpenAIProvider();
          const titleGenModel = settings.value.titleModelId || model;
          const promptNode: MessageNode = {
            id: uuidv7(),
            role: 'user',
            content: `Generate a very short, concise title (2-3 words max) for a chat that starts with this message: "${content}". 
            IMPORTANT: Use the same language as the user's message for the title. Respond with ONLY the title text.`,
            timestamp: Date.now(),
            replies: { items: [] }
          };
          await titleProvider.chat([promptNode], titleGenModel, endpointUrl, (chunk) => {
            generatedTitle += chunk;
          });
          const finalTitle = generatedTitle.trim().replace(/^["']|["']$/g, '');
          if (finalTitle && currentChat.value && currentChat.value.id === chatIdAtStart && currentChat.value.title === null) {
            currentChat.value.title = finalTitle;
            await storageService.saveChat(currentChat.value);
            await loadData();
            triggerRef(currentChat);
          }
        } catch (_e) {
          if (currentChat.value && currentChat.value.id === chatIdAtStart && currentChat.value.title === null) {
            currentChat.value.title = content.slice(0, 20) + (content.length > 20 ? '...' : '');
            await storageService.saveChat(currentChat.value);
            await loadData();
            triggerRef(currentChat);
          }
        }
      }
    } catch (e) {
      assistantNode.content += '\n\n[Error: ' + (e as Error).message + ']';
      triggerRef(currentChat);
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
    await loadData();
    currentChat.value = newChat;
    return newChat.id;
  };

  const editMessage = async (messageId: string, newContent: string) => {
    if (!currentChat.value || currentChat.value.root.items.length === 0) return; 
    
    const node = findNodeInBranch(currentChat.value.root.items, messageId);
    if (!node) return;

    const parent = findParentInBranch(currentChat.value.root.items, messageId);

    if (node.role === 'assistant') {
      const correctedNode: MessageNode = {
        id: uuidv7(),
        role: 'assistant',
        content: newContent,
        timestamp: Date.now(),
        replies: { items: [] }
      };
      
      if (parent) {
        parent.replies.items.push(correctedNode);
      } else {
        currentChat.value.root.items.push(correctedNode);
      }
      
      currentChat.value.currentLeafId = correctedNode.id;
      await storageService.saveChat(currentChat.value);
      triggerRef(currentChat);
    } else {
      await sendMessage(newContent, parent ? parent.id : null);
    }
  };

  const switchVersion = async (messageId: string) => {
    if (!currentChat.value || currentChat.value.root.items.length === 0) return;
    const node = findNodeInBranch(currentChat.value.root.items, messageId);
    if (node) {
      currentChat.value.currentLeafId = findDeepestLeaf(node).id;
      triggerRef(currentChat);
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
    triggerRef(currentChat);
    await storageService.saveChat(currentChat.value);
  };

  const createGroup = async (name: string) => {
    const newGroup: ChatGroup = {
      id: uuidv7(),
      name,
      order: groups.value.length,
      updatedAt: Date.now(),
      isCollapsed: false,
      items: [],
    };
    await storageService.saveGroup(newGroup);
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
      await storageService.saveGroup(group);
    }
  };

  const renameGroup = async (groupId: string, newName: string) => {
    const group = groups.value.find(g => g.id === groupId);
    if (group) {
      group.name = newName;
      group.updatedAt = Date.now();
      await storageService.saveGroup(group);
      await loadData();
    }
  };

  const persistSidebarStructure = async (topLevelItems: SidebarItem[]) => {
    const newGroups: ChatGroup[] = [];
    const newChatSummaries: ChatSummary[] = [];

    // 1. Traverse the recursive structure to build flat refs and determine orders
    topLevelItems.forEach((item, index) => {
      if (item.type === 'group') {
        const group = { ...item.group, order: index };
        newGroups.push(group);
        
        // Items within group
        group.items.forEach((nestedItem, chatIdx) => {
          if (nestedItem.type === 'chat') {
            newChatSummaries.push({ ...nestedItem.chat, groupId: group.id, order: chatIdx });
          }
        });
      } else {
        newChatSummaries.push({ ...item.chat, groupId: null, order: index });
      }
    });

    // 2. Synchronous update
    groups.value = newGroups;
    chats.value = newChatSummaries;

    // 3. Asynchronous persistence
    for (const g of newGroups) {
      await storageService.saveGroup(g);
    }
    for (const c of newChatSummaries) {
      const fullChat = await storageService.loadChat(c.id);
      if (fullChat) {
        fullChat.groupId = c.groupId;
        fullChat.order = c.order;
        await storageService.saveChat(fullChat);
      }
    }
  };

  const reorderChat = async (chatId: string, newOrder: number, newGroupId: string | null = null) => {
    const fullChat = await storageService.loadChat(chatId);
    if (fullChat) {
      fullChat.order = newOrder;
      fullChat.groupId = newGroupId;
      await storageService.saveChat(fullChat);
      await loadData();
    }
  };

  const reorderGroup = async (groupId: string, _newOrder: number) => {
    const group = groups.value.find(item => item.id === groupId);
    if (group) {
      await storageService.saveGroup({ ...group, updatedAt: Date.now() }); 
      await loadData();
    }
  };

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
      order: 0,
      modelId: 'gpt-4-showcase',
      createdAt: now,
      updatedAt: now,
      debugEnabled: true,
    };
    currentChat.value = reactive(sampleChatObj);
    await storageService.saveChat(currentChat.value);
    await loadData();
  };

  return {
    chats,
    groups,
    sidebarItems,
    currentChat,
    activeMessages,
    streaming,
    loadChats: loadData,
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
    createGroup,
    deleteGroup,
    toggleGroupCollapse,
    renameGroup,
    persistSidebarStructure,
    reorderChat,
    reorderGroup,
    lastDeletedChat
  };
}