<script setup lang="ts">
import { lazyStrings } from '@/strings';
import { computed } from 'vue';
import { TerminalIcon, InfoIcon } from 'lucide-vue-next';
import { useChatTools } from '@/features/tools/composables/useChatTools';
import { useChatWeshPreferences } from '@/features/tools/composables/useChatWeshPreferences';
import { useFeatureFlags } from '@/composables/useFeatureFlags';
import { useSettings } from '@/composables/useSettings';
import { useToolDependencyActions } from '@/features/tools/composables/useToolDependencyActions';
import { useCurrentChatState } from '@/composables/chat/ui/useCurrentChatState';
import type { NaidanSysfsAccessScope } from '@/features/wesh/types';
import { shouldIncludeWritableTmpMount } from '@/features/wesh/mount-policy';

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
    disableShellToolForCurrentChat();
    return;
  }

  toggleTool({ name: 'shell_execute' });
  if (enablingShellExecute && naidanSysfsAccessScope.value === 'none') {
    setNaidanSysfsAccessScope({ chatId: currentChat.value?.id, accessScope: 'current_chat_only' });
  }
}

function handleNaidanSysfsToggle() {
  if (isNaidanSysfsMounted.value) {
    disableNaidanSysfsForCurrentChat();
    return;
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
  ...((__BUILD_MODE_IS_TEST__ && {
    TEST_ONLY: {
      isNaidanSysfsMounted,
      naidanSysfsAccessScope,
    },
  }) || {}),
});
</script>

