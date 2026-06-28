<script setup lang="ts">
import { lazyStrings } from '@/strings';
import { ref, computed, watch, onMounted } from 'vue';
import { Settings2Icon, ChevronDownIcon } from 'lucide-vue-next';
import { defineAsyncComponentAndLoadOnMounted } from '@/utils/vue';
import { useWindowSize } from '@vueuse/core';
import { useChatTools } from '@/features/tools/composables/useChatTools';
import { useEventTargetListener } from '@/composables/useEventTargetListener';

// Lazily load image generation settings as it's only visible when the tools menu is opened, but prefetch it when idle.
const ImageGenerationSettings = defineAsyncComponentAndLoadOnMounted({ loader: () => import('@/components/ImageGenerationSettings.vue') });
const ReasoningSettings = defineAsyncComponentAndLoadOnMounted({ loader: () => import('@/components/ReasoningSettings.vue') });
const LmToolsSettings = defineAsyncComponentAndLoadOnMounted({ loader: () => import('./LmToolsSettings.vue') });

const props = withDefaults(defineProps<{
  canGenerateImage: boolean,
  isProcessing: boolean,
  isImageMode: boolean,
  isThinkActive: boolean,
  selectedWidth: number,
  selectedHeight: number,
  selectedCount: number,
  selectedSteps: number | undefined,
  selectedSeed: number | 'browser_random' | undefined,
  selectedPersistAs: 'original' | 'webp' | 'jpeg' | 'png',
  availableImageModels: string[],
  selectedImageModel: string | undefined,
  selectedReasoningEffort: 'none' | 'low' | 'medium' | 'high' | undefined,
  direction?: 'up' | 'down',
}>(), {
  direction: 'up',
});

const emit = defineEmits<{
  (e: 'toggle-image-mode'): void,
  (e: 'update:resolution', width: number, height: number): void,
  (e: 'update:count', count: number): void,
  (e: 'update:steps', steps: number | undefined): void,
  (e: 'update:seed', seed: number | 'browser_random' | undefined): void,
  (e: 'update:persist-as', format: 'original' | 'webp' | 'jpeg' | 'png'): void,
  (e: 'update:model', modelId: string): void,
  (e: 'update:reasoning-effort', effort: 'none' | 'low' | 'medium' | 'high' | undefined): void,
}>();

const { enabledToolNames } = useChatTools();
const hasActiveTools = computed(() => enabledToolNames.value.length > 0);

const showMenu = ref(false);
const triggerRef = ref<HTMLElement | null>(null);
const sheetRef = ref<HTMLElement | null>(null);
const teleportTarget = ref<HTMLElement | null>(null);

const { width: windowWidth } = useWindowSize();

onMounted(() => {
  teleportTarget.value = triggerRef.value?.closest('.chat-pane') as HTMLElement || document.body;
});

function handleClickOutside({ event }: { event: MouseEvent }) {
  const target = event.target as Node;
  if (!showMenu.value) return;

  if (triggerRef.value?.contains(target)) return;
  if (sheetRef.value?.contains(target)) return;

  let current: HTMLElement | null = target as HTMLElement;
  while (current && current !== document.body) {
    if (current instanceof HTMLElement) {
      const style = window.getComputedStyle(current);
      if (style.position === 'fixed' && style.zIndex === '9999') {
        return;
      }
    }
    current = current.parentElement;
  }

  showMenu.value = false;
}

useEventTargetListener(document, 'mousedown', (event) => handleClickOutside({ event }));

watch(windowWidth, () => {
  if (showMenu.value) showMenu.value = false;
});

defineExpose({
  TEST_ONLY: {
    // Export internal state and logic used only for testing here. Do not reference these in production logic.
  },
});
</script>

