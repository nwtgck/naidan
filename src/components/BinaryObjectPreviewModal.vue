<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted } from 'vue';
import type { BinaryObjectPreviewItem } from '@/composables/useImagePreview';
import { idToRaw } from '@/01-models/ids';
import { lazyStrings } from '@/strings';
import type { BinaryObjectId } from '@/01-models/ids';
import { storageService } from '@/00-storage/service';
import { useEventTargetListener } from '@/composables/useEventTargetListener';
import {
  XIcon, DownloadIcon, Trash2Icon, ChevronLeftIcon, ChevronRightIcon,
  ZoomInIcon, ZoomOutIcon,
  CopyIcon, CheckIcon, EyeIcon, RefreshCwIcon, CalendarIcon, InfoIcon, FileIcon,
} from 'lucide-vue-next';

interface Props {
  objects: BinaryObjectPreviewItem[],
  initialId: BinaryObjectId,
}

const props = defineProps<Props>();
const emit = defineEmits<{
  (e: 'close'): void,
  (e: 'delete', obj: BinaryObjectPreviewItem): void,
  (e: 'download', obj: BinaryObjectPreviewItem): void,
}>();

const currentIndex = ref(props.objects.findIndex(object => object.id === props.initialId));
watch([() => props.objects, () => props.initialId], ([objects, initialId], [previousObjects, previousInitialId]) => {
  const previous = previousObjects[currentIndex.value];
  if (initialId !== previousInitialId || previous === undefined) {
    currentIndex.value = objects.findIndex(object => object.id === initialId);
    return;
  }
  // Keep the selected occurrence: a message may reference the same binary more than once.
  let occurrence = previousObjects.slice(0, currentIndex.value).filter(object => object.id === previous.id).length;
  currentIndex.value = objects.findIndex(object => {
    if (object.id !== previous.id) return false;
    return occurrence-- === 0;
  });
});
const currentObject = computed(() => props.objects[currentIndex.value]);

const previewUrl = ref<string | undefined>(undefined);
const isImage = computed(() => currentObject.value?.mimeType.startsWith('image/'));
const isLoading = ref(false);

const zoom = ref(1);
const position = ref({ x: 0, y: 0 });
const isDragging = ref(false);
const lastMousePos = ref({ x: 0, y: 0 });

const isControlsVisible = ref(true);
let controlsTimeout: ReturnType<typeof setTimeout> | null = null;

const showControls = () => {
  isControlsVisible.value = true;
  if (controlsTimeout) clearTimeout(controlsTimeout);
  controlsTimeout = setTimeout(() => {
    if (zoom.value > 1) {
      isControlsVisible.value = false;
    }
  }, 3000);
};

const handleMouseMove = () => {
  showControls();
};

watch(currentObject, (obj, _previous, onCleanup) => {
  // The read and URL belong to this exact selection, not just to its binary ID.
  let active = true;
  let url: string | undefined;
  let loadingTimeout: ReturnType<typeof setTimeout> | undefined;
  previewUrl.value = undefined;
  isLoading.value = false;
  zoom.value = 1;
  position.value = { x: 0, y: 0 };
  isDragging.value = false;
  onCleanup(() => {
    active = false;
    if (loadingTimeout !== undefined) clearTimeout(loadingTimeout);
    if (url !== undefined) URL.revokeObjectURL(url);
  });
  if (!obj) return;
  loadingTimeout = setTimeout(() => {
    if (active) isLoading.value = true;
  }, 200);
  void (async () => {
    try {
      const blob = obj.memoryBlob ?? await storageService.getFile({ binaryObjectId: obj.id });
      if (!active || !blob) return;
      url = URL.createObjectURL(blob);
      previewUrl.value = url;
    } catch (error) {
      if (active) console.error('Failed to load preview:', error);
    } finally {
      if (active) {
        if (loadingTimeout !== undefined) clearTimeout(loadingTimeout);
        isLoading.value = false;
      }
    }
  })();
}, { immediate: true });

const next = () => {
  if (currentIndex.value < props.objects.length - 1) {
    currentIndex.value++;
  }
};

const prev = () => {
  if (currentIndex.value > 0) {
    currentIndex.value--;
  }
};

const handleKeydown = ({ event }: { event: KeyboardEvent }) => {
  if (event.key === 'ArrowRight') {
    event.preventDefault();
    next();
  }
  if (event.key === 'ArrowLeft') {
    event.preventDefault();
    prev();
  }
  if (event.key === 'Escape') {
    event.preventDefault();
    emit('close');
  }
};

