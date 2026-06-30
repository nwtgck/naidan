import type { ChatId } from '@/01-models/ids';
import type { NaidanSysfsAccessScope } from '@/features/wesh/types';
import {
  findLastToolConfigByKey,
  resolveToolConfigsForChat,
  setWeshAccessScopeWithDependenciesInToolConfigs,
  toolConfigStatusForWeshAccessScope,
} from '@/features/tools/tool-config';
import type { ToolConfig, WeshToolConfig } from '@/01-models/tool';
import {
  getInheritedToolConfigsForChat,
  getToolResolutionForChat,
  updateToolConfigsForChat,
} from '@/features/tools/composables/useChatTools';

function requireWeshConfig({
  config,
}: {
  config: ToolConfig | undefined,
}): WeshToolConfig {
  switch (config?.key) {
  case undefined:
    throw new Error('Expected resolved Wesh tool config');
  case 'builtin.wesh':
    return config;
  case 'builtin.calculator':
  case 'builtin.choices':
  case 'builtin.wikipedia':
    throw new Error(`Expected Wesh tool config, received: ${config.key}`);
  default: {
    const _ex: never = config;
    throw new Error(`Unhandled tool config: ${String(_ex)}`);
  }
  }
}

export function useChatWeshPreferences() {
  const getNaidanSysfsAccessScope = ({ chatId }: { chatId: ChatId | undefined }): NaidanSysfsAccessScope => {
    if (chatId === undefined) {
      return 'none';
    }

    return requireWeshConfig({
      config: getToolResolutionForChat({ chatId, key: 'builtin.wesh' }).config,
    }).naidanSysfs.accessScope;
  };

  const setNaidanSysfsAccessScope = async ({
    chatId,
    accessScope,
  }: {
    chatId: ChatId | undefined,
    accessScope: NaidanSysfsAccessScope,
  }): Promise<void> => {
    if (chatId === undefined) return;
    await updateToolConfigsForChat({
      chatId,
      updater: ({ toolConfigs }) => {
        const inheritedToolConfigs = getInheritedToolConfigsForChat({ chatId });
        const currentConfig = requireWeshConfig({
          config: findLastToolConfigByKey({
            toolConfigs: resolveToolConfigsForChat({
              globalToolConfigs: inheritedToolConfigs,
              chatGroupToolConfigs: undefined,
              chatToolConfigs: toolConfigs,
            }),
            key: 'builtin.wesh',
          }),
        });
        return setWeshAccessScopeWithDependenciesInToolConfigs({
          toolConfigs,
          accessScope,
          inheritedToolConfigs,
          status: toolConfigStatusForWeshAccessScope({
            accessScope,
            currentStatus: currentConfig.status,
          }),
        });
      },
    });
  };

  return {
    getNaidanSysfsAccessScope,
    setNaidanSysfsAccessScope,
    ...((__BUILD_MODE_IS_TEST__ && {
      TEST_ONLY: {
        // Export internal state and logic used only for testing here. Do not reference these in production logic.
        // ESLint-required for useXxx return objects.
      },
    }) || {}),
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {};
