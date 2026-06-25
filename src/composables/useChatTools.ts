import { ref, computed, toRaw, triggerRef, watch, type ComputedRef, type Ref } from 'vue';
import type { Chat } from '@/models/types';
import type { ChatId, MessageId, ToolCallId } from '@/models/ids';
import type {
  BuiltinToolKey,
  LmToolName,
  TextOrBinaryObject,
  ToolCallRecord,
  ToolConfig,
  ToolConfigStatus,
} from '@/services/tools/types';
import {
  builtinToolKeyForLmToolName,
  findLastToolConfigByKey,
  isLmToolEnabledInToolConfigs,
  isLmToolName,
  lmToolNamesFromToolConfigs,
  removeSingletonToolConfig,
  resolveToolConfigForChat,
  resolveToolConfigsForChat,
  setToolStatusWithDependenciesInToolConfigs,
  type ResolvedToolConfig,
} from '@/services/tools/tool-config';
import {
  currentChatRef,
  getLiveChatById,
  rootItems,
} from '@/composables/chat/global/chat-core-singletons';
import { idToRaw } from '@/models/ids';
import { storageService } from '@/services/storage';
import { useSettings } from '@/composables/useSettings';

const _runtimeToolConfigsByChat = ref<Map<ChatId, ToolConfig[]>>(new Map());
const _messageToolCalls = ref<Map<MessageId, ToolCallRecord[]>>(new Map());
const _currentChatId = ref<ChatId | null>(null);

let isToolConfigPersistenceWatcherInstalled = false;

function ensureToolConfigPersistenceWatcher(): void {
  if (isToolConfigPersistenceWatcherInstalled) return;

  const { settings } = useSettings();
  watch(
    () => settings.value.experimental?.toolConfigPersistence ?? 'disabled',
    (persistence) => {
      switch (persistence) {
      case 'disabled':
        break;
      case 'enabled':
        _runtimeToolConfigsByChat.value = new Map();
        break;
      default: {
        const _ex: never = persistence;
        throw new Error(`Unhandled tool config persistence setting: ${_ex}`);
      }
      }
    },
    { flush: 'sync' },
  );
  isToolConfigPersistenceWatcherInstalled = true;
}

export type ChatToolInheritanceLabel = 'Use group' | 'Use global';

interface ChatToolsApi {
  isToolEnabled: ({ name }: { name: string }) => boolean;
  setToolEnabled: ({ name, enabled }: { name: string; enabled: boolean }) => void;
  setToolStatus: ({ name, status }: { name: LmToolName; status: ToolConfigStatus }) => void;
  resetToolToInherited: ({ name }: { name: LmToolName }) => void;
  toggleTool: ({ name }: { name: string }) => void;
  getToolInheritanceLabel: ({ name }: { name: LmToolName }) => ChatToolInheritanceLabel;
  setCurrentChatId: ({ chatId }: { chatId: ChatId | null }) => void;
  updateToolConfigsForCurrentChat: ({ updater }: { updater: ({ toolConfigs }: { toolConfigs: ToolConfig[] | undefined }) => ToolConfig[] | undefined }) => void;
  enabledToolNames: ComputedRef<LmToolName[]>;
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

export function getChatGroupToolConfigsForChat({
  chat,
}: {
  chat: Pick<Chat, 'groupId'> | null;
}): ToolConfig[] | undefined {
  const groupId = chat?.groupId;
  if (groupId === undefined || groupId === null) return undefined;

  for (const item of rootItems.value) {
    switch (item.type) {
    case 'chat_group':
      if (item.chatGroup.id === groupId) {
        return item.chatGroup.toolConfigs;
      }
      break;
    case 'chat':
      break;
    default: {
      const _ex: never = item;
      return _ex;
    }
    }
  }

  return undefined;
}

export function getActiveChatToolConfigs({
  chatId,
  persistedToolConfigs,
}: {
  chatId: ChatId;
  persistedToolConfigs: ToolConfig[] | undefined;
}): ToolConfig[] | undefined {
  if (!isToolConfigPersistenceEnabled() && _runtimeToolConfigsByChat.value.has(chatId)) {
    return _runtimeToolConfigsByChat.value.get(chatId);
  }

  return persistedToolConfigs;
}

export function getEffectiveToolConfigsForChat({
  chat,
}: {
  chat: Pick<Chat, 'id' | 'groupId' | 'toolConfigs'>;
}): ToolConfig[] {
  const { settings } = useSettings();
  return resolveToolConfigsForChat({
    globalToolConfigs: settings.value.experimental?.toolConfigs,
    chatGroupToolConfigs: getChatGroupToolConfigsForChat({ chat }),
    chatToolConfigs: getActiveChatToolConfigs({
      chatId: chat.id,
      persistedToolConfigs: chat.toolConfigs,
    }),
  });
}

export function getInheritedToolConfigsForChat({
  chatId,
}: {
  chatId: ChatId;
}): ToolConfig[] {
  const { settings } = useSettings();
  const liveChat = getLiveChatById({ chatId });
  return resolveToolConfigsForChat({
    globalToolConfigs: settings.value.experimental?.toolConfigs,
    chatGroupToolConfigs: getChatGroupToolConfigsForChat({ chat: liveChat }),
    chatToolConfigs: undefined,
  });
}

export function getToolResolutionForChat({
  chatId,
  key,
}: {
  chatId: ChatId;
  key: BuiltinToolKey;
}): ResolvedToolConfig {
  const { settings } = useSettings();
  const liveChat = getLiveChatById({ chatId });
  return resolveToolConfigForChat({
    key,
    globalToolConfigs: settings.value.experimental?.toolConfigs,
    chatGroupToolConfigs: getChatGroupToolConfigsForChat({ chat: liveChat }),
    chatToolConfigs: getActiveChatToolConfigs({
      chatId,
      persistedToolConfigs: liveChat?.toolConfigs,
    }),
  });
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
  ensureToolConfigPersistenceWatcher();

  const liveChat = getLiveChatById({ chatId });
  const currentToolConfigs = getActiveChatToolConfigs({
    chatId,
    persistedToolConfigs: liveChat?.toolConfigs,
  });
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
    if (!isLmToolName(name)) return false;
    if (_currentChatId.value === null) return false;

    const liveChat = getCurrentLiveChat();
    const toolConfigs = getEffectiveToolConfigsForChat({
      chat: liveChat ?? {
        id: _currentChatId.value,
        groupId: undefined,
        toolConfigs: undefined,
      },
    });
    return isLmToolEnabledInToolConfigs({ toolConfigs, name });
  };

