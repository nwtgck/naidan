<script setup lang="ts">
import { Image, Loader2, Check, ArrowLeftRight, Dice5 } from 'lucide-vue-next';
import ModelSelector from './ModelSelector.vue';

defineOptions({
  name: 'ImageGenerationSettings'
});

const props = defineProps<{
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
  showHeader?: boolean;
}>();

const emit = defineEmits<{
  (e: 'toggle-image-mode'): void;
  (e: 'update:resolution', width: number, height: number): void;
  (e: 'update:count', count: number): void;
  (e: 'update:steps', steps: number | undefined): void;
  (e: 'update:seed', seed: number | 'browser_random' | undefined): void;
  (e: 'update:persist-as', format: 'original' | 'webp' | 'jpeg' | 'png'): void;
  (e: 'update:model', modelId: string): void;
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

const saveFormats = [
  { label: 'Original', value: 'original' },
  { label: 'WebP', value: 'webp' },
  { label: 'JPEG', value: 'jpeg' },
  { label: 'PNG', value: 'png' },
] as const;

function handleCountInput(event: Event) {
  const target = event.target as HTMLInputElement;
  const val = parseInt(target.value);
  if (!isNaN(val) && val > 0) {
    emit('update:count', val);
  }
}

function handleStepsInput(event: Event) {
  const target = event.target as HTMLInputElement;
  const val = parseInt(target.value);
  if (!isNaN(val) && val > 0) {
    emit('update:steps', val);
  } else if (target.value === '') {
    emit('update:steps', undefined);
  }
}

function handleSeedInput(event: Event) {
  const target = event.target as HTMLInputElement;
  const val = parseInt(target.value);
  if (!isNaN(val)) {
    emit('update:seed', val);
  } else if (target.value === '') {
    emit('update:seed', undefined);
  }
}

function handleWidthInput(event: Event) {
  const target = event.target as HTMLInputElement;
  const val = parseInt(target.value);
  if (!isNaN(val) && val > 0) {
    emit('update:resolution', val, props.selectedHeight);
  }
}

function handleHeightInput(event: Event) {
  const target = event.target as HTMLInputElement;
  const val = parseInt(target.value);
  if (!isNaN(val) && val > 0) {
    emit('update:resolution', props.selectedWidth, val);
  }
}

function handleModelUpdate(modelId: string) {
  emit('update:model', modelId);
}

function swapResolution() {
  emit('update:resolution', props.selectedHeight, props.selectedWidth);
}


defineExpose({
  __testOnly: {
    // Export internal state and logic used only for testing here. Do not reference these in production logic.
  }
});
</script>

<template>
  <div class="flex flex-col">
    <div v-if="showHeader" class="px-3 py-1.5 text-[10px] font-bold text-gray-400 uppercase tracking-widest border-b dark:border-gray-700 mb-1">
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
              @input="handleWidthInput"
              class="flex-1 min-w-0 px-1 py-1 text-[10px] font-mono text-center border rounded-md bg-gray-50 dark:bg-gray-900 border-gray-100 dark:border-gray-700 text-gray-600 dark:text-gray-300 focus:outline-none focus:border-blue-500/50 transition-all [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
              placeholder="Width"
            />
            <button
              @click="swapResolution"
              class="p-1 text-gray-400 hover:text-blue-500 transition-colors"
              title="Swap Width and Height"
            >
              <ArrowLeftRight class="w-3 h-3" />
            </button>
            <input
              type="number"
              min="1"
              :value="selectedHeight"
              @input="handleHeightInput"
              class="flex-1 min-w-0 px-1 py-1 text-[10px] font-mono text-center border rounded-md bg-gray-50 dark:bg-gray-900 border-gray-100 dark:border-gray-700 text-gray-600 dark:text-gray-300 focus:outline-none focus:border-blue-500/50 transition-all [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
              placeholder="Height"
            />
          </div>
        </div>
      </div>

      <!-- Count Selector -->
      <div class="px-3 py-2 border-t dark:border-gray-700">
        <div class="text-[9px] font-bold text-gray-400 uppercase tracking-wider mb-2">Number of Images</div>
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
            @input="handleCountInput"
            class="w-12 px-1.5 py-1 text-[10px] font-mono border rounded-md bg-gray-50 dark:bg-gray-900 border-gray-100 dark:border-gray-700 text-gray-600 dark:text-gray-300 focus:outline-none focus:border-blue-500/50 transition-all [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
            placeholder="Qty"
          />
        </div>
      </div>

      <!-- Steps & Seed -->
      <div class="px-3 py-2 border-t dark:border-gray-700 flex items-end gap-4">
        <div class="flex-1 flex flex-col">
          <div class="text-[9px] font-bold text-gray-400 uppercase tracking-wider mb-2 leading-none">Steps</div>
          <input
            type="number"
            min="1"
            :value="selectedSteps"
            @input="handleStepsInput"
            class="w-full h-7 px-1.5 py-1 text-[10px] font-mono border rounded-md bg-gray-50 dark:bg-gray-900 border-gray-100 dark:border-gray-700 text-gray-600 dark:text-gray-300 focus:outline-none focus:border-blue-500/50 transition-all block m-0 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
            placeholder="Auto"
          />
        </div>
        <div class="flex-[1.5] flex flex-col">
          <div class="text-[9px] font-bold text-gray-400 uppercase tracking-wider mb-2 leading-none">Seed</div>
          <div class="flex items-stretch gap-1 h-7">
            <button
              @click="emit('update:seed', selectedSeed === 'browser_random' ? undefined : 'browser_random')"
              class="h-full px-1.5 border rounded-md transition-all flex items-center justify-center shrink-0 m-0"
              :class="selectedSeed === 'browser_random'
                ? 'bg-blue-600 border-blue-600 text-white shadow-sm'
                : 'bg-gray-50 dark:bg-gray-900 border-gray-100 dark:border-gray-700 text-gray-500 dark:text-gray-400 hover:border-blue-500/50'"
              title="Explicitly generate random seed in browser for each image"
            >
              <Dice5 class="w-3 h-3" />
            </button>
            <input
              type="number"
              :value="typeof selectedSeed === 'number' ? selectedSeed : ''"
              @input="handleSeedInput"
              :disabled="selectedSeed === 'browser_random'"
              class="flex-1 h-full min-w-0 px-1.5 py-1 text-[10px] font-mono border rounded-md bg-gray-50 dark:bg-gray-900 border-gray-100 dark:border-gray-700 text-gray-600 dark:text-gray-300 focus:outline-none focus:border-blue-500/50 transition-all disabled:opacity-50 block m-0 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
              placeholder="Auto"
            />
          </div>
        </div>
      </div>

      <!-- Save Format Selector -->
      <div class="px-3 py-2 border-t dark:border-gray-700">
        <div class="text-[9px] font-bold text-gray-400 uppercase tracking-wider mb-2">Save Format</div>
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
      No tools available for this provider
    </div>
  </div>
</template>
