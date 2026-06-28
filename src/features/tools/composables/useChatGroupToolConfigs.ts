import { computed, type ComputedRef } from 'vue';
import { useSettings } from '@/composables/useSettings';
import { useChatGroups } from '@/composables/chat/useChatGroups';
import { useCurrentChatState } from '@/composables/chat/ui/useCurrentChatState';
import type {
  BuiltinToolKey,
  ToolConfig,
  ToolConfigStatus,
  WeshToolConfig,
} from '@/01-models/tool';
import type { NaidanSysfsAccessScope } from '@/features/wesh/types';
import {
  findLastToolConfigByKey,
  removeSingletonToolConfig,
  resolveToolConfigsForChat,
  setToolStatusWithDependenciesInToolConfigs,
  setWeshAccessScopeWithDependenciesInToolConfigs,
  toolConfigStatusForWeshAccessScope,
} from '@/features/tools/tool-config';

export type ChatGroupToolConfigsApi = {
  toolConfigs: ComputedRef<ToolConfig[] | undefined>,
  inheritedToolConfigs: ComputedRef<ToolConfig[]>,
  effectiveToolConfigs: ComputedRef<ToolConfig[]>,
  isEditable: ComputedRef<boolean>,
  setToolStatus: ({ key, status }: { key: BuiltinToolKey, status: ToolConfigStatus }) => Promise<void>,
  resetTool: ({ key }: { key: BuiltinToolKey }) => Promise<void>,
  setWeshAccessScope: ({ accessScope }: { accessScope: NaidanSysfsAccessScope }) => Promise<void>,
  TEST_ONLY: Record<never, never>,
};

function requireWeshConfig({ config }: { config: WeshToolConfig | undefined }): WeshToolConfig {
  switch (config) {
  case undefined:
    throw new Error('Expected resolved Wesh tool config');
  default:
    return config;
  }
}

export function useChatGroupToolConfigs(): ChatGroupToolConfigsApi {
  const { settings } = useSettings();
  const { currentChatGroup } = useCurrentChatState();
  const chatGroups = useChatGroups();

  const toolConfigs = computed(() => currentChatGroup.value?.toolConfigs);
  const inheritedToolConfigs = computed(() => resolveToolConfigsForChat({
    globalToolConfigs: settings.value.experimental?.toolConfigs,
    chatGroupToolConfigs: undefined,
    chatToolConfigs: undefined,
  }));
  const effectiveToolConfigs = computed(() => resolveToolConfigsForChat({
    globalToolConfigs: settings.value.experimental?.toolConfigs,
    chatGroupToolConfigs: toolConfigs.value,
    chatToolConfigs: undefined,
  }));
  const isEditable = computed(() => settings.value.experimental?.toolConfigPersistence === 'enabled');

  async function updateToolConfigs({
    updater,
  }: {
    updater: ({ toolConfigs }: { toolConfigs: ToolConfig[] | undefined }) => ToolConfig[] | undefined,
  }): Promise<void> {
    if (!isEditable.value || currentChatGroup.value === null) return;
    await chatGroups.updateToolConfigs({
      chatGroupId: currentChatGroup.value.id,
      updater,
    });
  }

  async function setToolStatus({
    key,
    status,
  }: {
    key: BuiltinToolKey,
    status: ToolConfigStatus,
  }): Promise<void> {
    await updateToolConfigs({
      updater: ({ toolConfigs: currentToolConfigs }) => setToolStatusWithDependenciesInToolConfigs({
        toolConfigs: currentToolConfigs,
        key,
        status,
        inheritedToolConfigs: inheritedToolConfigs.value,
      }),
    });
  }

  async function resetTool({ key }: { key: BuiltinToolKey }): Promise<void> {
    await updateToolConfigs({
      updater: ({ toolConfigs: currentToolConfigs }) => removeSingletonToolConfig({
        toolConfigs: currentToolConfigs,
        key,
      }),
    });
  }


  async function setWeshAccessScope({
    accessScope,
  }: {
    accessScope: NaidanSysfsAccessScope,
  }): Promise<void> {
    await updateToolConfigs({
      updater: ({ toolConfigs: currentToolConfigs }) => {
        const inherited = inheritedToolConfigs.value;
        const effectiveWesh = requireWeshConfig({
          config: findLastToolConfigByKey({
            toolConfigs: currentToolConfigs,
            key: 'builtin.wesh',
          }) ?? findLastToolConfigByKey({
            toolConfigs: inherited,
            key: 'builtin.wesh',
          }),
        });
        return setWeshAccessScopeWithDependenciesInToolConfigs({
          toolConfigs: currentToolConfigs,
          accessScope,
          inheritedToolConfigs: inherited,
          status: toolConfigStatusForWeshAccessScope({
            accessScope,
            currentStatus: effectiveWesh.status,
          }),
        });
      },
    });
  }

  return {
    toolConfigs,
    inheritedToolConfigs,
    effectiveToolConfigs,
    isEditable,
    setToolStatus,
    resetTool,
    setWeshAccessScope,
    TEST_ONLY: {},
  };
}
