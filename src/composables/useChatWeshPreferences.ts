import type { NaidanSysfsAccessScope } from '@/services/wesh/types';
import {
  findLastToolConfigByKey,
  setWeshNaidanSysfsAccessScopeInToolConfigs,
} from '@/services/tools/tool-config';
import { getLiveChatById } from '@/composables/chat/global/chat-core-singletons';
import {
  getEffectiveToolConfigsForChat,
  updateToolConfigsForChat,
} from '@/composables/useChatTools';

export function useChatWeshPreferences() {
  const getNaidanSysfsAccessScope = ({ chatId }: { chatId: string | undefined }): NaidanSysfsAccessScope => {
    if (chatId === undefined) {
      return 'none';
    }

    const liveChat = getLiveChatById({ chatId });
    const toolConfigs = getEffectiveToolConfigsForChat({
      chatId,
      persistedToolConfigs: liveChat?.toolConfigs,
    });
    return findLastToolConfigByKey({ toolConfigs, key: 'builtin.wesh' })
      ?.naidanSysfs.accessScope ?? 'none';
  };

  const setNaidanSysfsAccessScope = ({
    chatId,
    accessScope,
  }: {
    chatId: string | undefined;
    accessScope: NaidanSysfsAccessScope;
  }) => {
    if (chatId === undefined) return;

    updateToolConfigsForChat({
      chatId,
      updater: ({ toolConfigs }) => setWeshNaidanSysfsAccessScopeInToolConfigs({
        toolConfigs,
        accessScope,
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
