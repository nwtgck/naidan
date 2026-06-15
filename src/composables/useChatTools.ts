import { ref, computed, toRaw, triggerRef } from 'vue';
import type { Chat } from '@/models/types';
import type { LlmToolName, ToolCallRecord, ToolConfig } from '@/services/tools/types';
import {
  isLlmToolEnabledInToolConfigs,
  isLlmToolName,
  llmToolNamesFromToolConfigs,
  setLlmToolEnabledInToolConfigs,
} from '@/services/tools/tool-config';
import { currentChatRef, getLiveChatById } from '@/composables/chat/global/chat-core-singletons';
import { storageService } from '@/services/storage';
import { useSettings } from '@/composables/useSettings';

const _runtimeToolConfigsByChat = ref<Map<string, ToolConfig[]>>(new Map());
const _messageToolCalls = ref<Map<string, ToolCallRecord[]>>(new Map());
const _currentChatId = ref<string | null>(null);

function getCurrentLiveChat(): Chat | null {
  if (_currentChatId.value === null) return null;
  return getLiveChatById({ chatId: _currentChatId.value });
}

/**
 * Resolves the tool config that should affect runtime behavior.
 *
 * `persistedToolConfigs` is the storage-backed chat metadata state.
 * `_runtimeToolConfigsByChat` is an overlay for tool changes made while tool
 * config persistence is disabled. The overlay deliberately wins over persisted
 * config so runtime-only disables can hide an already-persisted tool without
 * mutating chat metadata.
 */
export function getEffectiveToolConfigsForChat({
  chatId,
  persistedToolConfigs,
}: {
  chatId: string;
  persistedToolConfigs: ToolConfig[] | undefined;
}): ToolConfig[] | undefined {
  if (_runtimeToolConfigsByChat.value.has(chatId)) {
    return _runtimeToolConfigsByChat.value.get(chatId);
  }

  return persistedToolConfigs;
}

function setRuntimeToolConfigsForChat({
  chatId,
  toolConfigs,
}: {
  chatId: string;
  toolConfigs: ToolConfig[] | undefined;
}) {
  const next = new Map(_runtimeToolConfigsByChat.value);
  next.set(chatId, [...(toolConfigs ?? [])]);
  _runtimeToolConfigsByChat.value = next;
}

function clearRuntimeToolConfigsForChat({ chatId }: { chatId: string }) {
  if (!_runtimeToolConfigsByChat.value.has(chatId)) return;
  const next = new Map(_runtimeToolConfigsByChat.value);
  next.delete(chatId);
  _runtimeToolConfigsByChat.value = next;
}

function triggerCurrentChatIfNeeded({ chatId }: { chatId: string }) {
  if (currentChatRef.value && toRaw(currentChatRef.value).id === chatId) {
    triggerRef(currentChatRef);
  }
}

function isToolConfigPersistenceEnabled(): boolean {
  const { settings } = useSettings();
  return settings.value.experimental?.toolConfigPersistence === 'enabled';
}

function persistToolConfigs({
  chatId,
  toolConfigs,
}: {
  chatId: string;
  toolConfigs: ToolConfig[] | undefined;
}) {
  if (!isToolConfigPersistenceEnabled()) {
    return;
  }

  void storageService.updateChatMeta({
    id: chatId,
    updater: ({ current }) => {
      if (current === null) {
        throw new Error(`Cannot update tool configs for missing chat: ${chatId}`);
      }
      return {
        ...current,
        toolConfigs,
      };
    },
  }).catch((error: unknown) => {
    console.error('Failed to persist tool configs', error);
  });
}

export function updateToolConfigsForChat({
  chatId,
  updater,
}: {
  chatId: string;
  updater: ({ toolConfigs }: { toolConfigs: ToolConfig[] | undefined }) => ToolConfig[] | undefined;
}) {
  const liveChat = getLiveChatById({ chatId });
  const persistedToolConfigs = liveChat?.toolConfigs;
  const currentToolConfigs = getEffectiveToolConfigsForChat({ chatId, persistedToolConfigs });
  const nextToolConfigs = updater({ toolConfigs: currentToolConfigs });

  if (!isToolConfigPersistenceEnabled()) {
    setRuntimeToolConfigsForChat({ chatId, toolConfigs: nextToolConfigs });
    triggerCurrentChatIfNeeded({ chatId });
    return;
  }

  clearRuntimeToolConfigsForChat({ chatId });
  if (liveChat !== null) {
    liveChat.toolConfigs = nextToolConfigs;
    triggerCurrentChatIfNeeded({ chatId });
  }
  persistToolConfigs({ chatId, toolConfigs: nextToolConfigs });
}

