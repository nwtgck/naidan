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
  BUILTIN_TOOL_KEYS,
  builtinToolKeyForLmToolName,
  cloneToolConfigs,
  findLastToolConfigByKey,
  isLmToolEnabledInToolConfigs,
  isLmToolName,
  lmToolNamesFromToolConfigs,
  removeSingletonToolConfig,
  resolveToolConfigForChat,
  resolveToolConfigsForChat,
  setToolStatusWithDependenciesInToolConfigs,
  upsertSingletonToolConfig,
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

type ToolConfigsUpdater = ({
  toolConfigs,
}: {
  toolConfigs: ToolConfig[] | undefined;
}) => ToolConfig[] | undefined;

type RuntimeToolConfigChange =
  | { behavior: 'remove' }
  | { behavior: 'set'; config: ToolConfig };

type RuntimeToolConfigChanges = Map<BuiltinToolKey, RuntimeToolConfigChange>;

const _runtimeToolConfigChangesByChat = ref<Map<ChatId, RuntimeToolConfigChanges>>(new Map());
const persistentToolConfigUpdateQueues = new Map<ChatId, Promise<void>>();
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
        _runtimeToolConfigChangesByChat.value = new Map();
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
  setToolEnabled: ({ name, enabled }: { name: string; enabled: boolean }) => Promise<void>;
  setToolStatus: ({ name, status }: { name: LmToolName; status: ToolConfigStatus }) => Promise<void>;
  resetToolToInherited: ({ name }: { name: LmToolName }) => Promise<void>;
  toggleTool: ({ name }: { name: string }) => Promise<void>;
  getToolInheritanceLabel: ({ name }: { name: LmToolName }) => ChatToolInheritanceLabel;
  setCurrentChatId: ({ chatId }: { chatId: ChatId | null }) => void;
  updateToolConfigsForCurrentChat: ({ updater }: { updater: ToolConfigsUpdater }) => Promise<void>;
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
    _runtimeToolConfigChangesByChat: Ref<Map<ChatId, RuntimeToolConfigChanges>>;
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

function cloneToolConfig({ config }: { config: ToolConfig }): ToolConfig {
  const cloned = cloneToolConfigs({ toolConfigs: [config] })?.[0];
  if (cloned === undefined) {
    throw new Error('Failed to clone Tool Config');
  }
  return cloned;
}

function areToolConfigsEqual({
  first,
  second,
}: {
  first: ToolConfig | undefined;
  second: ToolConfig | undefined;
}): boolean {
  if (first === undefined || second === undefined) return first === second;
  if (first.key !== second.key || first.status !== second.status) return false;

  switch (first.key) {
  case 'builtin.calculator':
  case 'builtin.choices':
  case 'builtin.wikipedia':
    return true;
  case 'builtin.wesh':
    return second.key === 'builtin.wesh'
      && first.naidanSysfs.accessScope === second.naidanSysfs.accessScope;
  default: {
    const _ex: never = first;
    throw new Error(`Unhandled Tool Config: ${String(_ex)}`);
  }
  }
}

function areToolConfigLayersEqual({
  first,
  second,
}: {
  first: ToolConfig[] | undefined;
  second: ToolConfig[] | undefined;
}): boolean {
  return BUILTIN_TOOL_KEYS.every(key => areToolConfigsEqual({
    first: findLastToolConfigByKey({ toolConfigs: first, key }),
    second: findLastToolConfigByKey({ toolConfigs: second, key }),
  }));
}

function applyRuntimeToolConfigChanges({
  persistedToolConfigs,
  changes,
}: {
  persistedToolConfigs: ToolConfig[] | undefined;
  changes: RuntimeToolConfigChanges;
}): ToolConfig[] | undefined {
  let nextToolConfigs = cloneToolConfigs({ toolConfigs: persistedToolConfigs });

  for (const key of BUILTIN_TOOL_KEYS) {
    const change = changes.get(key);
    if (change === undefined) continue;

    switch (change.behavior) {
    case 'remove':
      nextToolConfigs = removeSingletonToolConfig({
        toolConfigs: nextToolConfigs,
        key,
      });
      break;
    case 'set':
      nextToolConfigs = upsertSingletonToolConfig({
        toolConfigs: nextToolConfigs,
        config: cloneToolConfig({ config: change.config }),
      });
      break;
    default: {
      const _ex: never = change;
      throw new Error(`Unhandled runtime Tool Config change: ${String(_ex)}`);
    }
    }
  }

  return nextToolConfigs;
}

