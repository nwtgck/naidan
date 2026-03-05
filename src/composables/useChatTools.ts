import { ref, computed } from 'vue';

const _enabledToolNames = ref<Set<string>>(new Set());
const _toolExecutionStatus = ref<string | null>(null);

export function useChatTools() {
  const isToolEnabled = ({ name }: { name: string }) => {
    return _enabledToolNames.value.has(name);
  };

  const toggleTool = ({ name }: { name: string }) => {
    if (_enabledToolNames.value.has(name)) {
      _enabledToolNames.value.delete(name);
    } else {
      _enabledToolNames.value.add(name);
    }
  };

  const enabledToolNames = computed(() => Array.from(_enabledToolNames.value));

  const toolExecutionStatus = computed(() => _toolExecutionStatus.value);

  const handleToolCall = ({ toolName, args }: { toolName: string; args: unknown }) => {
    if (toolName === 'calculator') {
      const expression = (args as { expression?: string })?.expression || '...';
      _toolExecutionStatus.value = `Calculating: ${expression}...`;
    } else {
      _toolExecutionStatus.value = `Using tool: ${toolName}...`;
    }
  };

  const clearToolExecutionStatus = () => {
    _toolExecutionStatus.value = null;
  };

  return {
    isToolEnabled,
    toggleTool,
    enabledToolNames,
    toolExecutionStatus,
    handleToolCall,
    clearToolExecutionStatus,
    __testOnly: {
      // Export internal state and logic used only for testing here. Do not reference these in production logic.
    },
  };
}