useEventTargetListener(window, 'keydown', (event) => handleKeydown({ event }));

onMounted(() => {
  showControls();
});

onUnmounted(() => {
  if (controlsTimeout) clearTimeout(controlsTimeout);
});

const handleWheel = ({ event }: { event: WheelEvent }) => {
  if (!isImage.value) return;
  event.preventDefault();

  const zoomFactor = 1.1;
  const delta = -event.deltaY;
  const oldZoom = zoom.value;
  const newZoom = delta > 0 ? oldZoom * zoomFactor : oldZoom / zoomFactor;
  const clampedZoom = Math.min(Math.max(newZoom, 0.1), 20);

  if (clampedZoom === oldZoom) return;

  // Calculate focal point relative to the container
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
  const mouseX = event.clientX - rect.left;
  const mouseY = event.clientY - rect.top;

  // Calculate where the mouse is relative to the image center (in current zoom pixels)
  const relativeX = mouseX - rect.width / 2 - position.value.x;
  const relativeY = mouseY - rect.height / 2 - position.value.y;

  // Adjust position to keep the point under the mouse
  const ratio = clampedZoom / oldZoom;
  position.value = {
    x: mouseX - rect.width / 2 - relativeX * ratio,
    y: mouseY - rect.height / 2 - relativeY * ratio,
  };

  zoom.value = clampedZoom;

  // If zooming out to 1, reset position
  if (zoom.value <= 1) {
    position.value = { x: 0, y: 0 };
  }
};

const resetZoom = () => {
  zoom.value = 1;
  position.value = { x: 0, y: 0 };
};

const startDrag = ({ event }: { event: MouseEvent }) => {
  if (zoom.value <= 1) return;
  isDragging.value = true;
  lastMousePos.value = { x: event.clientX, y: event.clientY };
};

const onDrag = ({ event }: { event: MouseEvent }) => {
  if (!isDragging.value) return;
  const dx = event.clientX - lastMousePos.value.x;
  const dy = event.clientY - lastMousePos.value.y;
  position.value = {
    x: position.value.x + dx,
    y: position.value.y + dy,
  };
  lastMousePos.value = { x: event.clientX, y: event.clientY };
};

const stopDrag = () => {
  isDragging.value = false;
};

const formatSize = ({ bytes }: { bytes: number }) => {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
};

const formatDate = ({ timestamp }: { timestamp: number }) => {
  return new Date(timestamp).toLocaleString();
};

const isCopied = ref(false);
const copyName = async () => {
  if (!currentObject.value?.name) return;
  await navigator.clipboard.writeText(currentObject.value.name);
  isCopied.value = true;
  setTimeout(() => isCopied.value = false, 2000);
};


defineExpose({
  ...((__BUILD_MODE_IS_TEST__ && {
    TEST_ONLY: {
      // Export internal state and logic used only for testing here. Do not reference these in production logic.
    },
  }) || {}),
});
</script>

