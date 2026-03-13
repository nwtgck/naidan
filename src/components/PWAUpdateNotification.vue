<script setup lang="ts">
import { RotateCw } from 'lucide-vue-next';
import { usePWAUpdate } from '@/composables/usePWAUpdate';
import { useLayout } from '@/composables/useLayout';

const { needRefresh, update } = usePWAUpdate();
const { isSidebarOpen } = useLayout();


defineExpose({
  __testOnly: {
    // Export internal state and logic used only for testing here. Do not reference these in production logic.
  }
});
</script>

<template>
  <Transition
    enter-active-class="transition duration-700 cubic-bezier(0.16, 1, 0.3, 1)"
    enter-from-class="transform -translate-y-2 opacity-0 scale-95"
    enter-to-class="transform translate-y-0 opacity-100 scale-100"
    leave-active-class="transition duration-300 ease-in"
    leave-from-class="transform translate-y-0 opacity-100 scale-100"
    leave-to-class="transform -translate-y-2 opacity-0 scale-95"
  >
    <div v-if="needRefresh && isSidebarOpen" class="px-4 pb-3">
      <button
        @click="update"
        class="w-full flex items-center justify-center gap-2.5 px-3 py-2.5 bg-emerald-500/10 hover:bg-emerald-500/15 dark:bg-emerald-400/10 dark:hover:bg-emerald-400/15 text-emerald-600 dark:text-emerald-400 text-[11px] font-bold rounded-xl border border-emerald-500/30 dark:border-emerald-400/30 backdrop-blur-md transition-all active:scale-[0.98] group relative overflow-hidden shadow-[0_0_15px_-3px_rgba(16,185,129,0.1)] hover:shadow-[0_0_20px_-3px_rgba(16,185,129,0.2)]"
        data-testid="pwa-update-button"
      >
        <!-- Subtle pulsing background glow -->
        <div class="absolute inset-0 bg-emerald-400/5 dark:bg-emerald-400/5 animate-pulse-subtle pointer-events-none"></div>

        <div class="relative w-3.5 h-3.5 flex items-center justify-center shrink-0">
          <RotateCw class="w-3.5 h-3.5 transition-all duration-500 group-hover:rotate-180" />
        </div>

        <span class="tracking-widest uppercase opacity-90 group-hover:opacity-100 transition-opacity">Reload to Update</span>
      </button>
    </div>
  </Transition>
</template>

<style scoped>
.tracking-widest {
  letter-spacing: 0.1em;
}

@keyframes pulse-subtle {
  0%, 100% { opacity: 0.2; }
  50% { opacity: 0.6; }
}

.animate-pulse-subtle {
  animation: pulse-subtle 4s ease-in-out infinite;
}
</style>
