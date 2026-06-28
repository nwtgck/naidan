<script setup lang="ts">
import { lazyStrings } from '@/strings';
import { computed, ref, nextTick } from 'vue';
import { ImageIcon, Loader2Icon, CheckIcon, ArrowLeftRightIcon, Dice5Icon } from 'lucide-vue-next';
import ModelSelector from './ModelSelector.vue';

defineOptions({
  name: 'ImageGenerationSettings',
});

const props = defineProps<{
  canGenerateImage: boolean,
  isProcessing: boolean,
  isImageMode: boolean,
  selectedWidth: number,
  selectedHeight: number,
  selectedCount: number,
  selectedSteps: number | undefined,
  selectedSeed: number | 'browser_random' | undefined,
  selectedPersistAs: 'original' | 'webp' | 'jpeg' | 'png',
  availableImageModels: string[],
  selectedImageModel: string | undefined,
}>();

const emit = defineEmits<{
  (e: 'toggle-image-mode'): void,
  (e: 'update:resolution', width: number, height: number): void,
  (e: 'update:count', count: number): void,
  (e: 'update:steps', steps: number | undefined): void,
  (e: 'update:seed', seed: number | 'browser_random' | undefined): void,
  (e: 'update:persist-as', format: 'original' | 'webp' | 'jpeg' | 'png'): void,
  (e: 'update:model', modelId: string): void,
}>();

const resolutions = [
  { width: 256, height: 256, label: '1:1' },
  { width: 512, height: 512, label: '1:1' },
  { width: 1024, height: 1024, label: '1:1' },
  { width: 256, height: 144, label: '144p' },
  { width: 1280, height: 720, label: '720p' },
  { width: 640, height: 480, label: '4:3' },
];

const counts = [1, 5, 10, 50];

const saveFormats = computed(() => [
  { label: lazyStrings.ImageGenerationSettings__original(), value: 'original' },
  { label: lazyStrings.ImageGenerationSettings__webp(), value: 'webp' },
  { label: lazyStrings.ImageGenerationSettings__jpeg(), value: 'jpeg' },
  { label: lazyStrings.ImageGenerationSettings__png(), value: 'png' },
] as const);

const seedInputRef = ref<HTMLInputElement | null>(null);

function handleCountInput({ event }: { event: Event }) {
  const target = event.target as HTMLInputElement;
  const val = parseInt(target.value);
  if (!isNaN(val) && val > 0) {
    emit('update:count', val);
  }
}

function handleStepsInput({ event }: { event: Event }) {
  const target = event.target as HTMLInputElement;
  const val = parseInt(target.value);
  if (!isNaN(val) && val > 0) {
    emit('update:steps', val);
  } else if (target.value === '') {
    emit('update:steps', undefined);
  }
}

function handleSeedInput({ event }: { event: Event }) {
  const target = event.target as HTMLInputElement;
  const val = parseInt(target.value);
  if (!isNaN(val)) {
    emit('update:seed', val);
  } else if (target.value === '') {
    emit('update:seed', undefined);
  }
}

function handleSeedReEnable() {
  emit('update:seed', undefined);
  nextTick(() => {
    seedInputRef.value?.focus();
  });
}

function handleWidthInput({ event }: { event: Event }) {
  const target = event.target as HTMLInputElement;
  const val = parseInt(target.value);
  if (!isNaN(val) && val > 0) {
    emit('update:resolution', val, props.selectedHeight);
  }
}

function handleHeightInput({ event }: { event: Event }) {
  const target = event.target as HTMLInputElement;
  const val = parseInt(target.value);
  if (!isNaN(val) && val > 0) {
    emit('update:resolution', props.selectedWidth, val);
  }
}

function handleModelUpdate({ modelId }: { modelId: string }) {
  emit('update:model', modelId);
}

function swapResolution() {
  emit('update:resolution', props.selectedHeight, props.selectedWidth);
}


defineExpose({
  TEST_ONLY: {
    // Export internal state and logic used only for testing here. Do not reference these in production logic.
  },
});
</script>