export function getActiveChatToolConfigs({
  chatId,
  persistedToolConfigs,
}: {
  chatId: ChatId;
  persistedToolConfigs: ToolConfig[] | undefined;
}): ToolConfig[] | undefined {
  if (!isToolConfigPersistenceEnabled()) {
    const changes = _runtimeToolConfigChangesByChat.value.get(chatId);
    if (changes !== undefined) {
      return applyRuntimeToolConfigChanges({ persistedToolConfigs, changes });
    }
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
  persistedToolConfigs,
  currentToolConfigs,
  nextToolConfigs,
}: {
  chatId: ChatId;
  persistedToolConfigs: ToolConfig[] | undefined;
  currentToolConfigs: ToolConfig[] | undefined;
  nextToolConfigs: ToolConfig[] | undefined;
}): void {
  const changes = new Map(_runtimeToolConfigChangesByChat.value.get(chatId) ?? []);

  for (const key of BUILTIN_TOOL_KEYS) {
    const currentConfig = findLastToolConfigByKey({
      toolConfigs: currentToolConfigs,
      key,
    });
    const nextConfig = findLastToolConfigByKey({
      toolConfigs: nextToolConfigs,
      key,
    });
    if (areToolConfigsEqual({ first: currentConfig, second: nextConfig })) continue;

    const persistedConfig = findLastToolConfigByKey({
      toolConfigs: persistedToolConfigs,
      key,
    });
    if (areToolConfigsEqual({ first: persistedConfig, second: nextConfig })) {
      changes.delete(key);
    } else if (nextConfig === undefined) {
      changes.set(key, { behavior: 'remove' });
    } else {
      changes.set(key, {
        behavior: 'set',
        config: cloneToolConfig({ config: nextConfig }),
      });
    }
  }

  const nextByChat = new Map(_runtimeToolConfigChangesByChat.value);
  if (changes.size === 0) {
    nextByChat.delete(chatId);
  } else {
    nextByChat.set(chatId, changes);
  }
  _runtimeToolConfigChangesByChat.value = nextByChat;
}

function clearRuntimeToolConfigsForChat({ chatId }: { chatId: ChatId }): void {
  if (!_runtimeToolConfigChangesByChat.value.has(chatId)) return;
  const next = new Map(_runtimeToolConfigChangesByChat.value);
  next.delete(chatId);
  _runtimeToolConfigChangesByChat.value = next;
}

function triggerCurrentChatIfNeeded({ chatId }: { chatId: ChatId }): void {
  if (currentChatRef.value && toRaw(currentChatRef.value).id === chatId) {
    triggerRef(currentChatRef);
  }
}

function isToolConfigPersistenceEnabled(): boolean {
  const { settings } = useSettings();
  return settings.value.experimental?.toolConfigPersistence === 'enabled';
}

