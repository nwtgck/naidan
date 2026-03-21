import { ref, computed } from 'vue';
import type { ToolCallRecord } from '@/services/tools/types';

const _enabledToolNames = ref<Set<string>>(new Set());
const _messageToolCalls = ref<Map<string, ToolCallRecord[]>>(new Map());

export function useChatTools() {
  const isToolEnabled = ({ name }: { name: string }) => {
    return _enabledToolNames.value.has(name);
  };

  const setToolEnabled = ({ name, enabled }: { name: string; enabled: boolean }) => {
    if (enabled) {
      _enabledToolNames.value.add(name);
    } else {
      _enabledToolNames.value.delete(name);
    }
  };

  const toggleTool = ({ name }: { name: string }) => {
    setToolEnabled({
      name,
      enabled: !_enabledToolNames.value.has(name),
    });
  };

  const enabledToolNames = computed(() => Array.from(_enabledToolNames.value));

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
    enabledToolNames,
    getToolCallsForMessage,
    addToolCall,
    updateToolCall,
    clearToolCallsForMessage,
    __testOnly: {
      _messageToolCalls,
    },
  };
}
