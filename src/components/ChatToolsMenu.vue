<script setup lang="ts">
import { ref } from 'vue';
import { Settings2, Image, Loader2, Check } from 'lucide-vue-next';

defineProps<{
  canGenerateImage: boolean;
  isProcessing: boolean;
  isImageMode: boolean;
}>();

const emit = defineEmits<{
  (e: 'toggle-image-mode'): void;
}>();

const showMenu = ref(false);
</script>

<template>
  <div class="relative">
    <button 
      @click="showMenu = !showMenu"
      class="p-2 rounded-xl transition-colors"
      :class="[
        showMenu || isImageMode ? 'text-blue-600 bg-blue-50 dark:bg-blue-900/20' : 'text-gray-400 hover:text-blue-600 dark:hover:text-blue-400 hover:bg-gray-50 dark:hover:bg-gray-800',
        isImageMode && !showMenu ? 'ring-2 ring-blue-500/20' : ''
      ]"
      title="Tools"
      data-testid="chat-tools-button"
    >
      <Settings2 class="w-5 h-5" />
    </button>

    <Transition name="dropdown">
      <div 
        v-if="showMenu" 
        class="absolute left-0 bottom-full mb-2 w-56 bg-white dark:bg-gray-800 border border-gray-100 dark:border-gray-700 rounded-xl shadow-2xl z-50 py-1.5 overflow-hidden origin-bottom-left"
        @mouseleave="showMenu = false"
      >
        <div class="px-3 py-1.5 text-[10px] font-bold text-gray-400 uppercase tracking-widest border-b dark:border-gray-700 mb-1">
          Experimental Tools
        </div>
        
        <button 
          v-if="canGenerateImage"
          @click="emit('toggle-image-mode'); showMenu = false"
          class="w-full flex items-center gap-3 px-3 py-2 text-sm text-left transition-colors hover:bg-gray-50 dark:hover:bg-gray-700"
          :class="isImageMode ? 'text-blue-600 font-bold bg-blue-50/50 dark:bg-blue-900/10' : 'text-gray-600 dark:text-gray-300'"
          data-testid="toggle-image-mode-button"
        >
          <Image class="w-4 h-4" :class="isImageMode ? 'text-blue-500' : 'text-gray-400 dark:text-gray-500'" />
          <span class="flex-1">Create image (Experimental)</span>
          <Check v-if="isImageMode" class="w-4 h-4 text-blue-500" />
          <Loader2 v-if="isProcessing && isImageMode" class="w-3 h-3 animate-spin text-blue-500" />
        </button>
        <div v-else class="px-3 py-2 text-xs text-gray-400 italic">
          No tools available for this provider
        </div>
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
  transform: scale(0.95) translateY(10px);
}
</style>
