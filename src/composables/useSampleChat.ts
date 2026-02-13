import { generateId } from '../utils/id';
import type { Chat, MessageNode } from '../models/types';
import { storageService } from '../services/storage';
import sampleContent from '../assets/sample-showcase.md?raw';
import { useChat } from './useChat';
import { processThinking } from '../utils/chat-tree';

export function useSampleChat() {
  const { loadChats, openChat } = useChat();

  const createSampleChat = async () => {
    const now = Date.now();
    const m2: MessageNode = {
      id: generateId(),
      role: 'assistant',
      content: sampleContent,
      timestamp: now,
      replies: { items: [] },
    };
    processThinking(m2);

    const m3: MessageNode = {
      id: generateId(),
      role: 'assistant',
      content: 'This is an alternative response. You can switch between different versions of assistant replies using the arrows!',
      timestamp: now + 1000,
      replies: { items: [] },
    };

    const m1: MessageNode = {
      id: generateId(),
      role: 'user',
      content: 'Show me your tree-based branching and rendering capabilities!',
      timestamp: now - 5000,
      replies: { items: [m2, m3] },
    };

    const sampleChatObj: Chat = {
      id: generateId(),
      title: '🚀 Sample: Tree Showcase',
      root: { items: [m1] },
      currentLeafId: m2.id,
      createdAt: now,
      updatedAt: now,
      debugEnabled: true,
    };
    
    await storageService.updateChatContent(sampleChatObj.id, () => ({
      root: sampleChatObj.root,
      currentLeafId: sampleChatObj.currentLeafId
    }));
    await storageService.updateChatMeta(sampleChatObj.id, () => sampleChatObj);
    await storageService.updateHierarchy((curr) => {
      curr.items.push({ type: 'chat', id: sampleChatObj.id });
      return curr;
    });

    await loadChats();
    await openChat(sampleChatObj.id);
  };

  return {
    createSampleChat,
    __testOnly: {
      // Export internal state and logic used only for testing here. Do not reference these in production logic.
    },
  };
}