export function useChatTools() {
  const isToolEnabled = ({ name }: { name: string }) => {
    if (!isLlmToolName(name)) return false;
    if (_currentChatId.value === null) return false;

    const liveChat = getCurrentLiveChat();
    const toolConfigs = getEffectiveToolConfigsForChat({
      chatId: _currentChatId.value,
      persistedToolConfigs: liveChat?.toolConfigs,
    });
    return isLlmToolEnabledInToolConfigs({ toolConfigs, name });
  };

  const updateToolConfigsForCurrentChat = ({
    updater,
  }: {
    updater: ({ toolConfigs }: { toolConfigs: ToolConfig[] | undefined }) => ToolConfig[] | undefined;
  }) => {
    if (_currentChatId.value === null) return;
    updateToolConfigsForChat({ chatId: _currentChatId.value, updater });
  };

  const setToolEnabled = ({ name, enabled }: { name: string; enabled: boolean }) => {
    if (!isLlmToolName(name)) return;

    updateToolConfigsForCurrentChat({
      updater: ({ toolConfigs }) => setLlmToolEnabledInToolConfigs({
        toolConfigs,
        name,
        enabled,
      }),
    });
  };

  const toggleTool = ({ name }: { name: string }) => {
    setToolEnabled({ name, enabled: !isToolEnabled({ name }) });
  };

  const setCurrentChatId = ({ chatId }: { chatId: string | null }) => {
    _currentChatId.value = chatId;
  };

  const enabledToolNames = computed((): LlmToolName[] => {
    if (_currentChatId.value === null) return [];

    const liveChat = getCurrentLiveChat();
    const toolConfigs = getEffectiveToolConfigsForChat({
      chatId: _currentChatId.value,
      persistedToolConfigs: liveChat?.toolConfigs,
    });
    return llmToolNamesFromToolConfigs({ toolConfigs });
  });

  const getToolCallsForMessage = ({ messageId }: { messageId: string }) => {
    return _messageToolCalls.value.get(messageId) || [];
  };

  const addToolCall = ({ messageId, toolCall }: { messageId: string; toolCall: ToolCallRecord }) => {
    const current = _messageToolCalls.value.get(messageId) || [];
    if (current.some(c => c.id === toolCall.id)) return;

    const nextMap = new Map(_messageToolCalls.value);
    nextMap.set(messageId, [...current, toolCall]);
    _messageToolCalls.value = nextMap;
  };

  const updateToolCall = ({ messageId, toolCallId, update }: {
    messageId: string;
    toolCallId: string;
    update: | { status: 'success'; result: { content: import('@/services/tools/types').TextOrBinaryObject } } | { status: 'error'; error: { message: import('@/services/tools/types').TextOrBinaryObject } }
  }) => {
    const current = _messageToolCalls.value.get(messageId);
    if (!current) return;

    const idx = current.findIndex(c => c.id === toolCallId);
    if (idx === -1) return;

    const updatedCalls = [...current];
    updatedCalls[idx] = { ...updatedCalls[idx]!, ...update };

    const nextMap = new Map(_messageToolCalls.value);
    nextMap.set(messageId, updatedCalls);
    _messageToolCalls.value = nextMap;
  };

  const clearToolCallsForMessage = ({ messageId }: { messageId: string }) => {
    const nextMap = new Map(_messageToolCalls.value);
    nextMap.delete(messageId);
    _messageToolCalls.value = nextMap;
  };

  return {
    isToolEnabled,
    setToolEnabled,
    toggleTool,
    setCurrentChatId,
    updateToolConfigsForCurrentChat,
    enabledToolNames,
    getToolCallsForMessage,
    addToolCall,
    updateToolCall,
    clearToolCallsForMessage,
    TEST_ONLY: {
      _messageToolCalls,
      _runtimeToolConfigsByChat,
      _currentChatId,
    },
  };
}
