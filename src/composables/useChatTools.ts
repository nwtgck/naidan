import { ref, computed } from 'vue';
import type { ToolCallRecord } from '@/services/tools/types';

const _toolEnabledByChat = ref<Map<string, Set<string>>>(new Map());
const _messageToolCalls = ref<Map<string, ToolCallRecord[]>>(new Map());
const _currentChatId = ref<string | null>(null);

export function useChatTools() {
  const isToolEnabled = ({ name }: { name: string }) => {
    if (_currentChatId.value === null) return false;
    return _toolEnabledByChat.value.get(_currentChatId.value)?.has(name) ?? false;
  };

  const setToolEnabled = ({ name, enabled }: { name: string; enabled: boolean }) => {
    if (_currentChatId.value === null) return;
    const chatId = _currentChatId.value;
    const current = _toolEnabledByChat.value.get(chatId) ?? new Set<string>();
    const next = new Set(current);
    if (enabled) {
      next.add(name);
    } else {
      next.delete(name);
    }
    const nextMap = new Map(_toolEnabledByChat.value);
    nextMap.set(chatId, next);
    _toolEnabledByChat.value = nextMap;
  };

  const toggleTool = ({ name }: { name: string }) => {
    setToolEnabled({ name, enabled: !isToolEnabled({ name }) });
  };

  const setCurrentChatId = ({ chatId }: { chatId: string | null }) => {
    _currentChatId.value = chatId;
  };

  const enabledToolNames = computed(() => {
    if (_currentChatId.value === null) return [];
    return Array.from(_toolEnabledByChat.value.get(_currentChatId.value) ?? []);
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
    update: | { status: 'success'; result: { content: import('../services/tools/types').TextOrBinaryObject } } | { status: 'error'; error: { message: import('../services/tools/types').TextOrBinaryObject } }
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
    enabledToolNames,
    getToolCallsForMessage,
    addToolCall,
    updateToolCall,
    clearToolCallsForMessage,
    __testOnly: {
      _messageToolCalls,
      _toolEnabledByChat,
      _currentChatId,
    },
  };
}
