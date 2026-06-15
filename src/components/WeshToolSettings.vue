<script setup lang="ts">
import { computed } from 'vue';
import { TerminalIcon, InfoIcon } from 'lucide-vue-next';
import { useChatTools } from '@/composables/useChatTools';
import { useChatWeshPreferences } from '@/composables/useChatWeshPreferences';
import { useFeatureFlags } from '@/composables/useFeatureFlags';
import { useSettings } from '@/composables/useSettings';
import { useToolDependencyActions } from '@/composables/useToolDependencyActions';
import { useCurrentChatState } from '@/composables/chat/ui/useCurrentChatState';
import type { NaidanSysfsAccessScope } from '@/services/wesh/types';
import { shouldIncludeWritableTmpMount } from '@/services/wesh/mount-policy';

const { currentChat } = useCurrentChatState();
const { settings } = useSettings();
const { isToolEnabled, toggleTool } = useChatTools();
const { getNaidanSysfsAccessScope, setNaidanSysfsAccessScope } = useChatWeshPreferences();
const {
  disableNaidanSysfsForCurrentChat,
  disableShellToolForCurrentChat,
} = useToolDependencyActions();
const { isFeatureEnabled } = useFeatureFlags();
const isWeshToolFeatureEnabled = computed(() => isFeatureEnabled({ feature: 'wesh_tool' }));
const naidanSysfsAccessScope = computed(() => getNaidanSysfsAccessScope({ chatId: currentChat.value?.id }));
const isNaidanSysfsMounted = computed(() => naidanSysfsAccessScope.value !== 'none');
const hasWritableTmp = computed(() => shouldIncludeWritableTmpMount({ storageType: settings.value.storageType }));

function handleShellToolToggle() {
  const enablingShellExecute = !isToolEnabled({ name: 'shell_execute' });
  if (!enablingShellExecute) {
    disableShellToolForCurrentChat()
    return
  }

  toggleTool({ name: 'shell_execute' });
  if (enablingShellExecute && naidanSysfsAccessScope.value === 'none') {
    setNaidanSysfsAccessScope({ chatId: currentChat.value?.id, accessScope: 'current_chat_only' });
  }
}

function handleNaidanSysfsToggle() {
  if (isNaidanSysfsMounted.value) {
    disableNaidanSysfsForCurrentChat()
    return
  }
  setNaidanSysfsAccessScope({
    chatId: currentChat.value?.id,
    accessScope: 'current_chat_only',
  });
}

function handleNaidanSysfsSelectionChange({ event }: { event: Event }) {
  const target = event.target;
  if (!(target instanceof HTMLSelectElement)) {
    return;
  }
  const accessScope = target.value as NaidanSysfsAccessScope;
  switch (accessScope) {
  case 'none':
  case 'current_chat_only':
  case 'current_chat_with_chat_group':
  case 'main_chats':
    setNaidanSysfsAccessScope({ chatId: currentChat.value?.id, accessScope });
    break;
  default: {
    const _ex: never = accessScope;
    throw new Error(`Unhandled naidan sysfs access scope: ${String(_ex)}`);
  }
  }
}

defineExpose({
  TEST_ONLY: {
    isNaidanSysfsMounted,
    naidanSysfsAccessScope,
  },
});
</script>