<template>
  <div class="relative" ref="triggerRef">
    <button
      @click="showMenu = !showMenu"
      class="p-2 rounded-xl transition-colors"
      :class="[
        showMenu || isImageMode || isThinkActive || hasActiveTools ? 'text-blue-600 bg-blue-50 dark:bg-blue-900/20' : 'text-gray-400 hover:text-blue-600 dark:hover:text-blue-400 hover:bg-gray-50 dark:hover:bg-gray-800',
        (isImageMode || isThinkActive || hasActiveTools) && !showMenu ? 'ring-2 ring-blue-500/20' : ''
      ]"
      :title="lazyStrings.ChatToolsMenu__tools()"
      data-testid="chat-tools-button"
    >
      <Settings2Icon class="w-5 h-5" />
    </button>

    <Teleport :to="teleportTarget" v-if="teleportTarget">
      <Transition name="sheet">
        <div
          v-if="showMenu"
          class="absolute inset-0 z-[10000] flex flex-col justify-end pointer-events-none"
        >
          <div
            class="sheet-backdrop absolute inset-0 bg-black/10 dark:bg-black/40 pointer-events-auto"
            data-testid="chat-tools-backdrop"
            @click="showMenu = false"
          ></div>

          <div
            ref="sheetRef"
            class="relative w-full max-w-4xl mx-auto bg-white dark:bg-gray-800 border-t border-x border-gray-100 dark:border-gray-700 rounded-t-2xl shadow-[0_-8px_30px_rgb(0,0,0,0.1)] pointer-events-auto overflow-hidden flex flex-col max-h-[80vh]"
            data-testid="chat-tools-dropdown"
          >
            <div class="flex flex-col items-center pt-2 pb-1 bg-white dark:bg-gray-800 shrink-0">
              <div class="w-12 h-1 bg-gray-200 dark:bg-gray-700 rounded-full mb-1"></div>
            </div>

            <div class="flex-1 overflow-y-auto custom-scrollbar bg-white dark:bg-gray-800">
              <div class="px-4 py-2 text-[10px] font-black text-gray-400 uppercase tracking-[0.18em] border-b border-gray-100 dark:border-gray-700 mb-1">
                {{ lazyStrings.ChatToolsMenu__options_tools() }}
              </div>

              <div class="px-3 py-2 border-b border-gray-100 dark:border-gray-700">
                <ReasoningSettings
                  :selected-effort="selectedReasoningEffort"
                  @update:effort="e => emit('update:reasoning-effort', e)"
                  class="!p-0 !border-none"
                />
              </div>

              <div class="px-3 py-3 border-b border-gray-100 dark:border-gray-700">
                <LmToolsSettings />
              </div>

              <div class="px-3 py-3">
                <ImageGenerationSettings
                  :can-generate-image="canGenerateImage"
                  :is-processing="isProcessing"
                  :is-image-mode="isImageMode"
                  :selected-width="selectedWidth"
                  :selected-height="selectedHeight"
                  :selected-count="selectedCount"
                  :selected-steps="selectedSteps"
                  :selected-seed="selectedSeed"
                  :selected-persist-as="selectedPersistAs"
                  :available-image-models="availableImageModels"
                  :selected-image-model="selectedImageModel"
                  @toggle-image-mode="emit('toggle-image-mode')"
                  @update:resolution="(w, h) => emit('update:resolution', w, h)"
                  @update:count="c => emit('update:count', c)"
                  @update:steps="s => emit('update:steps', s)"
                  @update:seed="s => emit('update:seed', s)"
                  @update:persist-as="f => emit('update:persist-as', f)"
                  @update:model="m => emit('update:model', m)"
                  class="!p-0 !border-none"
                />
              </div>
            </div>

            <!-- Full-width Dismiss Footer -->
            <button
              @click="showMenu = false"
              class="w-full py-4 bg-gray-50/50 dark:bg-gray-900/50 border-t border-gray-100 dark:border-gray-700 flex items-center justify-center gap-2 hover:bg-gray-100 dark:hover:bg-gray-800 transition-all group active:bg-gray-200 dark:active:bg-gray-700/50"
              data-testid="chat-tools-footer-close"
            >
              <span class="text-[11px] font-bold text-gray-400 group-hover:text-blue-600 dark:group-hover:text-blue-400 transition-colors uppercase tracking-wider">{{ lazyStrings.ChatToolsMenu__close_menu() }}</span>
              <ChevronDownIcon class="w-4 h-4 text-gray-300 group-hover:text-blue-500 group-hover:translate-y-0.5 transition-all" />
            </button>
          </div>
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

.sheet-enter-active,
.sheet-leave-active {
  transition: opacity 0.3s ease;
}

.sheet-enter-from,
.sheet-leave-to {
  opacity: 0;
}

.sheet-enter-active .relative.mx-auto,
.sheet-leave-active .relative.mx-auto {
  transition: transform 0.3s cubic-bezier(0.16, 1, 0.3, 1);
}

.sheet-enter-from .relative.mx-auto,
.sheet-leave-to .relative.mx-auto {
  transform: translateY(100%);
}

.sheet-backdrop {
  backdrop-filter: blur(4px);
  -webkit-backdrop-filter: blur(4px);
  opacity: 1;
  transition: backdrop-filter 0.3s ease, -webkit-backdrop-filter 0.3s ease, opacity 0.3s ease;
}

.sheet-enter-from .sheet-backdrop,
.sheet-leave-to .sheet-backdrop {
  backdrop-filter: blur(0px);
  -webkit-backdrop-filter: blur(0px);
  opacity: 0;
}

.sheet-enter-to .sheet-backdrop,
.sheet-leave-from .sheet-backdrop {
  backdrop-filter: blur(4px);
  -webkit-backdrop-filter: blur(4px);
  opacity: 1;
}
</style>
