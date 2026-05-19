import { generateId } from '@/utils/id';
import type { Chat, MessageNode } from '@/models/types';
import { storageService } from '@/services/storage';
import sampleContent from '@/assets/sample-showcase.md?raw';
import { useChat } from './useChat';
import { processThinking } from '@/utils/chat-tree';

const longSampleTopics = [
  'release planning',
  'offline reliability',
  'message navigation',
  'debug tooling',
  'mobile layout',
  'storage migration',
] as const;

const userGoals = [
  'I need to compare tradeoffs without losing the original context.',
  'I want a practical recommendation that I can test today.',
  'Please call out the risky assumptions and the simplest reversible step.',
  'Help me turn the idea into a concrete implementation checklist.',
] as const;

const assistantAngles = [
  'Start by separating the user-facing behavior from the implementation detail.',
  'Treat this as an additive experiment first, then decide whether it deserves a permanent place.',
  'Keep the data model boring and put the optional behavior behind a narrow UI entry point.',
  'Measure the interaction cost before expanding the feature surface.',
] as const;

function paragraphFromParts({ seed, role, topic }: {
  seed: number;
  role: 'user' | 'assistant';
  topic: string;
}) {
  const goal = userGoals[seed % userGoals.length];
  const angle = assistantAngles[seed % assistantAngles.length];
  const focus = longSampleTopics[(seed + 2) % longSampleTopics.length];
  const followUp = userGoals[(seed + 1) % userGoals.length];

  switch (role) {
  case 'user':
    return `${goal} The current concern is ${topic}, but it keeps touching ${focus} once the conversation gets long. ${followUp} I am especially interested in the version that can be removed quickly if the interaction feels noisy.`;
  case 'assistant':
    return `${angle} For ${topic}, the useful test is whether a person can regain orientation after several dense turns. I would keep the first pass narrow, reuse the existing chat primitives, and make the output predictable enough that layout regressions are easy to notice.`;
  default: {
    const _ex: never = role;
    return _ex;
  }
  }
}

function longMessageContent({ turnIndex, role }: {
  turnIndex: number;
  role: 'user' | 'assistant';
}) {
  const topic = longSampleTopics[turnIndex % longSampleTopics.length]!;
  const paragraphCount = (() => {
    switch (role) {
    case 'user':
      return 3;
    case 'assistant':
      return 5;
    default: {
      const _ex: never = role;
      return _ex;
    }
    }
  })();
  const paragraphs = Array.from({ length: paragraphCount }, (_, paragraphIndex) => paragraphFromParts({
    seed: turnIndex + paragraphIndex,
    role,
    topic,
  }));

  switch (role) {
  case 'user':
    return `Long sample request ${turnIndex + 1}: ${topic}\n\n${paragraphs.join('\n\n')}`;
  case 'assistant':
    return `Here is a concrete pass for ${topic}.\n\n${paragraphs.join('\n\n')}\n\nA useful acceptance check is simple: scroll away, open the navigation aid, peek at this answer, and verify that the surrounding conversation still feels identifiable without typing a search query.`;
  default: {
    const _ex: never = role;
    return _ex;
  }
  }
}

async function persistSampleChat({ chat, loadChats, openChat }: {
  chat: Chat;
  loadChats: () => Promise<void>;
  openChat: (chatId: string) => Promise<unknown>;
}) {
  await storageService.updateChatContent(chat.id, () => ({
    root: chat.root,
    currentLeafId: chat.currentLeafId
  }));
  await storageService.updateChatMeta(chat.id, () => chat);
  await storageService.updateHierarchy((curr) => {
    curr.items.push({ type: 'chat', id: chat.id });
    return curr;
  });

  await loadChats();
  await openChat(chat.id);
}

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

    await persistSampleChat({
      chat: sampleChatObj,
      loadChats,
      openChat,
    });
  };

  const createLongSampleChat = async () => {
    const now = Date.now();
    const messageCount = 36;
    const messages: MessageNode[] = Array.from({ length: messageCount }, (_, index) => {
      const role = index % 2 === 0 ? 'user' : 'assistant';
      return {
        id: generateId(),
        role,
        content: longMessageContent({ turnIndex: Math.floor(index / 2), role }),
        timestamp: now + index * 1000,
        replies: { items: [] },
      };
    });

    for (let index = 0; index < messages.length - 1; index++) {
      messages[index]!.replies.items.push(messages[index + 1]!);
    }

    const currentLeafId = messages[messages.length - 1]!.id;
    const longSampleChatObj: Chat = {
      id: generateId(),
      title: 'Long Sample: Outline Stress Test',
      root: { items: [messages[0]!] },
      currentLeafId,
      createdAt: now,
      updatedAt: now + messageCount * 1000,
      debugEnabled: false,
    };

    await persistSampleChat({
      chat: longSampleChatObj,
      loadChats,
      openChat,
    });
  };

  return {
    createSampleChat,
    createLongSampleChat,
    TEST_ONLY: {
      // Export internal state and logic used only for testing here. Do not reference these in production logic.
    },
  };
}
