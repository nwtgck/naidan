<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue';
import { Settings2, Image, Loader2, Check } from 'lucide-vue-next';
import ModelSelector from './ModelSelector.vue';

const props = defineProps<{
  canGenerateImage: boolean;
  isProcessing: boolean;
  isImageMode: boolean;
  selectedWidth: number;
  selectedHeight: number;
  availableImageModels: string[];
  selectedImageModel: string | undefined;
}>();

const emit = defineEmits<{
  (e: 'toggle-image-mode'): void;
  (e: 'update:resolution', width: number, height: number): void;
  (e: 'update:model', modelId: string): void;
}>();

const resolutions = [
  { width: 256, height: 256 },
  { width: 512, height: 512 },
  { width: 1024, height: 1024 },
];

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

function handleModelUpdate(modelId: string) {
  emit('update:model', modelId);
  // We no longer close the menu automatically here, allowing further adjustments
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
        class="absolute left-0 bottom-full mb-2 w-64 bg-white dark:bg-gray-800 border border-gray-100 dark:border-gray-700 rounded-xl shadow-2xl z-50 py-1.5 overflow-hidden origin-bottom-left"
      >
        <div class="px-3 py-1.5 text-[10px] font-bold text-gray-400 uppercase tracking-widest border-b dark:border-gray-700 mb-1">
          Experimental Tools
        </div>
        
        <button 
          v-if="canGenerateImage"
          @click="emit('toggle-image-mode')"
          class="w-full flex items-center gap-3 px-3 py-2 text-sm text-left transition-colors hover:bg-gray-50 dark:hover:bg-gray-700"
          :class="isImageMode ? 'text-blue-600 font-bold bg-blue-50/50 dark:bg-blue-900/10' : 'text-gray-600 dark:text-gray-300'"
          data-testid="toggle-image-mode-button"
        >
          <Image class="w-4 h-4" :class="isImageMode ? 'text-blue-500' : 'text-gray-400 dark:text-gray-500'" />
          <span class="flex-1">Create image (Experimental)</span>
          <Check v-if="isImageMode" class="w-4 h-4 text-blue-500" />
          <Loader2 v-if="isProcessing && isImageMode" class="w-3 h-3 animate-spin text-blue-500" />
        </button>

        <div v-if="isImageMode" class="border-t dark:border-gray-700 mt-1">
          <!-- Model Selector -->
          <div v-if="availableImageModels.length > 0" class="px-3 py-2 border-b dark:border-gray-700">
            <div class="text-[9px] font-bold text-gray-400 uppercase tracking-wider mb-2">Image Model</div>
            <ModelSelector 
              :model-value="selectedImageModel"
              @update:model-value="val => val && handleModelUpdate(val)"
              :models="availableImageModels"
              placeholder="Select image model"
              class="w-full"
            />
          </div>

          <!-- Resolution Selector -->
          <div class="px-3 py-2">
            <div class="text-[9px] font-bold text-gray-400 uppercase tracking-wider mb-2">Resolution</div>
            <div class="flex gap-1.5">
              <button 
                v-for="res in resolutions" 
                :key="`${res.width}x${res.height}`"
                @click="emit('update:resolution', res.width, res.height)"
                class="flex-1 px-1 py-1 text-[10px] font-mono border rounded-md transition-all whitespace-nowrap"
                :class="selectedWidth === res.width && selectedHeight === res.height 
                  ? 'bg-blue-600 border-blue-600 text-white shadow-sm' 
                  : 'bg-gray-50 dark:bg-gray-900 border-gray-100 dark:border-gray-700 text-gray-500 dark:text-gray-400 hover:border-blue-500/50'"
              >
                {{ res.width }}x{{ res.height }}
              </button>
            </div>
          </div>
        </div>
        <div v-else-if="!canGenerateImage" class="px-3 py-2 text-xs text-gray-400 italic">
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