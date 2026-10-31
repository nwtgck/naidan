<script setup lang="ts">
import { computed, onBeforeUnmount, ref, shallowRef, watch } from 'vue';
import { ImageIcon } from 'lucide-vue-next';
import { idToRaw, type BinaryObjectId } from '@/01-models/ids';
import type { BinaryObjectPreviewItem } from '@/composables/useImagePreview';
import BinaryObjectPreviewModal from '@/components/BinaryObjectPreviewModal.vue';
import { downloadBlob } from '@/utils/stream-download';
import { exactObject } from '@/utils/exact-object';
import { lazyStrings } from '@/strings';
import type { LiveTurnImage } from '@/features/live-conversation/logic/controller';

const props = defineProps<{ images: LiveTurnImage[] }>();
const emit = defineEmits<{ layout: [] }>();
const selectedId = ref<BinaryObjectId>();
const thumbnailUrls = shallowRef(new Map<BinaryObjectId, { blob: Blob, url: string }>());
let opener: HTMLElement | undefined;
const objects = computed<BinaryObjectPreviewItem[]>(() => props.images.map(({ id, blob, name, createdAt, ...unhandled }) => {
  unhandled satisfies Record<PropertyKey, never>;
  return exactObject<BinaryObjectPreviewItem>()({ id, mimeType: blob.type || 'image/*', size: blob.size, createdAt, name, memoryBlob: blob });
}));

function closePreview(): void {
  selectedId.value = undefined;
  if (opener?.isConnected) {
    opener.focus({ preventScroll: true });
  }
  opener = undefined;
}

function openPreview({ image, event }: { image: LiveTurnImage, event: MouseEvent }): void {
  opener = event.currentTarget instanceof HTMLElement ? event.currentTarget : undefined;
  selectedId.value = image.id;
}

function download({ object }: { object: BinaryObjectPreviewItem }): void {
  if (object.memoryBlob !== undefined && object.name !== undefined) {
    downloadBlob({ blob: object.memoryBlob, filename: object.name });
  }
}

watch(() => props.images, images => {
  const next = new Map<BinaryObjectId, { blob: Blob, url: string }>();
  for (const image of images) {
    const previous = thumbnailUrls.value.get(image.id);
    if (previous?.blob === image.blob) {
      next.set(image.id, previous);
    } else {
      // A preview failure must not break a conversation that already accepted
      // the image. The filename still opens the shared full-size preview.
      try {
        next.set(image.id, { blob: image.blob, url: URL.createObjectURL(image.blob) });
      } catch {
        // No thumbnail; the original Blob remains available to the viewer.
      }
    }
  }
  for (const [id, previous] of thumbnailUrls.value) {
    if (next.get(id) !== previous) {
      URL.revokeObjectURL(previous.url);
    }
  }
  thumbnailUrls.value = next;
  if (selectedId.value !== undefined && !images.some(image => image.id === selectedId.value)) {
    closePreview();
  }
}, { immediate: true });

onBeforeUnmount(() => {
  closePreview();
  for (const { url } of thumbnailUrls.value.values()) {
    URL.revokeObjectURL(url);
  }
  thumbnailUrls.value.clear();
});

defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>

<template>
  <div v-if="images.length" tw-class="flex flex-wrap gap-2" data-testid="live-message-images">
    <button v-for="image in images" :key="idToRaw({ id: image.id })" type="button" @click="openPreview({ image, event: $event })" :title="image.name" :aria-label="lazyStrings.liveConversation__preview_image({ name: image.name })" tw-class="group relative flex w-28 flex-col overflow-hidden rounded-xl border border-gray-200 bg-white text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:border-gray-700 dark:bg-gray-900" data-testid="live-image-preview">
      <img v-if="thumbnailUrls.get(image.id)" :src="thumbnailUrls.get(image.id)?.url" :alt="image.name" width="112" height="88" loading="lazy" @load="emit('layout')" tw-class="h-22 w-full object-contain transition-opacity group-hover:opacity-80" />
      <span v-else tw-class="flex h-22 items-center justify-center text-gray-400"><ImageIcon aria-hidden="true" tw-class="h-8 w-8" /></span>
      <span tw-class="block w-full truncate border-t border-gray-100 px-2 py-1.5 text-[11px] text-gray-500 dark:border-gray-800 dark:text-gray-400">{{ image.name }}</span>
    </button>
    <!-- memoryBlob uses the existing viewer without reading or writing storage.
         Its independent preview URL is revoked by the viewer on close. -->
    <BinaryObjectPreviewModal v-if="selectedId !== undefined" :objects="objects" :initial-id="selectedId" @close="closePreview" @download="download({ object: $event })" />
  </div>
</template>
