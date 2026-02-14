<script setup lang="ts">
import { useToast } from '../composables/useToast';
import { X } from 'lucide-vue-next';

const { toasts, removeToast } = useToast();

async function handleAction(id: string, onAction?: () => void | Promise<void>) {
  if (onAction) {
    await onAction();
  }
  removeToast(id, 'action');
}


defineExpose({
  __testOnly: {
    // Export internal state and logic used only for testing here. Do not reference these in production logic.
  }
});
</script>

<template>
  <div class="fixed bottom-6 right-6 z-[250] flex flex-col gap-3 pointer-events-none">
    <TransitionGroup name="toast">
      <div
        v-for="toast in toasts"
        :key="toast.id"
        class="pointer-events-auto flex items-center gap-4 bg-gray-900 dark:bg-gray-800 text-white px-4 py-3 rounded-lg shadow-2xl border border-gray-700 min-w-[300px] max-w-md"
      >
        <span class="text-sm flex-1">{{ toast.message }}</span>

        <button
          v-if="toast.actionLabel"
          @click="handleAction(toast.id, toast.onAction)"
          class="text-indigo-400 hover:text-indigo-300 text-xs font-bold uppercase tracking-wider px-2 py-1"
        >
          {{ toast.actionLabel }}
        </button>

        <button
          @click="removeToast(toast.id, 'dismiss')"
          class="text-gray-500 hover:text-gray-300 transition-colors"
        >
          <X class="w-4 h-4" />
        </button>
      </div>
    </TransitionGroup>
  </div>
</template>

<style scoped>
.toast-enter-active,
.toast-leave-active {
  transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
}

.toast-enter-from {
  opacity: 0;
  transform: translateY(20px) scale(0.9);
}

.toast-leave-to {
  opacity: 0;
  transform: translateX(20px);
}

.toast-move {
  transition: transform 0.3s ease;
}
</style>
