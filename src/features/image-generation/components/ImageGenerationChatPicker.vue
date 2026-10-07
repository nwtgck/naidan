<script setup lang="ts">
import { computed, onScopeDispose, ref, watch } from 'vue';
import { CheckIcon, ChevronRightIcon, FolderIcon, MessageSquareIcon, PlusIcon, SearchIcon } from 'lucide-vue-next';
import { useCurrentChatState } from '@/composables/chat/ui/useCurrentChatState';
import { useChatLifecycle } from '@/composables/chat/ui/useChatLifecycle';
import { idToRaw, type ChatGroupId, type ChatId } from '@/01-models/ids';
import type { SidebarItem } from '@/01-models/types';
import { lazyStrings } from '@/strings';
const props = defineProps<{ selected: ChatId | undefined, disabled: boolean }>();
const emit = defineEmits<{ select: [chatId: ChatId] }>();
let disposed = false;
onScopeDispose(() => {
  disposed = true;
});
const { sidebarItems } = useCurrentChatState();
const { createChatWithoutSelecting } = useChatLifecycle();
const search = ref(''), creating = ref(false), failure = ref('');
const expanded = ref(new Set<ChatGroupId>());
const needle = computed(() => search.value.trim().normalize('NFC').toLocaleLowerCase());
function matches({ title }: { title: string | null }): boolean {
  const label = title || lazyStrings.SHARED__new_chat();
  return label !== undefined && label.normalize('NFC').toLocaleLowerCase().includes(needle.value);
}
const choices = computed(() => sidebarItems.value.flatMap<SidebarItem>(item => {
  switch (item.type) {
  case 'chat': return matches({ title: item.chat.title }) ? [item] : [];
  case 'chat_group': {
    const groupMatch = matches({ title: item.chatGroup.name });
    const items = item.chatGroup.items.filter(child => groupMatch || matches({ title: child.chat.title }));
    return groupMatch || items.length ? [{ ...item, chatGroup: { ...item.chatGroup, items } }] : [];
  }
  default: { const exhaustive: never = item; throw new Error(String(exhaustive)); }
  }
}));
watch([() => props.selected, sidebarItems], () => {
  for (const item of sidebarItems.value) {
    if (item.type === 'chat_group' && item.chatGroup.items.some(child => child.chat.id === props.selected)) expanded.value.add(item.chatGroup.id);
  }
}, { immediate: true });
function toggle({ groupId }: { groupId: ChatGroupId }): void {
  if (expanded.value.has(groupId)) expanded.value.delete(groupId);
  else expanded.value.add(groupId);
}
async function create({ groupId }: { groupId: ChatGroupId | undefined }): Promise<void> {
  if (creating.value || props.disabled) return;
  creating.value = true; failure.value = '';
  try {
    const chat = await createChatWithoutSelecting({ groupId, modelId: undefined, systemPrompt: undefined });
    if (chat && !disposed && !props.disabled) emit('select', chat.id);
  } catch (error) {
    if (!disposed) failure.value = error instanceof Error ? error.message : String(error);
  } finally {
    creating.value = false;
  }
}
defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>
<template>
  <section data-testid="workspace-chat-picker" tw-class="rounded-2xl border border-gray-200 dark:border-gray-700 overflow-hidden">
    <div tw-class="p-3 space-y-2 bg-gray-50/50 dark:bg-gray-800/20">
      <div tw-class="relative"><SearchIcon aria-hidden="true" tw-class="absolute left-3 top-2.5 w-4 h-4 text-gray-400" /><input v-model="search" type="search" :aria-label="lazyStrings.imageGeneration__search_chats()" :placeholder="lazyStrings.imageGeneration__search_chats()" data-testid="workspace-chat-search" tw-class="w-full rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 pl-9 pr-3 py-2 text-xs focus:outline-none focus:ring-2 focus:ring-blue-500" /></div>
      <button type="button" @click="create({ groupId: undefined })" :disabled="disabled || creating" data-testid="workspace-chat-create" tw-class="flex items-center gap-2 w-full rounded-xl px-3 py-2 text-xs font-semibold text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/20 disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"><PlusIcon tw-class="w-4 h-4" />{{ lazyStrings.imageGeneration__create_and_connect_chat() }}</button>
    </div>
    <ul tw-class="max-h-80 overflow-auto overscroll-contain p-2 space-y-1">
      <li v-for="item in choices" :key="item.id">
        <template v-if="item.type === 'chat_group'">
          <div tw-class="flex items-center gap-1">
            <button type="button" @click="toggle({ groupId: item.chatGroup.id })" :aria-expanded="!!needle || expanded.has(item.chatGroup.id)" tw-class="min-w-0 flex-1 flex items-center gap-2 rounded-xl px-2 py-2 text-sm font-semibold hover:bg-gray-100 dark:hover:bg-gray-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500">
              <ChevronRightIcon :tw-class="['w-3.5 h-3.5 shrink-0 transition-transform text-gray-400', needle || expanded.has(item.chatGroup.id) ? 'rotate-90' : '']" /><FolderIcon tw-class="w-4 h-4 shrink-0 text-gray-500" /><span tw-class="truncate">{{ item.chatGroup.name }}</span><span tw-class="ml-auto text-xs text-gray-400">{{ item.chatGroup.items.length }}</span>
            </button>
            <button type="button" @click="create({ groupId: item.chatGroup.id })" :disabled="disabled || creating" :aria-label="lazyStrings.imageGeneration__create_chat_in_group({ name: item.chatGroup.name })" :data-testid="'workspace-chat-create-' + idToRaw({ id: item.chatGroup.id })" tw-class="p-2 rounded-lg text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800 disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"><PlusIcon tw-class="w-4 h-4" /></button>
          </div>
          <ul v-if="needle || expanded.has(item.chatGroup.id)" tw-class="ml-5 pl-2 border-l border-gray-200 dark:border-gray-700 space-y-1">
            <li v-for="child in item.chatGroup.items" :key="child.id"><button type="button" @click="emit('select', child.chat.id)" :disabled="disabled || creating" :aria-pressed="selected === child.chat.id" :data-testid="'workspace-chat-choice-' + idToRaw({ id: child.chat.id })" :tw-class="['w-full flex items-center gap-2 rounded-xl px-3 py-2 text-xs text-left disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500', selected === child.chat.id ? 'bg-blue-50 dark:bg-blue-900/20 text-blue-600 dark:text-blue-400' : 'hover:bg-gray-100 dark:hover:bg-gray-800 text-gray-700 dark:text-gray-300']"><MessageSquareIcon tw-class="w-4 h-4 shrink-0" /><span tw-class="truncate">{{ child.chat.title || lazyStrings.SHARED__new_chat() }}</span><CheckIcon v-if="selected === child.chat.id" tw-class="ml-auto w-4 h-4 shrink-0" /></button></li>
          </ul>
        </template>
        <button v-else type="button" @click="emit('select', item.chat.id)" :disabled="disabled || creating" :aria-pressed="selected === item.chat.id" :data-testid="'workspace-chat-choice-' + idToRaw({ id: item.chat.id })" :tw-class="['w-full flex items-center gap-2 rounded-xl px-3 py-2 text-xs text-left disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500', selected === item.chat.id ? 'bg-blue-50 dark:bg-blue-900/20 text-blue-600 dark:text-blue-400' : 'hover:bg-gray-100 dark:hover:bg-gray-800 text-gray-700 dark:text-gray-300']"><MessageSquareIcon tw-class="w-4 h-4 shrink-0" /><span tw-class="truncate">{{ item.chat.title || lazyStrings.SHARED__new_chat() }}</span><CheckIcon v-if="selected === item.chat.id" tw-class="ml-auto w-4 h-4 shrink-0" /></button>
      </li>
    </ul>
    <p v-if="!choices.length" tw-class="p-3 text-xs text-gray-500 dark:text-gray-400">{{ lazyStrings.imageGeneration__no_chat_choices() }}</p>
    <p v-if="failure" role="alert" tw-class="p-3 text-xs text-red-600 dark:text-red-400 break-words">{{ failure }}</p>
  </section>
</template>
