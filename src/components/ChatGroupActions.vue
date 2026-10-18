<script setup lang="ts">
import { lazyStrings } from '@/strings';
import { ref } from 'vue';
import { MoreHorizontalIcon, CopyIcon, Trash2Icon, SearchIcon, PencilIcon } from 'lucide-vue-next';
import type { ChatGroup } from '@/01-models/types';

defineProps<{
  chatGroup: ChatGroup,
  isOpen: boolean,
}>();

defineEmits<{
  (e: 'toggle'): void,
  (e: 'duplicate'): void,
  (e: 'delete'): void,
  (e: 'search'): void,
  (e: 'rename', trigger: HTMLButtonElement | undefined): void,
}>();

const moreActionsButton = ref<HTMLButtonElement>();

defineExpose({
  ...((__BUILD_MODE_IS_TEST__ && {
    TEST_ONLY: {
      // Export internal state and logic used only for testing here. Do not reference these in production logic.
    },
  }) || {}),
});
</script>

<template>
  <div tw-class="relative">
    <button
      ref="moreActionsButton"
      @click.stop="$emit('toggle')"
      :tw-class="['p-1 hover:text-blue-600 dark:hover:text-white transition-colors', { 'text-blue-600 dark:text-blue-400': isOpen }]"
      :title="lazyStrings.ChatGroupActions__more_actions()"
      data-testid="group-more-actions"
    >
      <MoreHorizontalIcon tw-class="w-3.5 h-3.5" />
    </button>

    <Transition name="dropdown">
      <div
        v-if="isOpen"
        tw-class="absolute right-0 top-full mt-1.5 w-56 bg-white dark:bg-gray-800 border border-gray-200/80 dark:border-gray-700/80 rounded-xl shadow-lg shadow-black/15 z-50 p-1.5 overflow-hidden origin-top-right"
      >
        <button
          @click.stop="$emit('rename', moreActionsButton)"
          tw-class="w-full min-h-9 flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-left text-sm leading-5 text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700/60 transition-colors focus-visible:outline-none focus-visible:bg-gray-100 dark:focus-visible:bg-gray-700/60"
          data-testid="rename-group-button"
        >
          <PencilIcon tw-class="w-4 h-4 shrink-0 text-gray-400" />
          <span>{{ lazyStrings.ChatGroupNameDialog__rename_chat_group() }}</span>
        </button>
        <button
          @click.stop="$emit('search')"
          tw-class="w-full min-h-9 flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-left text-sm leading-5 text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700/60 transition-colors focus-visible:outline-none focus-visible:bg-gray-100 dark:focus-visible:bg-gray-700/60"
          :title="lazyStrings.ChatGroupActions__search_in_group()"
          data-testid="search-in-group-button"
        >
          <SearchIcon tw-class="w-4 h-4 shrink-0 text-gray-400" />
          <span>{{ lazyStrings.ChatGroupActions__search_in_group() }}</span>
        </button>
        <button
          @click.stop="$emit('duplicate')"
          tw-class="w-full min-h-9 flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-left text-sm leading-5 text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700/60 transition-colors focus-visible:outline-none focus-visible:bg-gray-100 dark:focus-visible:bg-gray-700/60"
          :title="lazyStrings.ChatGroupActions__duplicate_group()"
          data-testid="duplicate-group-button"
        >
          <CopyIcon tw-class="w-4 h-4 shrink-0 text-gray-400" />
          <span>{{ lazyStrings.ChatGroupActions__duplicate_group() }}</span>
        </button>
        <div tw-class="my-1 border-t border-gray-200/80 dark:border-gray-700/60" />
        <button
          @click.stop="$emit('delete')"
          tw-class="w-full min-h-9 flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-left text-sm leading-5 text-red-600 dark:text-red-400/90 hover:bg-red-50 dark:hover:bg-red-400/10 transition-colors focus-visible:outline-none focus-visible:bg-red-50 dark:focus-visible:bg-red-400/10"
          :title="lazyStrings.ChatGroupActions__delete_group()"
          data-testid="delete-group-button"
        >
          <Trash2Icon tw-class="w-4 h-4 shrink-0" />
          <span>{{ lazyStrings.ChatGroupActions__delete_group() }}</span>
        </button>
      </div>
    </Transition>
  </div>
</template>

<style scoped>
.dropdown-enter-active,
.dropdown-leave-active {
  transition: opacity 120ms ease, transform 120ms ease;
}

.dropdown-enter-from,
.dropdown-leave-to {
  opacity: 0;
  transform: translateY(-4px);
}
</style>