<template>
  <template v-if="isWeshToolFeatureEnabled">
    <button
      @click="handleShellToolToggle()"
      class="relative flex items-center gap-2.5 p-1.5 rounded-xl transition-all duration-300 text-left border overflow-hidden group active:scale-[0.98]"
      :class="isToolEnabled({ name: 'shell_execute' })
        ? 'bg-blue-50/50 dark:bg-blue-500/10 border-blue-200/50 dark:border-blue-500/30 shadow-sm'
        : 'bg-transparent border-gray-100 dark:border-gray-700/50 hover:border-gray-200 dark:hover:border-gray-700'"
      data-testid="tool-wesh-toggle"
    >
      <div
        class="p-1.5 rounded-lg transition-all duration-300 shrink-0"
        :class="isToolEnabled({ name: 'shell_execute' })
          ? 'bg-blue-600 text-white shadow-sm'
          : 'bg-gray-50 dark:bg-gray-900 text-gray-400 opacity-60'"
      >
        <TerminalIcon class="w-3.5 h-3.5" />
      </div>

      <div class="flex-1 min-w-0" :class="{ 'opacity-80': !isToolEnabled({ name: 'shell_execute' }) }">
        <div class="flex items-center gap-1.5">
          <span class="text-xs font-bold tracking-tight" :class="isToolEnabled({ name: 'shell_execute' }) ? 'text-blue-600 dark:text-blue-400' : 'text-gray-600 dark:text-gray-300'">Shell</span>
          <div v-if="isToolEnabled({ name: 'shell_execute' })" class="w-1 h-1 bg-blue-500 rounded-full"></div>
        </div>
        <div class="text-[10px] font-medium leading-tight truncate mt-0.5" :class="isToolEnabled({ name: 'shell_execute' }) ? 'text-gray-900 dark:text-gray-100' : 'text-gray-500 dark:text-gray-400'">
          <!--
            "Shell in browser" is user-facing copy only.
            Internal identifiers should stay standardized on "wesh".
            Debug-specific UI may intentionally expose "Wesh" directly instead.
          -->
          Shell in browser
        </div>
      </div>
    </button>

    <div
      v-if="isToolEnabled({ name: 'shell_execute' })"
      class="mt-3 space-y-3 p-3 bg-gray-50/50 dark:bg-gray-800/20 rounded-2xl border border-gray-100 dark:border-gray-700/50"
      data-testid="naidan-sysfs-settings"
    >
      <div class="flex items-start gap-2.5 px-1">
        <InfoIcon class="w-3.5 h-3.5 text-blue-500 shrink-0 mt-0.5" />
        <p class="text-[10px] leading-relaxed text-gray-500 dark:text-gray-400" data-testid="wesh-storage-mode-note">
          {{ hasWritableTmp ? 'Writable /tmp is available with OPFS storage.' : 'Local and memory storage expose Wesh as read-only, without /tmp.' }}
        </p>
      </div>

      <button
        @click="handleNaidanSysfsToggle()"
        class="w-full flex items-center justify-between rounded-xl px-2.5 py-2 text-left transition-colors bg-white dark:bg-gray-900 border border-gray-100 dark:border-gray-800 hover:border-blue-200 dark:hover:border-blue-900"
        data-testid="naidan-sysfs-toggle"
      >
        <div class="flex flex-col">
          <span class="text-[11px] font-bold text-gray-700 dark:text-gray-200">Mount `/sys/fs/naidan`</span>
          <span class="text-[10px] text-gray-500 dark:text-gray-400">Expose chat discovery paths</span>
        </div>
        <div
          class="w-7 h-3.5 rounded-full relative transition-colors duration-200"
          :class="isNaidanSysfsMounted ? 'bg-blue-500' : 'bg-gray-200 dark:bg-gray-700'"
        >
          <div
            class="absolute top-0.5 left-0.5 w-2.5 h-2.5 bg-white rounded-full transition-transform duration-200"
            :class="isNaidanSysfsMounted ? 'translate-x-3.5' : 'translate-x-0'"
          />
        </div>
      </button>

      <div v-if="isNaidanSysfsMounted" class="px-1">
        <label class="block text-[10px] font-black tracking-tight text-gray-400 mb-2" for="naidan-sysfs-access-scope-select">
          Visibility
        </label>
        <select
          id="naidan-sysfs-access-scope-select"
          :value="naidanSysfsAccessScope"
          class="w-full rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 py-2 text-[11px] text-gray-700 dark:text-gray-200 focus:outline-none focus:ring-1 focus:ring-blue-500/50"
          data-testid="naidan-sysfs-access-scope-select"
          @change="handleNaidanSysfsSelectionChange({ event: $event })"
        >
          <option value="current_chat_only">Current chat</option>
          <option value="current_chat_with_chat_group">Current chat + chat group</option>
          <option value="main_chats">All chats</option>
        </select>
      </div>
    </div>
  </template>
</template>