  const updateToolConfigsForCurrentChat = ({
    updater,
  }: {
    updater: ({ toolConfigs }: { toolConfigs: ToolConfig[] | undefined }) => ToolConfig[] | undefined;
  }) => {
    if (_currentChatId.value === null) return;
    updateToolConfigsForChat({ chatId: _currentChatId.value, updater });
  };

  const setToolStatus = ({
    name,
    status,
  }: {
    name: LmToolName;
    status: ToolConfigStatus;
  }) => {
    if (_currentChatId.value === null) return;
    const key = builtinToolKeyForLmToolName({ name });
    const inheritedToolConfigs = getInheritedToolConfigsForChat({
      chatId: _currentChatId.value,
    });

    updateToolConfigsForCurrentChat({
      updater: ({ toolConfigs }) => setToolStatusWithDependenciesInToolConfigs({
        toolConfigs,
        key,
        status,
        inheritedToolConfigs,
      }),
    });
  };

  const setToolEnabled = ({ name, enabled }: { name: string; enabled: boolean }) => {
    if (!isLmToolName(name)) return;
    setToolStatus({
      name,
      status: enabled ? 'enabled' : 'disabled',
    });
  };

  const resetToolToInherited = ({ name }: { name: LmToolName }) => {
    updateToolConfigsForCurrentChat({
      updater: ({ toolConfigs }) => removeSingletonToolConfig({
        toolConfigs,
        key: builtinToolKeyForLmToolName({ name }),
      }),
    });
  };


  const toggleTool = ({ name }: { name: string }) => {
    setToolEnabled({ name, enabled: !isToolEnabled({ name }) });
  };

  const getToolInheritanceLabel = ({ name }: { name: LmToolName }): ChatToolInheritanceLabel => {
    if (_currentChatId.value === null) return 'Use global';
    const liveChat = getCurrentLiveChat();
    const groupConfig = findLastToolConfigByKey({
      toolConfigs: getChatGroupToolConfigsForChat({ chat: liveChat }),
      key: builtinToolKeyForLmToolName({ name }),
    });
    return groupConfig === undefined ? 'Use global' : 'Use group';
  };

  const setCurrentChatId = ({ chatId }: { chatId: ChatId | null }) => {
    _currentChatId.value = chatId;
  };

  const enabledToolNames = computed((): LmToolName[] => {
    if (_currentChatId.value === null) return [];

    const liveChat = getCurrentLiveChat();
    const toolConfigs = getEffectiveToolConfigsForChat({
      chat: liveChat ?? {
        id: _currentChatId.value,
        groupId: undefined,
        toolConfigs: undefined,
      },
    });
    return lmToolNamesFromToolConfigs({ toolConfigs });
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
    setToolStatus,
    resetToolToInherited,
    toggleTool,
    getToolInheritanceLabel,
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
