import { ref, computed, toRaw, triggerRef, type ComputedRef, type Ref } from 'vue';
import type { Chat } from '@/models/types';
import type { ChatId, MessageId, ToolCallId } from '@/models/ids';
import type { LlmToolName, TextOrBinaryObject, ToolCallRecord, ToolConfig } from '@/services/tools/types';
import {
  isLlmToolEnabledInToolConfigs,
  isLlmToolName,
  llmToolNamesFromToolConfigs,
  setLlmToolEnabledInToolConfigs,
} from '@/services/tools/tool-config';
import { currentChatRef, getLiveChatById } from '@/composables/chat/global/chat-core-singletons';
import { idToRaw } from '@/models/ids';
import { storageService } from '@/services/storage';
import { useSettings } from '@/composables/useSettings';

const _runtimeToolConfigsByChat = ref<Map<ChatId, ToolConfig[]>>(new Map());
const _messageToolCalls = ref<Map<MessageId, ToolCallRecord[]>>(new Map());
const _currentChatId = ref<ChatId | null>(null);

interface ChatToolsApi {
  isToolEnabled: ({ name }: { name: string }) => boolean;
  setToolEnabled: ({ name, enabled }: { name: string; enabled: boolean }) => void;
  toggleTool: ({ name }: { name: string }) => void;
  setCurrentChatId: ({ chatId }: { chatId: ChatId | null }) => void;
  updateToolConfigsForCurrentChat: ({ updater }: { updater: ({ toolConfigs }: { toolConfigs: ToolConfig[] | undefined }) => ToolConfig[] | undefined }) => void;
  enabledToolNames: ComputedRef<LlmToolName[]>;
  getToolCallsForMessage: ({ messageId }: { messageId: MessageId }) => ToolCallRecord[];
  addToolCall: ({ messageId, toolCall }: { messageId: MessageId; toolCall: ToolCallRecord }) => void;
  updateToolCall: ({ messageId, toolCallId, update }: {
    messageId: MessageId;
    toolCallId: ToolCallId;
    update: | { status: 'success'; result: { content: TextOrBinaryObject } } | { status: 'error'; error: { message: TextOrBinaryObject } }
  }) => void;
  clearToolCallsForMessage: ({ messageId }: { messageId: MessageId }) => void;
  TEST_ONLY: {
    _messageToolCalls: Ref<Map<MessageId, ToolCallRecord[]>>;
    _runtimeToolConfigsByChat: Ref<Map<ChatId, ToolConfig[]>>;
    _currentChatId: Ref<ChatId | null>;
  };
}

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
  chatId: ChatId;
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
  chatId: ChatId;
  toolConfigs: ToolConfig[] | undefined;
}) {
  const next = new Map(_runtimeToolConfigsByChat.value);
  next.set(chatId, [...(toolConfigs ?? [])]);
  _runtimeToolConfigsByChat.value = next;
}

function clearRuntimeToolConfigsForChat({ chatId }: { chatId: ChatId }) {
  if (!_runtimeToolConfigsByChat.value.has(chatId)) return;
  const next = new Map(_runtimeToolConfigsByChat.value);
  next.delete(chatId);
  _runtimeToolConfigsByChat.value = next;
}

function triggerCurrentChatIfNeeded({ chatId }: { chatId: ChatId }) {
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
  chatId: ChatId;
  toolConfigs: ToolConfig[] | undefined;
}) {
  if (!isToolConfigPersistenceEnabled()) {
    return;
  }

  void storageService.updateChatMeta({
    id: chatId,
    updater: ({ current }) => {
      if (current === null) {
        throw new Error('Cannot update tool configs for missing chat: ' + idToRaw({ id: chatId }));
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
  chatId: ChatId;
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

export function useChatTools(): ChatToolsApi {
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

  const setCurrentChatId = ({ chatId }: { chatId: ChatId | null }) => {
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

  const getToolCallsForMessage = ({ messageId }: { messageId: MessageId }) => {
    return _messageToolCalls.value.get(messageId) || [];
  };

  const addToolCall = ({ messageId, toolCall }: { messageId: MessageId; toolCall: ToolCallRecord }) => {
    const current = _messageToolCalls.value.get(messageId) || [];
    if (current.some(c => c.id === toolCall.id)) return;

    const nextMap = new Map(_messageToolCalls.value);
    nextMap.set(messageId, [...current, toolCall]);
    _messageToolCalls.value = nextMap;
  };

  const updateToolCall = ({ messageId, toolCallId, update }: {
    messageId: MessageId;
    toolCallId: ToolCallId;
    update: | { status: 'success'; result: { content: TextOrBinaryObject } } | { status: 'error'; error: { message: TextOrBinaryObject } }
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

  const clearToolCallsForMessage = ({ messageId }: { messageId: MessageId }) => {
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
