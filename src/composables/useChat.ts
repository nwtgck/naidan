import { ref } from 'vue';
import { v4 as uuidv4 } from 'uuid';
import type { Chat, Message } from '../models/types';
import { storageService } from '../services/storage';
import type { ChatSummary } from '../services/storage/interface';
import { OpenAIProvider, OllamaProvider } from '../services/llm';
import { useSettings } from './useSettings';

const chats = ref<ChatSummary[]>([]);
const currentChat = ref<Chat | null>(null);
const streaming = ref(false);

export function useChat() {
  const { settings } = useSettings();

  async function loadChats() {
    chats.value = await storageService.listChats();
  }

  async function createNewChat() {
    const newChat: Chat = {
      id: uuidv4(),
      title: 'New Chat',
      messages: [],
      modelId: settings.value.defaultModelId || 'gpt-3.5-turbo', // Fallback
      createdAt: Date.now(),
      updatedAt: Date.now(),
      debugEnabled: false,
    };
    await storageService.saveChat(newChat);
    await loadChats();
    currentChat.value = newChat;
  }

  async function openChat(id: string) {
    currentChat.value = await storageService.loadChat(id);
  }

  async function deleteChat(id: string) {
    await storageService.deleteChat(id);
    if (currentChat.value?.id === id) {
      currentChat.value = null;
    }
    await loadChats();
  }

  async function sendMessage(content: string) {
    if (!currentChat.value) return;
    if (streaming.value) return;

    // User Message
    const userMsg: Message = {
      id: uuidv4(),
      role: 'user',
      content,
      timestamp: Date.now(),
    };
    currentChat.value.messages.push(userMsg);

    // Assistant Placeholder
    const assistantMsg: Message = {
      id: uuidv4(),
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
    };
    const messages = currentChat.value.messages;
    messages.push(assistantMsg);
    const lastIdx = messages.length - 1;

    // Save state before request
    await storageService.saveChat(currentChat.value);

    streaming.value = true;
    
    try {
      const provider = settings.value.endpointType === 'ollama' 
        ? new OllamaProvider() 
        : new OpenAIProvider();
        
      const model = currentChat.value.modelId || settings.value.defaultModelId || 'gpt-3.5-turbo';

      // We only send previous messages context, excluding the empty assistant one we just added
      const contextMessages = messages.slice(0, -1);

      await provider.chat(
        contextMessages,
        model,
        settings.value.endpointUrl,
        (chunk) => {
          if (currentChat.value && currentChat.value.messages[lastIdx]) {
            currentChat.value.messages[lastIdx].content += chunk;
          }
        }
      );

      if (currentChat.value && currentChat.value.messages[lastIdx]) {
        // Post-process <think>
        processThinking(currentChat.value.messages[lastIdx]);
        currentChat.value.updatedAt = Date.now();
        await storageService.saveChat(currentChat.value);
      }
      await loadChats(); 
    } catch (e) {
      console.error('Chat error', e);
      assistantMsg.content += '\n\n[Error: ' + (e as Error).message + ']';
      await storageService.saveChat(currentChat.value);
    } finally {
      streaming.value = false;
    }
  }

  function processThinking(msg: Message) {
    // Regex to find <think>...</think>
    // Handles multiline.
    const thinkRegex = /<think>([\s\S]*?)<\/think>/;
    const match = msg.content.match(thinkRegex);
    if (match && match[1]) {
      msg.thinking = match[1].trim();
      msg.content = msg.content.replace(thinkRegex, '').trim();
    }
  }

  async function toggleDebug() {
    if (!currentChat.value) return;
    currentChat.value.debugEnabled = !currentChat.value.debugEnabled;
    await storageService.saveChat(currentChat.value);
  }

  return {
    chats,
    currentChat,
    streaming,
    loadChats,
    createNewChat,
    openChat,
    deleteChat,
    sendMessage,
    toggleDebug
  };
}
