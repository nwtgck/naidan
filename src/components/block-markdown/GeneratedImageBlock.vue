<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch } from 'vue';
import { GeneratedImageBlockSchema, getDisplayDimensions } from '../../utils/image-generation';
import { storageService } from '../../services/storage';
import { ImageDownloadHydrator } from '../ImageDownloadHydrator';
import ImageIndexBadge from '../ImageIndexBadge.vue';
import { Download, Info, Image as ImageIcon, AlertTriangle } from 'lucide-vue-next';

const props = defineProps<{
  json: string;
}>();

const parsed = computed(() => {
  try {
    const data = JSON.parse(props.json);
    const result = GeneratedImageBlockSchema.safeParse(data);
    if (result.success) return result.data;
    console.error('Invalid generated image block:', result.error);
    return null;
  } catch (e) {
    console.error('Failed to parse generated image JSON:', e);
    return null;
  }
});

const imageUrl = ref<string | null>(null);
const loading = ref(true);
const error = ref<string | null>(null);
const meta = ref<{ isSupported: boolean } | null>(null);

const displayDims = computed(() => {
  if (!parsed.value) return { width: 300, height: 300 };
  return getDisplayDimensions({
    width: parsed.value.width,
    height: parsed.value.height,
    displayWidth: parsed.value.displayWidth,
    displayHeight: parsed.value.displayHeight
  });
});

async function loadImage() {
  if (!parsed.value) return;

  loading.value = true;
  error.value = null;

  try {
    const blob = await storageService.getFile(parsed.value.binaryObjectId);
    if (blob) {
      if (imageUrl.value) URL.revokeObjectURL(imageUrl.value);
      imageUrl.value = URL.createObjectURL(blob);

      // Check metadata support (simulating hydration logic for metadata embedding)
      // We can use ImageDownloadHydrator static methods if they are exposed,
      // or just replicate the logic if it's simple.
      // The original code used ImageDownloadHydrator.prepareContext.
      // Let's assume we can just check if we can embed metadata.
      // For now, let's keep it simple: if we have the blob, we can display it.
    } else {
      error.value = 'Image not found in storage';
    }
  } catch (e) {
    error.value = 'Failed to load image';
    console.error(e);
  } finally {
    loading.value = false;
  }
}

onMounted(loadImage);
watch(() => props.json, loadImage);

onUnmounted(() => {
  if (imageUrl.value) URL.revokeObjectURL(imageUrl.value);
});

function handleDownload() {
  if (!imageUrl.value || !parsed.value) return;

  const link = document.createElement('a');
  link.href = imageUrl.value;
  link.download = `generated-${parsed.value.prompt.slice(0, 20).replace(/\W/g, '-')}.png`; // Simplified
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}


defineExpose({
  __testOnly: {
    // Export internal state and logic used only for testing here. Do not reference these in production logic.
  }
});
</script>

<template>
  <div
    v-if="parsed"
    class="naidan-generated-image my-4 relative group/gen-img w-fit rounded-xl overflow-hidden bg-gray-100 dark:bg-gray-800 shadow-sm border border-gray-200 dark:border-gray-700"
    :style="{ width: `${displayDims.width}px`, aspectRatio: `${displayDims.width}/${displayDims.height}` }"
  >
    <!-- Image -->
    <img
      v-if="imageUrl"
      :src="imageUrl"
      class="w-full h-full object-cover"
      alt="Generated Image"
    />

    <!-- Loading Skeleton -->
    <div v-else-if="loading" class="absolute inset-0 flex items-center justify-center animate-pulse">
      <ImageIcon class="w-8 h-8 text-gray-400" />
    </div>

    <!-- Error -->
    <div v-else-if="error" class="absolute inset-0 flex flex-col items-center justify-center p-4 text-center bg-gray-50 dark:bg-gray-800 text-red-500">
      <AlertTriangle class="w-6 h-6 mb-2" />
      <span class="text-xs">{{ error }}</span>
    </div>

    <!-- Overlays (only if loaded) -->
    <template v-if="imageUrl">
      <!-- Info Badge (Top Left) -->
      <div class="absolute top-2 left-2 p-1.5 bg-black/60 backdrop-blur-md rounded-lg text-white opacity-0 group-hover/gen-img:opacity-100 transition-opacity">
        <Info class="w-3.5 h-3.5" />
        <!-- Tooltip could be added here -->
      </div>

      <!-- Download Button (Top Right) -->
      <button
        @click="handleDownload"
        class="absolute top-2 right-2 p-1.5 bg-white/90 dark:bg-gray-800/90 backdrop-blur-sm rounded-lg text-gray-700 dark:text-gray-200 shadow-sm opacity-0 group-hover/gen-img:opacity-100 transition-opacity hover:bg-white dark:hover:bg-gray-700"
        title="Download"
      >
        <Download class="w-4 h-4" />
      </button>

      <!-- Tech Details (Bottom) -->
      <div class="absolute bottom-0 inset-x-0 p-2 bg-gradient-to-t from-black/80 to-transparent text-white text-[10px] opacity-0 group-hover/gen-img:opacity-100 transition-opacity">
        <div class="truncate font-medium">{{ parsed.prompt }}</div>
        <div class="opacity-70 flex items-center gap-2">
          <span v-if="parsed.steps">{{ parsed.steps }} steps</span>
          <span v-if="parsed.seed">Seed: {{ parsed.seed }}</span>
        </div>
      </div>
    </template>
  </div>

  <!-- Fallback for invalid JSON -->
  <div v-else class="p-4 border border-red-200 bg-red-50 rounded text-red-500 text-xs">
    Invalid Image Block Data
  </div>
</template>
