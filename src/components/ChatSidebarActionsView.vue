<script setup lang="ts">
import { computed } from 'vue';
import { FolderPlusIcon, MessageSquarePlusIcon, SearchIcon, SquarePenIcon } from 'lucide-vue-next';
import { lazyStrings } from '@/strings';

const props = defineProps<{
  expanded: boolean,
  contentReady: boolean,
  interaction: 'preparing' | 'ready',
  groupContext: { name: string | undefined } | undefined,
}>();
const emit = defineEmits<{ newChat: [], newChatInGroup: [], search: [], createChatGroup: [] }>();
const isMac = typeof window !== 'undefined' && /Mac|iPod|iPhone|iPad/.test(navigator.platform);
const newChatShortcutText = isMac ? '⌘⇧O' : 'Ctrl+Shift+O';
const newChatTitle = computed(() => {
  const label = lazyStrings.SHARED__new_chat();
  return label === undefined ? undefined : `${label} (${newChatShortcutText})`;
});
const newChatInGroupTitle = computed(() => {
  const groupName = props.groupContext?.name || lazyStrings.Sidebar__current_group();
  return groupName === undefined ? undefined : lazyStrings.Sidebar__new_chat_in_group({ groupName });
});

defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>

<template>
  <div :tw-class="['flex gap-2', { 'flex-col items-center': !expanded }]" :inert="interaction === 'preparing' || undefined" :aria-hidden="interaction === 'preparing' || undefined" data-testid="chat-sidebar-actions">
    <button type="button" @click="interaction === 'ready' && emit('newChat')" :tw-class="['flex items-center justify-center gap-1.5 bg-blue-600 hover:bg-blue-700 text-white rounded-xl transition-all font-bold shadow-lg shadow-blue-500/20 disabled:opacity-50', expanded ? 'flex-1 min-w-0 px-3 py-2 text-xs' : 'w-8 h-8']" data-testid="new-chat-button" :title="newChatTitle" :aria-label="newChatTitle">
      <SquarePenIcon aria-hidden="true" tw-class="w-4 h-4 shrink-0" /><template v-if="expanded"><span tw-class="truncate">{{ lazyStrings.SHARED__new_chat() }}</span></template>
    </button>
    <button v-if="!expanded && groupContext" type="button" @click="interaction === 'ready' && emit('newChatInGroup')" tw-class="flex items-center justify-center bg-gray-50 dark:bg-gray-800 hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-600 dark:text-gray-300 rounded-xl border border-gray-100 dark:border-gray-700 transition-all shadow-sm w-8 h-8" data-testid="new-chat-in-group-button" :title="newChatInGroupTitle" :aria-label="newChatInGroupTitle">
      <MessageSquarePlusIcon aria-hidden="true" tw-class="w-4 h-4 shrink-0" />
    </button>
    <button type="button" @click="interaction === 'ready' && emit('search')" :tw-class="['shrink-0 bg-gray-50 dark:bg-gray-800 hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-600 dark:text-gray-300 rounded-xl border border-gray-100 dark:border-gray-700 transition-colors shadow-sm', expanded ? 'p-2' : 'w-8 h-8 flex items-center justify-center p-0']" :title="lazyStrings.Sidebar__search_cmd_k()" :aria-label="lazyStrings.Sidebar__search_cmd_k()" data-testid="search-button">
      <SearchIcon aria-hidden="true" tw-class="w-4 h-4" />
    </button>
    <button v-if="expanded" type="button" :disabled="!contentReady" @click="interaction === 'ready' && contentReady && emit('createChatGroup')" tw-class="shrink-0 p-2 bg-gray-50 dark:bg-gray-800 hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-600 dark:text-gray-300 rounded-xl border border-gray-100 dark:border-gray-700 transition-colors shadow-sm" :title="lazyStrings.Sidebar__create_chat_group()" :aria-label="lazyStrings.Sidebar__create_chat_group()" data-testid="create-chat-group-button">
      <FolderPlusIcon aria-hidden="true" tw-class="w-4 h-4" />
    </button>
  </div>
</template>