<template>
  <template v-if="isWeshToolFeatureEnabled">
    <button
      @click="handleShellToolToggle()"
      :tw-class="['relative flex items-center gap-2.5 p-1.5 rounded-xl transition-all duration-300 text-left border overflow-hidden group active:scale-[0.98]', isToolEnabled({ name: 'shell_execute' })
        ? 'bg-blue-50/50 dark:bg-blue-500/10 border-blue-200/50 dark:border-blue-500/30 shadow-sm'
        : 'bg-transparent border-gray-100 dark:border-gray-700/50 hover:border-gray-200 dark:hover:border-gray-700']"
      :aria-expanded="isToolEnabled({ name: 'shell_execute' })"
      aria-controls="shell-tool-settings"
      data-testid="tool-wesh-toggle"
    >
      <div
        :tw-class="['p-1.5 rounded-lg transition-all duration-300 shrink-0', isToolEnabled({ name: 'shell_execute' })
          ? 'bg-blue-600 text-white shadow-sm'
          : 'bg-gray-50 dark:bg-gray-900 text-gray-400 opacity-60']"
      >
        <TerminalIcon tw-class="w-3.5 h-3.5" />
      </div>

      <div :tw-class="['flex-1 min-w-0', { 'opacity-80': !isToolEnabled({ name: 'shell_execute' }) }]">
        <div tw-class="flex items-center gap-1.5">
          <span :tw-class="['text-xs font-bold tracking-tight', isToolEnabled({ name: 'shell_execute' }) ? 'text-blue-600 dark:text-blue-400' : 'text-gray-600 dark:text-gray-300']">{{ lazyStrings.WeshToolSettings__shell() }}</span>
          <div v-if="isToolEnabled({ name: 'shell_execute' })" tw-class="w-1 h-1 bg-blue-500 rounded-full"></div>
        </div>
        <div :tw-class="['text-[10px] font-medium leading-tight truncate mt-0.5', isToolEnabled({ name: 'shell_execute' }) ? 'text-gray-900 dark:text-gray-100' : 'text-gray-500 dark:text-gray-400']">
          <!--
            This label is user-facing copy only.
            Internal identifiers should stay standardized on "wesh".
            Debug-specific UI may intentionally expose "Wesh" directly instead.
          -->
          {{ lazyStrings.WeshToolSettings__shell_in_browser() }}
        </div>
      </div>
    </button>

    <section
      v-if="isToolEnabled({ name: 'shell_execute' })"
      id="shell-tool-settings"
      tw-class="sm:col-span-2 mt-1 overflow-hidden rounded-2xl border border-blue-200/60 dark:border-blue-500/20 bg-white/70 dark:bg-gray-900/30 shadow-sm"
      data-testid="naidan-sysfs-settings"
    >
      <header tw-class="flex items-start justify-between gap-3 px-3 py-2.5 border-b border-gray-100 dark:border-gray-700/60 bg-blue-50/40 dark:bg-blue-500/5">
        <div tw-class="min-w-0">
          <h3 tw-class="text-[11px] font-bold tracking-tight text-gray-700 dark:text-gray-200">
            {{ lazyStrings.WeshToolSettings__shell_settings() }}
          </h3>
          <p tw-class="mt-0.5 text-[10px] leading-relaxed text-gray-500 dark:text-gray-400">
            {{ lazyStrings.SHARED__configure_browser_based_shell_access() }}
          </p>
        </div>
      </header>

      <div tw-class="divide-y divide-gray-100 dark:divide-gray-700/60">
        <button
          @click="handleNaidanSysfsToggle()"
          tw-class="w-full grid grid-cols-[minmax(0,1fr)_auto] items-center gap-4 px-3 py-3 text-left transition-colors hover:bg-gray-50/70 dark:hover:bg-gray-800/30"
          role="switch"
          :aria-checked="isNaidanSysfsMounted"
          data-testid="naidan-sysfs-toggle"
        >
          <span tw-class="min-w-0">
            <span tw-class="block text-[11px] font-bold text-gray-700 dark:text-gray-200">
              {{ lazyStrings.SHARED__mount() }} <code tw-class="font-mono text-[10px]">/sys/fs/naidan</code>
            </span>
            <span tw-class="block mt-0.5 text-[10px] leading-relaxed text-gray-500 dark:text-gray-400">
              {{ lazyStrings.SHARED__expose_chat_discovery_paths() }}
            </span>
          </span>

          <span
            :tw-class="['w-7 h-3.5 rounded-full relative transition-colors duration-200', isNaidanSysfsMounted ? 'bg-blue-500' : 'bg-gray-200 dark:bg-gray-700']"
          >
            <span
              :tw-class="['absolute top-0.5 left-0.5 w-2.5 h-2.5 bg-white rounded-full transition-transform duration-200', isNaidanSysfsMounted ? 'translate-x-3.5' : 'translate-x-0']"
            ></span>
          </span>
        </button>

        <div
          v-if="isNaidanSysfsMounted"
          tw-class="grid grid-cols-1 sm:grid-cols-[minmax(0,1fr)_auto] items-center gap-2 sm:gap-4 px-3 py-3"
        >
          <div tw-class="min-w-0">
            <label tw-class="block text-[11px] font-bold text-gray-700 dark:text-gray-200" for="naidan-sysfs-access-scope-select">
              {{ lazyStrings.SHARED__visibility() }}
            </label>
            <p tw-class="mt-0.5 text-[10px] leading-relaxed text-gray-500 dark:text-gray-400">
              {{ lazyStrings.SHARED__choose_which_chats_are_visible_to_the_shell() }}
            </p>
          </div>

          <select
            id="naidan-sysfs-access-scope-select"
            :value="naidanSysfsAccessScope"
            tw-class="w-full sm:w-52 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 py-2 text-[11px] text-gray-700 dark:text-gray-200 focus:outline-none focus:ring-1 focus:ring-blue-500/50"
            data-testid="naidan-sysfs-access-scope-select"
            @change="handleNaidanSysfsSelectionChange({ event: $event })"
          >
            <option value="current_chat_only">{{ lazyStrings.SHARED__current_chat() }}</option>
            <option value="current_chat_with_chat_group">{{ lazyStrings.SHARED__current_chat_plus_chat_group() }}</option>
            <option value="main_chats">{{ lazyStrings.SHARED__all_chats() }}</option>
          </select>
        </div>
      </div>

      <div tw-class="flex items-start gap-2.5 px-3 py-2.5 border-t border-gray-100 dark:border-gray-700/60 bg-gray-50/50 dark:bg-gray-950/20">
        <InfoIcon tw-class="w-3.5 h-3.5 text-blue-500 shrink-0 mt-0.5" />
        <p tw-class="text-[10px] leading-relaxed text-gray-500 dark:text-gray-400" data-testid="wesh-storage-mode-note">
          {{ hasWritableTmp ? lazyStrings.SHARED__writable_tmp_is_available_with_opfs_storage() : lazyStrings.SHARED__local_and_memory_storage_expose_wesh_as_read_only_without_tmp() }}
        </p>
      </div>
    </section>
  </template>
</template>
