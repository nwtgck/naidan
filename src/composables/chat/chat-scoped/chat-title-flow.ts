import { autoTitleScheduler } from '@/composables/chat/global/auto-title-runtime';
import type { Chat, ChatMessage, Endpoint } from '@/01-models/types';
import { isConfiguredEndpoint, isHttpEndpoint } from '@/01-models/endpoint';
import { toMessageId, type ChatId } from '@/01-models/ids';
import { getMessageText } from '@/01-models/message-text';
import type { LmProvider } from '@/01-models/lm';
import { loadLmProvider } from '@/features/lm/providerFactory';
import { getChatBranchIterator } from '@/logic/chat-tree';
import { stripNaidanSentinels } from '@/utils/image-generation';
import { cleanGeneratedTitle, detectLanguage, getTitleSystemPrompt } from '@/utils/title-generator';
import { resolveChatSettings } from '@/logic/chat-settings-resolver';
import { useSettings } from '@/composables/useSettings';
import { storageService } from '@/00-storage/service';
import { collectTitleGeneration } from '@/logic/collect-title-generation';
import {
  chatRuntimeStore,
  currentChatRef,
  getLiveChatById,
  isGeneratingTitle,
  loadData,
  registerLiveInstance,
  rootItems,
  triggerCurrentChat,
  unregisterLiveInstance,
} from '@/composables/chat/global/chat-core-singletons';

export function isGeneratingChatTitle({
  chatId,
}: {
  chatId: ChatId,
}): boolean {
  return isGeneratingTitle({ chatId });
}

export function abortTitleGenerationForChat({
  chatId,
}: {
  chatId: ChatId,
}): void {
  autoTitleScheduler.cancel({ chatId });
  if (!chatRuntimeStore.activeTitleGenerations.has(chatId)) {
    return;
  }

  chatRuntimeStore.getActiveTitleGeneration({ chatId })?.abort();
  chatRuntimeStore.deleteActiveTitleGeneration({ chatId });
}

/** Reserve an automatic title; no provider or task is started during quiet time. */
export function scheduleAutoTitleForChat({ chatId }: { chatId: ChatId }): void {
  autoTitleScheduler.schedule({
    chatId,
    run: async ({ signal }) => {
      // A deleted chat may still have content during its undo window, or its
      // last response may finish after deletion. It must not create new work.
      const hierarchy = await storageService.loadHierarchy();
      signal.throwIfAborted();
      if (!hierarchy.items.some(item => {
        switch (item.type) {
        case 'chat': return item.id === chatId;
        case 'chat_group': return item.chat_ids.includes(chatId);
        default: { const exhaustive: never = item; throw new Error(String(exhaustive)); }
        }
      })) return;
      // A background chat may have left the live registry while waiting.
      const chat = getLiveChatById({ chatId }) ?? await storageService.loadChat({ id: chatId });
      signal.throwIfAborted();
      if (chat === null || chat.title !== null) return;
      registerLiveInstance({ chat });
      await generateTitle({ chatId, titleModelIdOverride: undefined, signal, mode: 'automatic' });
    },
  });
}

export async function generateChatTitleForChat({ chatId, titleModelIdOverride, signal }: {
  chatId: ChatId,
  titleModelIdOverride: string | undefined,
  signal: AbortSignal | undefined,
}): Promise<string | undefined> {
  // An explicit title request supersedes a pending automatic one, but remains
  // distinct from the automatic work preempted by ChatInput activity.
  autoTitleScheduler.cancel({ chatId });
  const release = autoTitleScheduler.hold();
  try {
    return await generateTitle({ chatId, titleModelIdOverride, signal, mode: 'manual' });
  } finally {
    release();
  }
}

