<script setup lang="ts">
import { Image, Loader2, Check } from 'lucide-vue-next';
import ModelSelector from './ModelSelector.vue';

const props = defineProps<{
  canGenerateImage: boolean;
  isProcessing: boolean;
  isImageMode: boolean;
  selectedWidth: number;
  selectedHeight: number;
  selectedCount: number;
  selectedPersistAs: 'original' | 'webp' | 'jpeg' | 'png';
  availableImageModels: string[];
  selectedImageModel: string | undefined;
  showHeader?: boolean;
}>();

const emit = defineEmits<{
  (e: 'toggle-image-mode'): void;
  (e: 'update:resolution', width: number, height: number): void;
  (e: 'update:count', count: number): void;
  (e: 'update:persist-as', format: 'original' | 'webp' | 'jpeg' | 'png'): void;
  (e: 'update:model', modelId: string): void;
}>();

const resolutions = [
  { width: 256, height: 256 },
  { width: 512, height: 512 },
  { width: 1024, height: 1024 },
];

const counts = [1, 2, 3, 4];

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

function handleModelUpdate(modelId: string) {
  emit('update:model', modelId);
}
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