async function persistToolConfigUpdate({
  chatId,
  updater,
}: {
  chatId: ChatId;
  updater: ToolConfigsUpdater;
}): Promise<void> {
  const previous = persistentToolConfigUpdateQueues.get(chatId) ?? Promise.resolve();
  const operation = previous
    .catch(() => undefined)
    .then(async () => {
      let baseToolConfigs: ToolConfig[] | undefined;
      let savedToolConfigs: ToolConfig[] | undefined;
      let savedUpdatedAt: number | undefined;

      await storageService.updateChatMeta({
        id: chatId,
        updater: ({ current }) => {
          if (current === null) {
            throw new Error('Cannot update tool configs for missing chat: ' + idToRaw({ id: chatId }));
          }

          baseToolConfigs = cloneToolConfigs({ toolConfigs: current.toolConfigs });
          savedToolConfigs = cloneToolConfigs({
            toolConfigs: updater({
              toolConfigs: cloneToolConfigs({ toolConfigs: baseToolConfigs }),
            }),
          });
          savedUpdatedAt = Math.max(Date.now(), current.updatedAt + 1);
          return {
            ...current,
            toolConfigs: savedToolConfigs,
            updatedAt: savedUpdatedAt,
          };
        },
      });

      clearRuntimeToolConfigsForChat({ chatId });
      const liveChat = getLiveChatById({ chatId });
      if (liveChat !== null && savedUpdatedAt !== undefined) {
        const canMergeSavedToolConfigs = liveChat.updatedAt <= savedUpdatedAt
          || areToolConfigLayersEqual({
            first: liveChat.toolConfigs,
            second: baseToolConfigs,
          });
        if (canMergeSavedToolConfigs) {
          liveChat.toolConfigs = cloneToolConfigs({ toolConfigs: savedToolConfigs });
          liveChat.updatedAt = Math.max(liveChat.updatedAt, savedUpdatedAt);
          triggerCurrentChatIfNeeded({ chatId });
        }
      }
    });

  const queueTail = operation.then(
    () => undefined,
    () => undefined,
  );
  persistentToolConfigUpdateQueues.set(chatId, queueTail);

  try {
    await operation;
  } finally {
    if (persistentToolConfigUpdateQueues.get(chatId) === queueTail) {
      persistentToolConfigUpdateQueues.delete(chatId);
    }
  }
}

export async function updateToolConfigsForChat({
  chatId,
  updater,
}: {
  chatId: ChatId;
  updater: ToolConfigsUpdater;
}): Promise<void> {
  ensureToolConfigPersistenceWatcher();

  if (!isToolConfigPersistenceEnabled()) {
    const liveChat = getLiveChatById({ chatId });
    const persistedToolConfigs = liveChat?.toolConfigs;
    const currentToolConfigs = getActiveChatToolConfigs({
      chatId,
      persistedToolConfigs,
    });
    const nextToolConfigs = updater({
      toolConfigs: cloneToolConfigs({ toolConfigs: currentToolConfigs }),
    });
    setRuntimeToolConfigsForChat({
      chatId,
      persistedToolConfigs,
      currentToolConfigs,
      nextToolConfigs,
    });
    triggerCurrentChatIfNeeded({ chatId });
    return;
  }

  await persistToolConfigUpdate({ chatId, updater });
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

  const updateToolConfigsForCurrentChat = async ({
    updater,
  }: {
    updater: ToolConfigsUpdater;
  }): Promise<void> => {
    if (_currentChatId.value === null) return;
    await updateToolConfigsForChat({ chatId: _currentChatId.value, updater });
  };

  const setToolStatus = async ({
    name,
    status,
  }: {
    name: LmToolName;
    status: ToolConfigStatus;
  }): Promise<void> => {
    if (_currentChatId.value === null) return;
    const chatId = _currentChatId.value;
    const key = builtinToolKeyForLmToolName({ name });

    await updateToolConfigsForCurrentChat({
      updater: ({ toolConfigs }) => setToolStatusWithDependenciesInToolConfigs({
        toolConfigs,
        key,
        status,
        inheritedToolConfigs: getInheritedToolConfigsForChat({ chatId }),
      }),
    });
  };

  const setToolEnabled = async ({
    name,
    enabled,
  }: {
    name: string;
    enabled: boolean;
  }): Promise<void> => {
    if (!isLmToolName(name)) return;
    await setToolStatus({
      name,
      status: enabled ? 'enabled' : 'disabled',
    });
  };

  const resetToolToInherited = async ({
    name,
  }: {
    name: LmToolName;
  }): Promise<void> => {
    await updateToolConfigsForCurrentChat({
      updater: ({ toolConfigs }) => removeSingletonToolConfig({
        toolConfigs,
        key: builtinToolKeyForLmToolName({ name }),
      }),
    });
  };


  const toggleTool = async ({ name }: { name: string }): Promise<void> => {
    await setToolEnabled({ name, enabled: !isToolEnabled({ name }) });
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
      _runtimeToolConfigChangesByChat,
      _currentChatId,
    },
  };
}
