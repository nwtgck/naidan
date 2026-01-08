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
const lastDeletedChat = ref<Chat | null>(null);

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
    // Save for undo before deleting
    const chatData = await storageService.loadChat(id);
    if (chatData) {
      lastDeletedChat.value = chatData;
    }

    await storageService.deleteChat(id);
    if (currentChat.value?.id === id) {
      currentChat.value = null;
    }
    await loadChats();
  }

  async function undoDelete() {
    if (!lastDeletedChat.value) return;
    
    await storageService.saveChat(lastDeletedChat.value);
    const restoredId = lastDeletedChat.value.id;
    lastDeletedChat.value = null;
    await loadChats();
    await openChat(restoredId);
  }

  async function deleteAllChats() {
    const all = await storageService.listChats();
    for (const c of all) {
      await storageService.deleteChat(c.id);
    }
    currentChat.value = null;
    lastDeletedChat.value = null;
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
      const endpointType = currentChat.value.endpointType || settings.value.endpointType;
      const endpointUrl = currentChat.value.endpointUrl || settings.value.endpointUrl;
      const model = currentChat.value.overrideModelId || currentChat.value.modelId || settings.value.defaultModelId || 'gpt-3.5-turbo';

      const provider = endpointType === 'ollama' 
        ? new OllamaProvider() 
        : new OpenAIProvider();

      // We only send previous messages context, excluding the empty assistant one we just added
      const contextMessages = messages.slice(0, -1);

      await provider.chat(
        contextMessages,
        model,
        endpointUrl,
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

  /**
   * Creates a comprehensive sample chat for debugging and showcasing features.
   * IMPORTANT: When adding new rendering capabilities (e.g., new markdown plugins, 
   * custom components, or LLM response types), update this sample chat to 
   * ensure the new features are covered and can be verified easily.
   */
  async function createSampleChat() {
    const id = uuidv4();
    const now = Date.now();
    const sampleChat: Chat = {
      id,
      title: '🚀 Sample: Feature Showcase',
      modelId: 'gpt-4-demo',
      createdAt: now,
      updatedAt: now,
      debugEnabled: true,
      messages: [
        {
          id: uuidv4(),
          role: 'user',
          content: 'Show me your capabilities, including code highlighting and your thought process.',
          timestamp: now - 10000,
        },
        {
          id: uuidv4(),
          role: 'assistant',
          content: `<think>
The user wants to see a comprehensive demonstration of my rendering capabilities.
I should include:
1. A thought process block (this one).
2. Code blocks in various languages (Python, TypeScript, Rust).
3. Markdown features like tables and lists.
4. Mathematical notation if supported (though we use standard markdown).
</think>
Certainly! Here is a demonstration of what I can do:

### 1. Code Syntax Highlighting

**Python:**
\`\`\`python
def greet(name: str) -> str:
    \"\"\"A simple greeting function\"\"\"
    return f"Hello, {name}!"

print(greet("World"))
\`\`\`

**TypeScript (Vue):**
\`\`\`typescript
import { ref, computed } from 'vue';

const count = ref(0);
const doubled = computed(() => count.value * 2);
\`\`\`

**Rust:**
\`\`\`rust
fn main() {
    let message = "Hello Rust";
    println!("{}", message);
}
\`\`\`

### 2. Mathematics (KaTeX)

When $a \ne 0$, there are two solutions to $ax^2 + bx + c = 0$ and they are:
$$x = {-b \pm \sqrt{b^2-4ac} \over 2a}$$

### 3. Diagrams (Mermaid)

\`\`\`mermaid
graph TD
    A[Start] --> B{Is it working?}
    B -- Yes --> C[Great!]
    B -- No --> D[Debug]
    D --> B
\`\`\`

### 4. Rich Markdown & Task Lists

- [x] Support for **bold** and *italic*
- [x] Support for [links](https://google.com)
- [ ] Support for inline code \`const x = 42\`
- [x] Support for Task Lists

| Feature | Status |
| :--- | :--- |
| KaTeX | ✅ |
| Mermaid | ✅ |
| Highlighting | ✅ |

> "Logic will get you from A to B. Imagination will take you everywhere." - Albert Einstein`,
          timestamp: now,
          thinking: 'The user wants to see a comprehensive demonstration of my rendering capabilities.\nI should include:\n1. A thought process block (this one).\n2. Code blocks in various languages (Python, TypeScript, Rust).\n3. Mathematics using LaTeX.\n4. Diagrams using Mermaid.\n5. Markdown features like tables and task lists.'
        }
      ]
    };

    await storageService.saveChat(sampleChat);
    await loadChats();
    currentChat.value = sampleChat;
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
    toggleDebug,
    createSampleChat,
    undoDelete,
    deleteAllChats,
    lastDeletedChat
  };
}