async function generateTitle({ chatId, titleModelIdOverride, signal, mode }: {
  chatId: ChatId,
  titleModelIdOverride: string | undefined,
  signal: AbortSignal | undefined,
  mode: 'automatic' | 'manual',
}): Promise<string | undefined> {
  const mutableChat = getLiveChatById({ chatId });
  if (mutableChat === null || (mode === 'automatic' && mutableChat.title !== null)) return undefined;
  const taskId = mutableChat.id;
  const titleAtStart = mutableChat.title;
  const leafAtStart = mutableChat.currentLeafId;

  if (chatRuntimeStore.activeTitleGenerations.has(taskId)) {
    chatRuntimeStore.getActiveTitleGeneration({ chatId: taskId })?.abort();
  }

  const controller = new AbortController();
  chatRuntimeStore.setActiveTitleGeneration({
    chatId: taskId,
    controller,
  });
  chatRuntimeStore.startTask({
    key: {
      kind: 'title',
      chatId: taskId,
    },
  });
  registerLiveInstance({ chat: mutableChat });

  try {
    const resolved = resolveTitleSettings({ chat: mutableChat });
    if (!resolved.hasReachableEndpoint) {
      return undefined;
    }

    const history = Array.from(getChatBranchIterator({ chat: mutableChat }));
    const firstMessage = history[0];
    const content = stripNaidanSentinels({ content: firstMessage ? getMessageText({ message: firstMessage }) : '' });
    if (typeof content !== 'string' || content.length === 0) {
      return undefined;
    }

    if (resolved.titleGeneration === 'disabled') {
      return undefined;
    }

    const settingsAtStart = JSON.stringify(resolved.titleGeneration);
    const titleModelId = titleModelIdOverride || resolved.titleGeneration.modelId;
    if (!titleModelId) {
      return undefined;
    }

    const combinedSignal = signal ? AbortSignal.any([controller.signal, signal]) : controller.signal;
    combinedSignal.throwIfAborted();
    const provider = await loadTitleProvider({
      endpoint: resolved.titleGeneration.endpoint,
    });
    combinedSignal.throwIfAborted();

    const { language } = getTitleLanguage({ content });
    const systemPrompt = getTitleSystemPrompt({ language });
    const promptMessages: ChatMessage[] = [
      { id: toMessageId({ raw: 'title-system' }), role: 'system', parts: [{ type: 'text', text: systemPrompt, completeness: 'complete' }] },
      { id: toMessageId({ raw: 'title-user' }), role: 'user', parts: [{ type: 'text', text: `Message content to summarize: "${content.slice(0, 1000)}"`, completeness: 'complete' }] },
    ];
    const { text: generatedTitle, result } = await collectTitleGeneration({
      provider,
      endpoint: resolved.titleGeneration.endpoint,
      messages: promptMessages,
      model: titleModelId,
      parameters: resolved.titleGeneration.lmParameters,
      signal: combinedSignal,
    });
    combinedSignal.throwIfAborted();
    switch (result.type) {
    case 'error': throw result.error;
    case 'interrupted': return undefined;
    case 'finished':
      switch (result.next) {
      case 'user': break;
      case 'tool_results': throw new Error('Title generation unexpectedly requested tools.');
      default: { const _ex: never = result.next; throw new Error(`Unhandled title step: ${_ex}`); }
      }
      break;
    default: { const _ex: never = result; throw new Error(`Unhandled title generation result: ${_ex}`); }
    }

    const finalTitle = cleanGeneratedTitle({ title: generatedTitle });
    if (!finalTitle) {
      return undefined;
    }

    const canCommit = (): boolean => !combinedSignal.aborted
      && chatRuntimeStore.getActiveTitleGeneration({ chatId: taskId }) === controller
      && mutableChat.title === titleAtStart
      && mutableChat.currentLeafId === leafAtStart
      && JSON.stringify(resolveTitleSettings({ chat: mutableChat }).titleGeneration) === settingsAtStart;
    if (!canCommit()) return undefined;

    // Check the persisted title again under its lock, not only the live object:
    // another tab may have renamed or deleted this chat while we were generating.
    let committed = false;
    await storageService.updateChatMeta({
      id: taskId,
      updater: ({ current }) => {
        if (current === null || current.title !== titleAtStart || !canCommit()) return undefined;
        committed = true;
        return { ...current, title: finalTitle, updatedAt: Date.now() };
      },
    });
    if (!committed) return undefined;
    if (canCommit()) mutableChat.title = finalTitle;
    await loadData();
    triggerCurrentChat({ chatId: taskId });
    return finalTitle;
  } finally {
    chatRuntimeStore.finishTask({
      key: {
        kind: 'title',
        chatId: taskId,
      },
    });

    if (chatRuntimeStore.getActiveTitleGeneration({ chatId: taskId }) === controller) {
      chatRuntimeStore.deleteActiveTitleGeneration({ chatId: taskId });
    }
    // Keep a selected chat registered; background-only instances can be released.
    if (currentChatRef.value?.id !== taskId) unregisterLiveInstance({ chatId: taskId });
  }
}

function resolveTitleSettings({
  chat,
}: {
  chat: Chat,
}) {
  const { settings } = useSettings();
  const resolved = resolveChatSettings({
    chat,
    groups: collectChatGroups({ items: rootItems.value }),
    globalSettings: settings.value,
  });

  return {
    endpoint: resolved.endpoint,
    titleGeneration: resolved.titleGeneration,
    hasReachableEndpoint: resolved.titleGeneration !== 'disabled'
      && isConfiguredEndpoint({ endpoint: resolved.titleGeneration.endpoint }),
  };
}

function collectChatGroups({
  items,
}: {
  items: typeof rootItems.value,
}) {
  return items.flatMap((item) => {
    switch (item.type) {
    case 'chat':
      return [];
    case 'chat_group':
      return [item.chatGroup];
    default: {
      const _ex: never = item;
      throw new Error(`Unhandled sidebar item type: ${_ex}`);
    }
    }
  });
}

function getTitleLanguage({
  content,
}: {
  content: string,
}) {
  const typeOfNavigator = typeof navigator;
  switch (typeOfNavigator) {
  case 'undefined':
    return { language: detectLanguage({ content, fallbackLanguage: 'en' }) };
  case 'object':
  case 'boolean':
  case 'string':
  case 'number':
  case 'function':
  case 'symbol':
  case 'bigint':
    return { language: detectLanguage({ content, fallbackLanguage: navigator.language }) };
  default: {
    const _ex: never = typeOfNavigator;
    throw new Error(`Unhandled navigator type: ${_ex}`);
  }
  }
}

async function loadTitleProvider({
  endpoint,
}: {
  endpoint: Endpoint,
}): Promise<LmProvider> {
  if (isHttpEndpoint(endpoint) && endpoint.url === '') {
    throw new Error(`${endpoint.type} title generation requires an endpoint URL`);
  }

  const { settings } = useSettings();
  return await loadLmProvider({
    endpoint,
    fakeLmDebugModeStatus: settings.value.experimental?.fakeLm ?? 'disabled',
  });
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
