<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue';
import { Settings2 } from 'lucide-vue-next';
import ImageGenerationSettings from './ImageGenerationSettings.vue';

const props = withDefaults(defineProps<{
  canGenerateImage: boolean;
  isProcessing: boolean;
  isImageMode: boolean;
  selectedWidth: number;
  selectedHeight: number;
  selectedCount: number;
  selectedPersistAs: 'original' | 'webp' | 'jpeg' | 'png';
  availableImageModels: string[];
  selectedImageModel: string | undefined;
  direction?: 'up' | 'down';
}>(), {
  direction: 'up'
});

const emit = defineEmits<{
  (e: 'toggle-image-mode'): void;
  (e: 'update:resolution', width: number, height: number): void;
  (e: 'update:count', count: number): void;
  (e: 'update:persist-as', format: 'original' | 'webp' | 'jpeg' | 'png'): void;
  (e: 'update:model', modelId: string): void;
}>();

const showMenu = ref(false);
const containerRef = ref<HTMLElement | null>(null);

function handleClickOutside(event: MouseEvent) {
  const target = event.target as HTMLElement;
  if (!showMenu.value) return;

  // 1. Check if the click is inside the main container
  if (containerRef.value?.contains(target)) return;
  
  // 2. Check if the click is on a teleported dropdown (like ModelSelector)
  // We check if the clicked element or any of its parents are the ModelSelector dropdown.
  // ModelSelector dropdowns have position: fixed and z-index: 9999.
  let current: HTMLElement | null = target;
  while (current && current !== document.body) {
    if (current instanceof HTMLElement) {
      const style = window.getComputedStyle(current);
      if (style.position === 'fixed' && style.zIndex === '9999') {
        return; // It's inside a teleported dropdown
      }
    }
    current = current.parentElement;
  }

  // 3. Otherwise, it's a true outside click
  showMenu.value = false;
}

onMounted(() => {
  document.addEventListener('mousedown', handleClickOutside);
});

onUnmounted(() => {
  document.removeEventListener('mousedown', handleClickOutside);
});
</script>

<template>
  <div class="relative" ref="containerRef">
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
        class="absolute left-0 w-64 bg-white dark:bg-gray-800 border border-gray-100 dark:border-gray-700 rounded-xl shadow-2xl z-50 py-1.5 overflow-hidden"
        :class="[
          direction === 'up' ? 'bottom-full mb-2 origin-bottom-left' : 'top-full mt-2 origin-top-left'
        ]"
      >
        <ImageGenerationSettings 
          v-bind="props"
          show-header
          @toggle-image-mode="emit('toggle-image-mode')"
          @update:resolution="(w, h) => emit('update:resolution', w, h)"
          @update:count="c => emit('update:count', c)"
          @update:persist-as="f => emit('update:persist-as', f)"
          @update:model="m => emit('update:model', m)"
        />
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