<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue';
import { Info, Copy, Check } from 'lucide-vue-next';

const props = defineProps<{
  /** The generation prompt */
  prompt: string;
  /** Number of denoising steps */
  steps: number | undefined;
  /** Random seed used for generation */
  seed: number | undefined;
}>();

const isOpen = ref(false);
const containerRef = ref<HTMLElement | null>(null);
const copiedPrompt = ref(false);
const copiedSeed = ref(false);

function toggle(e: Event) {
  e.stopPropagation();
  isOpen.value = !isOpen.value;
}

async function copyPrompt(e: Event) {
  e.stopPropagation();
  await navigator.clipboard.writeText(props.prompt);
  copiedPrompt.value = true;
  setTimeout(() => copiedPrompt.value = false, 2000);
}

async function copySeed(e: Event) {
  e.stopPropagation();
  if (props.seed !== undefined) {
    await navigator.clipboard.writeText(String(props.seed));
    copiedSeed.value = true;
    setTimeout(() => copiedSeed.value = false, 2000);
  }
}

function handleClickOutside(event: MouseEvent) {
  if (containerRef.value && !containerRef.value.contains(event.target as Node)) {
    isOpen.value = false;
  }
}

onMounted(() => {
  document.addEventListener('mousedown', handleClickOutside);
});

onUnmounted(() => {
  document.removeEventListener('mousedown', handleClickOutside);
});

defineExpose({
  __testOnly: {
    isOpen,
    copiedPrompt,
    copiedSeed
  }
});
</script>

<template>
  <div class="relative inline-flex" ref="containerRef">
    <button
      @click="toggle"
      class="flex items-center justify-center p-1.5 text-gray-500 hover:text-blue-600 dark:hover:text-blue-400 transition-colors rounded-lg bg-white/90 dark:bg-gray-800/90 backdrop-blur-sm border border-gray-200 dark:border-gray-700 shadow-sm"
      title="Image Info"
      data-testid="image-info-button"
    >
      <Info class="w-4 h-4" />
    </button>

    <div
      v-if="isOpen"
      class="absolute left-0 top-full mt-1 w-64 bg-white/95 dark:bg-gray-800/95 border border-gray-200 dark:border-gray-700 rounded-lg shadow-xl z-50 p-3 overflow-hidden animate-in fade-in slide-in-from-top-1 backdrop-blur-md"
    >
      <div class="flex flex-col gap-3">
        <!-- Prompt -->
        <div class="flex flex-col gap-1">
          <div class="flex items-center justify-between">
            <span class="text-[10px] font-bold text-gray-400 uppercase tracking-widest">Prompt</span>
            <button @click="copyPrompt" class="text-gray-400 hover:text-blue-500 transition-colors" title="Copy Prompt">
              <Check v-if="copiedPrompt" class="w-3 h-3 text-green-500" />
              <Copy v-else class="w-3 h-3" />
            </button>
          </div>
          <p class="text-xs text-gray-700 dark:text-gray-200 line-clamp-4 break-words leading-relaxed font-medium">
            {{ prompt }}
          </p>
        </div>

        <!-- Meta Grid -->
        <div class="grid grid-cols-2 gap-2 pt-2 border-t border-gray-100 dark:border-gray-700">
          <div v-if="steps !== undefined" class="flex flex-col">
            <span class="text-[9px] font-bold text-gray-400 uppercase tracking-widest">Steps</span>
            <span class="text-xs font-mono text-gray-700 dark:text-gray-200">{{ steps }}</span>
          </div>
          <div v-if="seed !== undefined" class="flex flex-col">
            <div class="flex items-center justify-between">
              <span class="text-[9px] font-bold text-gray-400 uppercase tracking-widest">Seed</span>
              <button @click="copySeed" class="text-gray-400 hover:text-blue-500 transition-colors" title="Copy Seed">
                <Check v-if="copiedSeed" class="w-2.5 h-2.5 text-green-500" />
                <Copy v-else class="w-2.5 h-2.5" />
              </button>
            </div>
            <span class="text-xs font-mono text-gray-700 dark:text-gray-200 truncate">{{ seed }}</span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
