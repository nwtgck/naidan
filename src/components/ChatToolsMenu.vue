<script setup lang="ts">
import { ref, onMounted, onUnmounted, computed, watch, type CSSProperties } from 'vue';
import { Settings2 } from 'lucide-vue-next';
import { defineAsyncComponentAndLoadOnMounted } from '../utils/vue';
import { useElementBounding, useWindowSize } from '@vueuse/core';

// Lazily load image generation settings as it's only visible when the tools menu is opened, but prefetch it when idle.
const ImageGenerationSettings = defineAsyncComponentAndLoadOnMounted(() => import('./ImageGenerationSettings.vue'));

const props = withDefaults(defineProps<{
  canGenerateImage: boolean;
  isProcessing: boolean;
  isImageMode: boolean;
  selectedWidth: number;
  selectedHeight: number;
  selectedCount: number;
  selectedSteps: number | undefined;
  selectedSeed: number | 'browser_random' | undefined;
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
  (e: 'update:steps', steps: number | undefined): void;
  (e: 'update:seed', seed: number | 'browser_random' | undefined): void;
  (e: 'update:persist-as', format: 'original' | 'webp' | 'jpeg' | 'png'): void;
  (e: 'update:model', modelId: string): void;
}>();

const showMenu = ref(false);
const containerRef = ref<HTMLElement | null>(null);
const dropdownRef = ref<HTMLElement | null>(null);

const { width: windowWidth, height: windowHeight } = useWindowSize();
const triggerBounding = useElementBounding(containerRef);

const floatingStyle = computed((): CSSProperties => {
  if (!showMenu.value || !containerRef.value) return {};

  const rect = triggerBounding;
  const margin = 8;
  const menuWidth = 256; // Matching w-64

  // Horizontal alignment: try to align left with the button, but push left if it goes off-screen
  let left = rect.left.value;
  if (left + menuWidth > windowWidth.value - 16) {
    left = windowWidth.value - menuWidth - 16;
  }
  if (left < 16) left = 16;

  const verticalStyle = (() => {
    switch (props.direction) {
    case 'up':
      return {
        bottom: `${windowHeight.value - rect.top.value + margin}px`,
        top: 'auto',
      };
    case 'down':
      return {
        top: `${rect.bottom.value + margin}px`,
        bottom: 'auto',
      };
    default: {
      const _ex: never = props.direction;
      throw new Error(`Unhandled direction: ${_ex}`);
    }
    }
  })();

  return {
    position: 'fixed',
    ...verticalStyle,
    left: `${left}px`,
    width: `${menuWidth}px`,
    maxHeight: `${windowHeight.value - 32}px`,
    overflowY: 'auto',
    zIndex: 9999,
  };
});

function handleClickOutside(event: MouseEvent) {
  const target = event.target as Node;
  if (!showMenu.value) return;

  // 1. Check if the click is inside the trigger button
  if (containerRef.value?.contains(target)) return;

  // 2. Check if the click is inside the dropdown itself
  if (dropdownRef.value?.contains(target)) return;

  // 3. Check if the click is on a teleported dropdown (like ModelSelector inside this menu)
  let current: HTMLElement | null = target as HTMLElement;
  while (current && current !== document.body) {
    if (current instanceof HTMLElement) {
      const style = window.getComputedStyle(current);
      if (style.position === 'fixed' && style.zIndex === '9999') {
        return; // It's inside a teleported dropdown
      }
    }
    current = current.parentElement;
  }

  // 4. Otherwise, it's a true outside click
  showMenu.value = false;
}

onMounted(() => {
  document.addEventListener('mousedown', handleClickOutside);
});

onUnmounted(() => {
  document.removeEventListener('mousedown', handleClickOutside);
});

// Close on window width resize to prevent floating detached dropdown
watch(windowWidth, () => {
  if (showMenu.value) showMenu.value = false;
});

const enterTransform = computed(() => {
  switch (props.direction) {
  case 'up':
    return 'scale(0.95) translateY(10px)';
  case 'down':
    return 'scale(0.95) translateY(-10px)';
  default: {
    const _ex: never = props.direction;
    return `scale(0.95) translateY(${_ex})`;
  }
  }
});

defineExpose({
  __testOnly: {
    // Export internal state and logic used only for testing here. Do not reference these in production logic.
  }
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

    <Teleport to="body">
      <Transition name="dropdown">
        <div
          v-if="showMenu"
          ref="dropdownRef"
          class="bg-white dark:bg-gray-800 border border-gray-100 dark:border-gray-700 rounded-xl shadow-2xl py-1.5 overflow-hidden custom-scrollbar"
          :style="floatingStyle"
          :class="[
            direction === 'up' ? 'origin-bottom' : 'origin-top'
          ]"
          data-testid="chat-tools-dropdown"
        >
          <ImageGenerationSettings
            v-bind="props"
            show-header
            @toggle-image-mode="emit('toggle-image-mode')"
            @update:resolution="(w, h) => emit('update:resolution', w, h)"
            @update:count="c => emit('update:count', c)"
            @update:steps="s => emit('update:steps', s)"
            @update:seed="s => emit('update:seed', s)"
            @update:persist-as="f => emit('update:persist-as', f)"
            @update:model="m => emit('update:model', m)"
          />
        </div>
      </Transition>
    </Teleport>
  </div>
</template>

<style scoped>
.custom-scrollbar::-webkit-scrollbar {
  width: 4px;
}
.custom-scrollbar::-webkit-scrollbar-track {
  background: transparent;
}
.custom-scrollbar::-webkit-scrollbar-thumb {
  background: rgba(156, 163, 175, 0.3);
  border-radius: 10px;
}
.custom-scrollbar::-webkit-scrollbar-thumb:hover {
  background: rgba(156, 163, 175, 0.5);
}

.dropdown-enter-active,
.dropdown-leave-active {
  transition: all 0.2s ease;
}

.dropdown-enter-from,
.dropdown-leave-to {
  opacity: 0;
  transform: v-bind(enterTransform);
}
</style>