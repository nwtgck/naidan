<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch } from 'vue';
import { GeneratedImageBlockSchema, getDisplayDimensions } from '../../utils/image-generation';
import { storageService } from '../../services/storage';
import { Image as ImageIcon, AlertTriangle } from 'lucide-vue-next';
import ImageDownloadButton from '../ImageDownloadButton.vue';
import ImageInfoDisplay from '../ImageInfoDisplay.vue';
import { ImageDownloadHydrator } from '../ImageDownloadHydrator';
import { useImagePreview } from '../../composables/useImagePreview';
import { useGlobalEvents } from '../../composables/useGlobalEvents';

const props = defineProps<{
  json: string;
}>();

const parsed = computed(() => {
  try {
    const data = JSON.parse(props.json);
    const result = GeneratedImageBlockSchema.safeParse(data);
    if (result.success) return result.data;
    console.error('Invalid generated image block:', result.error);
    return undefined;
  } catch (e) {
    console.error('Failed to parse generated image JSON:', e);
    return undefined;
  }
});

const imageUrl = ref<string | undefined>(undefined);
const loading = ref(true);
const error = ref<string | undefined>(undefined);
const isSupported = ref(false);

const { openPreview } = useImagePreview();
const { addErrorEvent } = useGlobalEvents();

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
  error.value = undefined;

  try {
    const blob = await storageService.getFile(parsed.value.binaryObjectId);
    if (blob) {
      if (imageUrl.value) URL.revokeObjectURL(imageUrl.value);
      imageUrl.value = URL.createObjectURL(blob);
      isSupported.value = await ImageDownloadHydrator.detectSupport(blob);
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

async function handlePreview() {
  if (!parsed.value) return;
  const obj = await storageService.getBinaryObject({ binaryObjectId: parsed.value.binaryObjectId });
  if (obj) {
    openPreview({
      objects: [obj],
      initialId: parsed.value.binaryObjectId
    });
  }
}

async function handleDownload({ withMetadata }: { withMetadata: boolean }) {
  if (!parsed.value) return;

  await ImageDownloadHydrator.download({
    id: parsed.value.binaryObjectId,
    prompt: parsed.value.prompt || '',
    steps: parsed.value.steps,
    seed: parsed.value.seed,
    model: undefined, // Model info not directly available in the block JSON currently
    withMetadata,
    storageService,
    onError: (err) => addErrorEvent({
      source: 'GeneratedImageBlock:Download',
      message: 'Failed to embed metadata in image.',
      details: err instanceof Error ? err.message : String(err),
    })
  });
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
    class="naidan-generated-image my-4 relative group/gen-img w-fit rounded-xl overflow-visible"
  >
    <!-- Image -->
    <img
      v-if="imageUrl"
      :src="imageUrl"
      @click="handlePreview"
      :width="displayDims.width"
      :height="displayDims.height"
      class="naidan-clickable-img rounded-xl shadow-lg border border-gray-100 dark:border-gray-800 max-w-full h-auto !m-0 block cursor-pointer hover:opacity-95 transition-opacity"
      alt="generated image"
    />

    <!-- Loading Skeleton -->
    <div
      v-else-if="loading"
      class="naidan-image-skeleton flex items-center justify-center bg-gray-100 dark:bg-gray-800 animate-pulse !m-0 rounded-xl"
      :style="{ width: `${displayDims.width}px`, maxWidth: '100%', aspectRatio: `${displayDims.width} / ${displayDims.height}` }"
    >
      <ImageIcon class="w-8 h-8 text-gray-400" />
    </div>

    <!-- Error -->
    <div
      v-else-if="error"
      class="p-3 bg-red-50 dark:bg-red-900/20 border border-red-100 dark:border-red-800 rounded-xl text-red-600 dark:text-red-400 text-xs flex flex-col items-center justify-center"
      :style="{ width: `${displayDims.width}px`, maxWidth: '100%', aspectRatio: `${displayDims.width} / ${displayDims.height}` }"
    >
      <AlertTriangle class="w-6 h-6 mb-2" />
      <span>{{ error }}</span>
    </div>

    <!-- Overlays (only if loaded) -->
    <template v-if="imageUrl">
      <!-- Info Badge (Top Left) -->
      <div class="absolute top-2 left-2 z-30 opacity-0 touch-visible group-hover/gen-img:opacity-100 transition-all overflow-visible">
        <ImageInfoDisplay
          :prompt="parsed.prompt || ''"
          :steps="parsed.steps"
          :seed="parsed.seed"
          :width="parsed.width"
          :height="parsed.height"
          align="left"
        />
      </div>

      <!-- Download Button (Top Right) -->
      <div class="absolute top-2 right-2 z-30 opacity-0 touch-visible group-hover/gen-img:opacity-100 transition-all overflow-visible">
        <ImageDownloadButton
          :is-supported="isSupported"
          align="right"
          @download="handleDownload"
        />
      </div>
    </template>
  </div>

  <!-- Fallback for invalid JSON -->
  <div v-else class="p-4 border border-red-200 bg-red-50 rounded text-red-500 text-xs">
    Invalid Image Block Data
  </div>
</template>