<template>
  <Teleport to="body">
    <div
      tw-class="fixed inset-0 z-[120] flex items-center justify-center bg-black/95 backdrop-blur-md overflow-hidden"
      @click="emit('close')"
      @mousemove="handleMouseMove"
    >
      <!-- Main Content Area -->
      <div
        v-if="currentObject"
        tw-class="relative w-full h-full flex items-center justify-center"
        @click.stop
      >
        <!-- Image/File Display -->
        <div
          tw-class="w-full h-full flex items-center justify-center p-0"
          @wheel.prevent="handleWheel({ event: $event })"
          @mousedown="startDrag({ event: $event })"
          @mousemove="onDrag({ event: $event })"
          @mouseup="stopDrag"
          @mouseleave="stopDrag"
        >
          <!-- Loading Overlay -->
          <div v-if="isLoading" data-testid="preview-loading" tw-class="absolute inset-0 flex items-center justify-center z-30 pointer-events-none bg-black/20 backdrop-blur-sm transition-opacity">
            <div tw-class="flex flex-col items-center gap-4 text-white">
              <RefreshCwIcon tw-class="w-10 h-10 animate-spin text-blue-500" />
              <p tw-class="text-xs font-bold tracking-widest opacity-50">{{ lazyStrings.binaryObjects__loading() }}</p>
            </div>
          </div>

          <transition name="preview-fade" mode="out-in">
            <div v-if="previewUrl" :key="idToRaw({ id: currentObject.id })" tw-class="w-full h-full flex items-center justify-center">
              <div
                v-if="isImage"
                tw-class="relative transition-transform duration-75 ease-out select-none flex items-center justify-center"
                :style="{
                  transform: `translate(${position.x}px, ${position.y}px) scale(${zoom})`,
                  cursor: zoom > 1 ? (isDragging ? 'grabbing' : 'grab') : 'default'
                }"
              >
                <img
                  data-testid="preview-image"
                  :src="previewUrl"
                  tw-class="max-w-screen max-h-screen object-contain shadow-2xl"
                  draggable="false"
                />
              </div>
              <div v-else tw-class="text-center space-y-6">
                <div tw-class="p-12 bg-white/10 backdrop-blur-xl rounded-[40px] shadow-2xl inline-block border border-white/10">
                  <FileIcon tw-class="w-24 h-24 text-white/20" />
                </div>
                <div tw-class="space-y-2">
                  <p tw-class="text-sm font-bold text-white/40 tracking-widest uppercase">{{ lazyStrings.binaryObjects__preview_unavailable() }}</p>
                  <p tw-class="text-xs font-medium text-white/30 max-w-[240px] mx-auto">{{ lazyStrings.binaryObjects__file_type_cannot_be_previewed() }}</p>
                </div>
              </div>
            </div>
          </transition>
        </div>

        <!-- Navigation Buttons -->
        <div
          :tw-class="['absolute inset-y-0 left-0 w-32 flex items-center justify-center transition-opacity duration-300 group/nav', isControlsVisible && currentIndex > 0 ? 'opacity-100' : 'opacity-0 pointer-events-none']"
        >
          <button
            @click="prev"
            data-testid="preview-prev-btn"
            tw-class="p-6 text-white/20 hover:text-white hover:bg-white/10 rounded-full transition-all group-hover/nav:scale-110 active:scale-95"
          >
            <ChevronLeftIcon tw-class="w-12 h-12" />
          </button>
        </div>
        <div
          :tw-class="['absolute inset-y-0 right-0 w-32 flex items-center justify-center transition-opacity duration-300 group/nav', isControlsVisible && currentIndex < objects.length - 1 ? 'opacity-100' : 'opacity-0 pointer-events-none']"
        >
          <button
            @click="next"
            data-testid="preview-next-btn"
            tw-class="p-6 text-white/20 hover:text-white hover:bg-white/10 rounded-full transition-all group-hover/nav:scale-110 active:scale-95"
          >
            <ChevronRightIcon tw-class="w-12 h-12" />
          </button>
        </div>

        <!-- Top Controls (Header) -->
        <div
          :tw-class="['absolute top-0 inset-x-0 p-6 flex items-center justify-between bg-gradient-to-b from-black/80 to-transparent transition-transform duration-500 z-20', isControlsVisible ? 'translate-y-0' : '-translate-y-full']"
        >
          <div tw-class="flex items-center gap-4 min-w-0 flex-1 mr-8">
            <div tw-class="p-2.5 bg-white/10 backdrop-blur-xl rounded-2xl border border-white/10 shrink-0">
              <EyeIcon v-if="isImage" tw-class="w-5 h-5 text-blue-400" />
              <FileIcon v-else tw-class="w-5 h-5 text-white/40" />
            </div>
            <div tw-class="min-w-0 flex flex-col">
              <div tw-class="flex items-center gap-2">
                <h3
                  tw-class="font-bold text-white truncate text-lg leading-tight"
                  :title="currentObject.name"
                  data-testid="preview-filename"
                >
                  {{ currentObject.name || lazyStrings.binaryObjects__unnamed() }}
                </h3>
                <button
                  @click="copyName"
                  tw-class="p-1 text-white/30 hover:text-white transition-colors shrink-0"
                  :title="lazyStrings.binaryObjects__copy_name()"
                  data-testid="preview-copy-name-btn"
                >
                  <CopyIcon v-if="!isCopied" tw-class="w-3.5 h-3.5" data-testid="icon-copy" />
                  <CheckIcon v-else tw-class="w-3.5 h-3.5 text-green-400" data-testid="icon-check" />
                </button>
              </div>
              <div tw-class="flex items-center gap-3 text-[10px] text-white/40 font-bold tracking-widest uppercase">
                <span data-testid="preview-mimetype">{{ currentObject.mimeType }}</span>
                <span tw-class="w-1 h-1 rounded-full bg-white/20"></span>
                <span data-testid="preview-size">{{ formatSize({ bytes: currentObject.size }) }}</span>
              </div>
            </div>
          </div>

          <div tw-class="flex items-center gap-3 shrink-0">
            <!-- Zoom Controls -->
            <div v-if="isImage" tw-class="flex items-center bg-white/10 backdrop-blur-xl rounded-2xl border border-white/10 p-1 mr-2">
              <button @click="zoom = Math.max(0.1, zoom / 1.2)" tw-class="p-2 text-white/60 hover:text-white transition-colors" :title="lazyStrings.binaryObjects__zoom_out()" data-testid="preview-zoom-out-btn">
                <ZoomOutIcon tw-class="w-4 h-4" />
              </button>
              <button @click="resetZoom" tw-class="px-2 text-[10px] font-bold text-white/60 hover:text-white transition-colors min-w-[56px]" :title="lazyStrings.binaryObjects__reset_zoom()" data-testid="preview-zoom-reset-btn">
                {{ Math.round(zoom * 100) }}%
              </button>
              <button @click="zoom = Math.min(20, zoom * 1.2)" tw-class="p-2 text-white/60 hover:text-white transition-colors" :title="lazyStrings.binaryObjects__zoom_in()" data-testid="preview-zoom-in-btn">
                <ZoomInIcon tw-class="w-4 h-4" />
              </button>
            </div>

            <button @click="emit('download', currentObject)" tw-class="p-3 bg-white/10 hover:bg-white/20 text-white rounded-2xl border border-white/10 transition-all active:scale-95" :title="lazyStrings.binaryObjects__download()" data-testid="preview-download-btn">
              <DownloadIcon tw-class="w-5 h-5" />
            </button>
            <button :disabled="currentObject.memoryBlob !== undefined" @click="currentObject.memoryBlob === undefined && emit('delete', currentObject)" tw-class="p-3 bg-red-500/20 hover:bg-red-500/40 text-red-400 rounded-2xl border border-red-500/20 transition-all active:scale-95 disabled:opacity-40 disabled:cursor-not-allowed" :title="lazyStrings.binaryObjects__delete()" data-testid="preview-delete-btn">
              <Trash2Icon tw-class="w-5 h-5" />
            </button>
            <div tw-class="w-px h-8 bg-white/10 mx-1"></div>
            <button @click="emit('close')" tw-class="p-3 bg-white/10 hover:bg-white/20 text-white rounded-2xl border border-white/10 transition-all active:scale-95" :title="lazyStrings.binaryObjects__close_with_escape()" data-testid="preview-close-btn">
              <XIcon tw-class="w-5 h-5" />
            </button>
          </div>
        </div>

        <!-- Bottom Status Info -->
        <div
          :tw-class="['absolute bottom-0 inset-x-0 p-6 flex items-center justify-center transition-transform duration-500 z-20', isControlsVisible ? 'translate-y-0' : 'translate-y-full']"
        >
          <div tw-class="px-6 py-2.5 bg-black/40 backdrop-blur-xl rounded-full border border-white/10 flex items-center gap-6">
            <div tw-class="flex items-center gap-2 text-[10px] text-white/40 font-bold uppercase tracking-widest" data-testid="preview-date">
              <CalendarIcon tw-class="w-3.5 h-3.5" />
              {{ formatDate({ timestamp: currentObject.createdAt }) }}
            </div>
            <div tw-class="w-px h-4 bg-white/10"></div>
            <div tw-class="flex items-center gap-2 text-[10px] text-white/40 font-mono" data-testid="preview-id">
              <InfoIcon tw-class="w-3.5 h-3.5" />
              {{ currentObject.id }}
            </div>
            <div tw-class="w-px h-4 bg-white/10"></div>
            <div tw-class="text-[10px] text-white/60 font-bold tracking-widest" data-testid="preview-index-info">
              {{ currentIndex + 1 }} <span tw-class="text-white/20">/</span> {{ objects.length }}
            </div>
          </div>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.preview-fade-enter-active,
.preview-fade-leave-active {
  transition: opacity 0.2s ease;
}

.preview-fade-enter-from,
.preview-fade-leave-to {
  opacity: 0;
}

.no-scrollbar::-webkit-scrollbar {
  display: none;
}
.no-scrollbar {
  -ms-overflow-style: none;
  scrollbar-width: none;
}
</style>
