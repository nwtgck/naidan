<script setup lang="ts">
import { MoreHorizontal, Copy, Trash2 } from 'lucide-vue-next';
import type { ChatGroup } from '../models/types';

defineProps<{
  chatGroup: ChatGroup;
  isOpen: boolean;
}>();

defineEmits<{
  (e: 'toggle'): void;
  (e: 'duplicate'): void;
  (e: 'delete'): void;
}>();
</script>

<template>
  <div class="relative">
    <button 
      @click.stop="$emit('toggle')" 
      class="p-1 hover:text-blue-600 dark:hover:text-white transition-colors"
      :class="{ 'text-blue-600 dark:text-blue-400': isOpen }"
      title="More Actions"
      data-testid="group-more-actions"
    >
      <MoreHorizontal class="w-3.5 h-3.5" />
    </button>

    <Transition name="dropdown">
      <div 
        v-if="isOpen" 
        class="absolute right-0 top-full mt-1 w-48 bg-white dark:bg-gray-800 border border-gray-100 dark:border-gray-700 rounded-xl shadow-xl z-50 py-1 overflow-hidden"
      >
        <button 
          @click.stop="$emit('duplicate')" 
          class="w-full flex items-center gap-2 px-3 py-2 text-xs text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors"
          title="Duplicate Group" 
          data-testid="duplicate-group-button"
        >
          <Copy class="w-3.5 h-3.5" />
          <span>Duplicate Group</span>
        </button>
        <button 
          @click.stop="$emit('delete')" 
          class="w-full flex items-center gap-2 px-3 py-2 text-xs text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors"
          title="Delete Group" 
          data-testid="delete-group-button"
        >
          <Trash2 class="w-3.5 h-3.5" />
          <span>Delete Group</span>
        </button>
      </div>
    </Transition>
  </div>
</template>

<style scoped>
.dropdown-enter-active,
.dropdown-leave-active {
  transition: all 0.2s ease;
}

.dropdown-enter-from,
.dropdown-leave-to {
  opacity: 0;
  transform: scale(0.95) translateY(4px);
}
</style>
