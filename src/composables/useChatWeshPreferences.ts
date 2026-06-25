import type { ChatId } from '@/models/ids';
import type { NaidanSysfsAccessScope } from '@/services/wesh/types';
import {
  setWeshAccessScopeWithDependenciesInToolConfigs,
  toolConfigStatusForWeshAccessScope,
} from '@/services/tools/tool-config';
import type { WeshToolConfig } from '@/services/tools/types';
import {
  getInheritedToolConfigsForChat,
  getToolResolutionForChat,
  updateToolConfigsForChat,
} from '@/composables/useChatTools';

function requireWeshConfig({
  config,
}: {
  config: ReturnType<typeof getToolResolutionForChat>['config'];
}): WeshToolConfig {
  switch (config.key) {
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

  const setNaidanSysfsAccessScope = ({
    chatId,
    accessScope,
  }: {
    chatId: ChatId | undefined;
    accessScope: NaidanSysfsAccessScope;
  }) => {
    if (chatId === undefined) return;
    const inheritedToolConfigs = getInheritedToolConfigsForChat({ chatId });
    const currentConfig = requireWeshConfig({
      config: getToolResolutionForChat({ chatId, key: 'builtin.wesh' }).config,
    });

    updateToolConfigsForChat({
      chatId,
      updater: ({ toolConfigs }) => setWeshAccessScopeWithDependenciesInToolConfigs({
        toolConfigs,
        accessScope,
        inheritedToolConfigs,
        status: toolConfigStatusForWeshAccessScope({
          accessScope,
          currentStatus: currentConfig.status,
        }),
      }),
    });
  };

  return {
    getNaidanSysfsAccessScope,
    setNaidanSysfsAccessScope,
    TEST_ONLY: {
      // Export internal state and logic used only for testing here. Do not reference these in production logic.
      // ESLint-required for useXxx return objects.
    },
  };
}
