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
  findLastToolConfigByKey,
  resolveToolConfigsForChat,
  setToolStatusWithDependenciesInToolConfigs,
  setWeshAccessScopeWithDependenciesInToolConfigs,
  toolConfigStatusForWeshAccessScope,
} from '@/services/tools/tool-config';

export type GlobalToolConfigsApi = {
  toolConfigs: ComputedRef<ToolConfig[] | undefined>;
  effectiveToolConfigs: ComputedRef<ToolConfig[]>;
  isEditable: ComputedRef<boolean>;
  setToolStatus: ({ key, status }: { key: BuiltinToolKey; status: ToolConfigStatus }) => Promise<void>;
  resetAllTools: () => Promise<void>;
  setWeshAccessScope: ({ accessScope }: { accessScope: NaidanSysfsAccessScope }) => Promise<void>;
  TEST_ONLY: Record<never, never>;
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
  const { settings, save } = useSettings();

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

  async function updateToolConfigs({ nextToolConfigs }: {
    nextToolConfigs: ToolConfig[] | undefined;
  }): Promise<void> {
    if (!isEditable.value) return;
    await save({
      patch: {
        experimental: {
          ...settings.value.experimental,
          toolConfigs: nextToolConfigs,
        },
      },
    });
  }

  async function setToolStatus({
    key,
    status,
  }: {
    key: BuiltinToolKey;
    status: ToolConfigStatus;
  }): Promise<void> {
    await updateToolConfigs({
      nextToolConfigs: setToolStatusWithDependenciesInToolConfigs({
        toolConfigs: toolConfigs.value,
        key,
        status,
        inheritedToolConfigs: applicationDefaults.value,
      }),
    });
  }


  async function resetAllTools(): Promise<void> {
    await updateToolConfigs({ nextToolConfigs: undefined });
  }

  async function setWeshAccessScope({
    accessScope,
  }: {
    accessScope: NaidanSysfsAccessScope;
  }): Promise<void> {
    const effectiveWesh = requireWeshConfig({
      config: findLastToolConfigByKey({
        toolConfigs: effectiveToolConfigs.value,
        key: 'builtin.wesh',
      }),
    });
    await updateToolConfigs({
      nextToolConfigs: setWeshAccessScopeWithDependenciesInToolConfigs({
        toolConfigs: toolConfigs.value,
        accessScope,
        inheritedToolConfigs: applicationDefaults.value,
        status: toolConfigStatusForWeshAccessScope({
          accessScope,
          currentStatus: effectiveWesh.status,
        }),
      }),
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
