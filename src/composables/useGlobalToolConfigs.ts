import { computed, type ComputedRef } from 'vue';
import { useSettings } from '@/composables/useSettings';
import type {
  BuiltinToolKey,
  ToolConfig,
  ToolConfigStatus,
  WeshToolConfig,
} from '@/services/tools/types';
import type { NaidanSysfsAccessScope } from '@/services/wesh/types';
import {
  cloneToolConfigs,
  findLastToolConfigByKey,
  resolveToolConfigsForChat,
  setToolStatusWithDependenciesInToolConfigs,
  setWeshAccessScopeWithDependenciesInToolConfigs,
  toolConfigStatusForWeshAccessScope,
} from '@/services/tools/tool-config';

export type GlobalToolConfigsApi = {
  toolConfigs: ComputedRef<ToolConfig[] | undefined>,
  effectiveToolConfigs: ComputedRef<ToolConfig[]>,
  isEditable: ComputedRef<boolean>,
  setToolStatus: ({ key, status }: { key: BuiltinToolKey, status: ToolConfigStatus }) => Promise<void>,
  resetAllTools: () => Promise<void>,
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

export function useGlobalToolConfigs(): GlobalToolConfigsApi {
  const { settings, updateExperimental } = useSettings();

  const toolConfigs = computed(() => settings.value.experimental?.toolConfigs);
  const applicationDefaults = computed(() => resolveToolConfigsForChat({
    globalToolConfigs: undefined,
    chatGroupToolConfigs: undefined,
    chatToolConfigs: undefined,
  }));
  const effectiveToolConfigs = computed(() => resolveToolConfigsForChat({
    globalToolConfigs: toolConfigs.value,
    chatGroupToolConfigs: undefined,
    chatToolConfigs: undefined,
  }));
  const isEditable = computed(() => settings.value.experimental?.toolConfigPersistence === 'enabled');

  async function updateToolConfigs({
    updater,
  }: {
    updater: ({ toolConfigs }: { toolConfigs: ToolConfig[] | undefined }) => ToolConfig[] | undefined,
  }): Promise<void> {
    if (!isEditable.value) return;
    await updateExperimental({
      updater: ({ experimental }) => ({
        ...experimental,
        toolConfigs: cloneToolConfigs({
          toolConfigs: updater({
            toolConfigs: cloneToolConfigs({ toolConfigs: experimental?.toolConfigs }),
          }),
        }),
      }),
    });
  }

  async function setToolStatus({
    key,
    status,
  }: {
    key: BuiltinToolKey,
    status: ToolConfigStatus,
  }): Promise<void> {
    const inherited = applicationDefaults.value;
    await updateToolConfigs({
      updater: ({ toolConfigs: currentToolConfigs }) => setToolStatusWithDependenciesInToolConfigs({
        toolConfigs: currentToolConfigs,
        key,
        status,
        inheritedToolConfigs: inherited,
      }),
    });
  }


  async function resetAllTools(): Promise<void> {
    await updateToolConfigs({ updater: () => undefined });
  }

  async function setWeshAccessScope({
    accessScope,
  }: {
    accessScope: NaidanSysfsAccessScope,
  }): Promise<void> {
    const inherited = applicationDefaults.value;
    await updateToolConfigs({
      updater: ({ toolConfigs: currentToolConfigs }) => {
        const effectiveWesh = requireWeshConfig({
          config: findLastToolConfigByKey({
            toolConfigs: resolveToolConfigsForChat({
              globalToolConfigs: currentToolConfigs,
              chatGroupToolConfigs: undefined,
              chatToolConfigs: undefined,
            }),
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
    effectiveToolConfigs,
    isEditable,
    setToolStatus,
    resetAllTools,
    setWeshAccessScope,
    TEST_ONLY: {},
  };
}