<template>
  <button
    v-if="canGenerateImage"
    @click="emit('toggle-image-mode')"
    class="w-full flex items-center gap-3 px-3 py-2 text-sm text-left transition-colors hover:bg-gray-50 dark:hover:bg-gray-700"
    :class="isImageMode ? 'text-blue-600 font-bold bg-blue-50/50 dark:bg-blue-900/10' : 'text-gray-600 dark:text-gray-300'"
    data-testid="toggle-image-mode-button"
  >
    <ImageIcon class="w-4 h-4" :class="isImageMode ? 'text-blue-500' : 'text-gray-400 dark:text-gray-500'" />
    <span class="flex-1">{{ lazyStrings.ImageGenerationSettings__create_image_experimental() }}</span>
    <CheckIcon v-if="isImageMode" class="w-4 h-4 text-blue-500" />
    <Loader2Icon v-if="isProcessing && isImageMode" class="w-3 h-3 animate-spin text-blue-500" />
  </button>

  <div v-if="isImageMode" class="border-t dark:border-gray-700 mt-1">
    <!-- Model Selector -->
    <div v-if="availableImageModels.length > 0" class="px-3 py-2 border-b dark:border-gray-700">
      <div class="text-[9px] font-bold text-gray-400 uppercase tracking-wider mb-2">{{ lazyStrings.ImageGenerationSettings__image_model() }}</div>
      <ModelSelector
        :model-value="selectedImageModel"
        @update:model-value="val => val && handleModelUpdate({ modelId: val })"
        :models="availableImageModels"
        :placeholder="lazyStrings.ImageGenerationSettings__select_image_model()"
        class="w-full"
      />
    </div>

    <!-- Resolution Selector -->
    <div class="px-3 py-2">
      <div class="text-[9px] font-bold text-gray-400 uppercase tracking-wider mb-2">{{ lazyStrings.ImageGenerationSettings__resolution() }}</div>
      <div class="flex flex-col gap-2">
        <div class="flex flex-wrap gap-1.5">
          <button
            v-for="res in resolutions"
            :key="`${res.width}x${res.height}`"
            @click="emit('update:resolution', res.width, res.height)"
            class="flex-1 min-w-[50px] px-1 py-1 text-[10px] font-mono border rounded-md transition-all whitespace-nowrap flex flex-col items-center justify-center"
            :class="selectedWidth === res.width && selectedHeight === res.height
              ? 'bg-blue-600 border-blue-600 text-white shadow-sm'
              : 'bg-gray-50 dark:bg-gray-900 border-gray-100 dark:border-gray-700 text-gray-500 dark:text-gray-400 hover:border-blue-500/50'"
          >
            <span class="opacity-70 text-[8px] leading-tight">{{ res.label }}</span>
            <span>{{ res.width }}x{{ res.height }}</span>
          </button>
        </div>
        <div class="flex gap-1.5 items-center">
          <input
            type="number"
            min="1"
            :value="selectedWidth"
            @input="handleWidthInput({ event: $event })"
            class="flex-1 min-w-0 px-1 py-1 text-[10px] font-mono text-center border rounded-md bg-gray-50 dark:bg-gray-900 border-gray-100 dark:border-gray-700 text-gray-600 dark:text-gray-300 focus:outline-none focus:border-blue-500/50 transition-all [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
            :placeholder="lazyStrings.ImageGenerationSettings__width()"
          />
          <button
            @click="swapResolution"
            class="p-1 text-gray-400 hover:text-blue-500 transition-colors"
            :title="lazyStrings.ImageGenerationSettings__swap_width_and_height()"
          >
            <ArrowLeftRightIcon class="w-3 h-3" />
          </button>
          <input
            type="number"
            min="1"
            :value="selectedHeight"
            @input="handleHeightInput({ event: $event })"
            class="flex-1 min-w-0 px-1 py-1 text-[10px] font-mono text-center border rounded-md bg-gray-50 dark:bg-gray-900 border-gray-100 dark:border-gray-700 text-gray-600 dark:text-gray-300 focus:outline-none focus:border-blue-500/50 transition-all [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
            :placeholder="lazyStrings.ImageGenerationSettings__height()"
          />
        </div>
      </div>
    </div>

    <!-- Count Selector -->
    <div class="px-3 py-2 border-t dark:border-gray-700">
      <div class="text-[9px] font-bold text-gray-400 uppercase tracking-wider mb-2">{{ lazyStrings.ImageGenerationSettings__number_of_images() }}</div>
      <div class="flex gap-1.5 items-center">
        <div class="flex flex-1 gap-1">
          <button
            v-for="count in counts"
            :key="count"
            @click="emit('update:count', count)"
            class="flex-1 px-1 py-1 text-[10px] font-mono border rounded-md transition-all whitespace-nowrap"
            :class="selectedCount === count
              ? 'bg-blue-600 border-blue-600 text-white shadow-sm'
              : 'bg-gray-50 dark:bg-gray-900 border-gray-100 dark:border-gray-700 text-gray-500 dark:text-gray-400 hover:border-blue-500/50'"
          >
            {{ count }}
          </button>
        </div>
        <input
          type="number"
          min="1"
          :value="selectedCount"
          @input="handleCountInput({ event: $event })"
          class="w-12 px-1.5 py-1 text-[10px] font-mono border rounded-md bg-gray-50 dark:bg-gray-900 border-gray-100 dark:border-gray-700 text-gray-600 dark:text-gray-300 focus:outline-none focus:border-blue-500/50 transition-all [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
          :placeholder="lazyStrings.ImageGenerationSettings__qty()"
        />
      </div>
    </div>

    <!-- Steps & Seed -->
    <div class="px-3 py-2 border-t dark:border-gray-700 flex items-end gap-4">
      <div class="flex-1 flex flex-col">
        <div class="text-[9px] font-bold text-gray-400 uppercase tracking-wider mb-2 leading-none">{{ lazyStrings.ImageGenerationSettings__steps() }}</div>
        <input
          type="number"
          min="1"
          :value="selectedSteps"
          @input="handleStepsInput({ event: $event })"
          class="w-full h-7 px-1.5 py-1 text-[10px] font-mono border rounded-md bg-gray-50 dark:bg-gray-900 border-gray-100 dark:border-gray-700 text-gray-600 dark:text-gray-300 focus:outline-none focus:border-blue-500/50 transition-all block m-0 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
          :placeholder="lazyStrings.ImageGenerationSettings__auto()"
        />
      </div>
      <div class="flex-[1.5] flex flex-col">
        <div class="text-[9px] font-bold text-gray-400 uppercase tracking-wider mb-2 leading-none">{{ lazyStrings.ImageGenerationSettings__seed() }}</div>
        <div class="flex items-stretch gap-1 h-7">
          <button
            @click="emit('update:seed', selectedSeed === 'browser_random' ? undefined : 'browser_random')"
            class="h-full px-1.5 border rounded-md transition-all flex items-center justify-center shrink-0 m-0"
            :class="selectedSeed === 'browser_random'
              ? 'bg-blue-600 border-blue-600 text-white shadow-sm'
              : 'bg-gray-50 dark:bg-gray-900 border-gray-100 dark:border-gray-700 text-gray-500 dark:text-gray-400 hover:border-blue-500/50'"
            :title="lazyStrings.ImageGenerationSettings__explicitly_generate_random_seed_in_browser_for_each_image()"
          >
            <Dice5Icon class="w-3 h-3" />
          </button>
          <div class="flex-1 relative">
            <input
              ref="seedInputRef"
              type="number"
              :value="typeof selectedSeed === 'number' ? selectedSeed : ''"
              @input="handleSeedInput({ event: $event })"
              :disabled="selectedSeed === 'browser_random'"
              class="w-full h-full min-w-0 px-1.5 py-1 text-[10px] font-mono border rounded-md bg-gray-50 dark:bg-gray-900 border-gray-100 dark:border-gray-700 text-gray-600 dark:text-gray-300 focus:outline-none focus:border-blue-500/50 transition-all disabled:opacity-50 block m-0 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
              :placeholder="lazyStrings.ImageGenerationSettings__auto()"
              data-testid="seed-input"
            />
            <div
              v-if="selectedSeed === 'browser_random'"
              @click="handleSeedReEnable"
              class="absolute inset-0 cursor-text z-10"
              :title="lazyStrings.ImageGenerationSettings__click_to_enter_specific_seed()"
            ></div>
          </div>
        </div>
      </div>
    </div>

    <!-- Save Format Selector -->
    <div class="px-3 py-2 border-t dark:border-gray-700">
      <div class="text-[9px] font-bold text-gray-400 uppercase tracking-wider mb-2">{{ lazyStrings.ImageGenerationSettings__save_format() }}</div>
      <div class="flex flex-wrap gap-1.5">
        <button
          v-for="format in saveFormats"
          :key="format.value"
          @click="emit('update:persist-as', format.value)"
          class="flex-1 px-1 py-1 text-[10px] font-mono border rounded-md transition-all whitespace-nowrap"
          :class="selectedPersistAs === format.value
            ? 'bg-blue-600 border-blue-600 text-white shadow-sm'
            : 'bg-gray-50 dark:bg-gray-900 border-gray-100 dark:border-gray-700 text-gray-500 dark:text-gray-400 hover:border-blue-500/50'"
        >
          {{ format.label }}
        </button>
      </div>
    </div>
  </div>
  <div v-else-if="!canGenerateImage" class="px-3 py-2 text-xs text-gray-400 italic">
    {{ lazyStrings.ImageGenerationSettings__no_tools_available_for_this_provider() }}
  </div>
</template>
