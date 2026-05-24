<script setup lang="ts">
import { computed } from 'vue';
import { TerminalIcon } from 'lucide-vue-next';
import { useChat } from '@/composables/useChat';
import { useChatTools } from '@/composables/useChatTools';
import { useChatWeshPreferences } from '@/composables/useChatWeshPreferences';
import { useFeatureFlags } from '@/composables/useFeatureFlags';
import { useSettings } from '@/composables/useSettings';
import type { NaidanSysfsMountSelection } from '@/services/wesh/types';
import { shouldIncludeWritableTmpMount } from '@/services/wesh/mount-policy';

const { currentChat } = useChat();
const { settings } = useSettings();
const { isToolEnabled, toggleTool } = useChatTools();
const { getNaidanSysfsMountSelection, setNaidanSysfsMountSelection } = useChatWeshPreferences();
const { isFeatureEnabled } = useFeatureFlags();
const isWeshToolFeatureEnabled = computed(() => isFeatureEnabled({ feature: 'wesh_tool' }));
const naidanSysfsMountSelection = computed(() => getNaidanSysfsMountSelection({ chatId: currentChat.value?.id }));
const isNaidanSysfsMounted = computed(() => naidanSysfsMountSelection.value !== 'none');
const hasWritableTmp = computed(() => shouldIncludeWritableTmpMount({ storageType: settings.value.storageType }));

function handleShellToolToggle(_args: Record<never, never>) {
  const enablingShellExecute = !isToolEnabled({ name: 'shell_execute' });
  toggleTool({ name: 'shell_execute' });
  if (enablingShellExecute && naidanSysfsMountSelection.value === 'none') {
    setNaidanSysfsMountSelection({ chatId: currentChat.value?.id, selection: 'current_chat_only' });
  }
}

function handleNaidanSysfsToggle(_args: Record<never, never>) {
  setNaidanSysfsMountSelection({
    chatId: currentChat.value?.id,
    selection: isNaidanSysfsMounted.value ? 'none' : 'current_chat_only',
  });
}

function handleNaidanSysfsSelectionChange({ event }: { event: Event }) {
  const target = event.target;
  if (!(target instanceof HTMLSelectElement)) {
    return;
  }
  const selection = target.value as NaidanSysfsMountSelection;
  switch (selection) {
  case 'none':
  case 'current_chat_only':
  case 'current_chat_with_chat_group':
  case 'all_chats':
    setNaidanSysfsMountSelection({ chatId: currentChat.value?.id, selection });
    break;
  default: {
    const _ex: never = selection;
    throw new Error(`Unhandled naidan sysfs selection: ${String(_ex)}`);
  }
  }
}

defineExpose({
  TEST_ONLY: {
    isNaidanSysfsMounted,
    naidanSysfsMountSelection,
  },
});
</script>

<template>
  <template v-if="isWeshToolFeatureEnabled">
    <button
      @click="handleShellToolToggle({})"
      class="w-full flex items-center justify-between px-2 py-1.5 rounded-lg transition-colors hover:bg-gray-50 dark:hover:bg-gray-800 text-left group"
      :class="[
        isToolEnabled({ name: 'shell_execute' }) ? 'bg-blue-50 dark:bg-blue-900/20 text-blue-600' : 'text-gray-600 dark:text-gray-300',
      ]"
      data-testid="tool-wesh-toggle"
    >
      <div class="flex items-center gap-2">
        <TerminalIcon class="w-4 h-4" :class="isToolEnabled({ name: 'shell_execute' }) ? 'text-blue-500' : 'text-gray-400'" />
        <span class="text-xs font-medium">
          <!--
            "Shell in browser" is user-facing copy only.
            Internal identifiers should stay standardized on "wesh".
            Debug-specific UI may intentionally expose "Wesh" directly instead.
          -->
          Shell in browser
        </span>
      </div>
      <div
        class="w-8 h-4 rounded-full relative transition-colors duration-200"
        :class="isToolEnabled({ name: 'shell_execute' }) ? 'bg-blue-500' : 'bg-gray-200 dark:bg-gray-700'"
      >
        <div
          class="absolute top-0.5 left-0.5 w-3 h-3 bg-white rounded-full transition-transform duration-200"
          :class="isToolEnabled({ name: 'shell_execute' }) ? 'translate-x-4' : 'translate-x-0'"
        />
      </div>
    </button>

    <div
      v-if="isToolEnabled({ name: 'shell_execute' })"
      class="mt-2 rounded-lg border border-gray-200/80 dark:border-gray-700/80 px-2 py-2"
      data-testid="naidan-sysfs-settings"
    >
      <p class="mb-2 text-[11px] text-gray-500 dark:text-gray-400" data-testid="wesh-storage-mode-note">
        {{ hasWritableTmp ? 'Writable /tmp is available with OPFS storage.' : 'Local and memory storage expose Wesh as read-only, without /tmp.' }}
      </p>
      <button
        @click="handleNaidanSysfsToggle({})"
        class="w-full flex items-center justify-between rounded-lg px-1.5 py-1 text-left transition-colors hover:bg-gray-50 dark:hover:bg-gray-800"
        data-testid="naidan-sysfs-toggle"
      >
        <div class="flex flex-col">
          <span class="text-xs font-medium text-gray-700 dark:text-gray-200">Mount `/sys/fs/naidan`</span>
          <span class="text-[11px] text-gray-500 dark:text-gray-400">Expose chat discovery paths to shell in browser</span>
        </div>
        <div
          class="w-8 h-4 rounded-full relative transition-colors duration-200"
          :class="isNaidanSysfsMounted ? 'bg-blue-500' : 'bg-gray-200 dark:bg-gray-700'"
        >
          <div
            class="absolute top-0.5 left-0.5 w-3 h-3 bg-white rounded-full transition-transform duration-200"
            :class="isNaidanSysfsMounted ? 'translate-x-4' : 'translate-x-0'"
          />
        </div>
      </button>

      <div v-if="isNaidanSysfsMounted" class="mt-2">
        <label class="block text-[11px] font-medium text-gray-500 dark:text-gray-400 mb-1" for="naidan-sysfs-visibility-select">
          Visibility
        </label>
        <select
          id="naidan-sysfs-visibility-select"
          :value="naidanSysfsMountSelection"
          class="w-full rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-2 py-1.5 text-xs text-gray-700 dark:text-gray-200"
          data-testid="naidan-sysfs-visibility-select"
          @change="handleNaidanSysfsSelectionChange({ event: $event })"
        >
          <option value="current_chat_only">Current chat</option>
          <option value="current_chat_with_chat_group">Current chat + chat group</option>
          <option value="all_chats">All chats</option>
        </select>
      </div>
    </div>
  </template>
</template>
