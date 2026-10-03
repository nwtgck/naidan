<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, useId, watch } from 'vue';
import { ChevronLeftIcon, ChevronRightIcon, XIcon, SlidersHorizontalIcon, ZoomInIcon, ZoomOutIcon } from 'lucide-vue-next';
import { trapImageDialogFocus } from '@/features/stable-diffusion-cpp-browser/dialog-keyboard';
import { lazyStrings } from '@/strings';
const props = defineProps<{ count: number, downloadEnabled: boolean }>();
const index = defineModel<number>('index', { required: true });
const emit = defineEmits<{ close: [], download: [] }>();
const container = ref<HTMLElement>(), zoom = ref(1), position = ref({ x: 0, y: 0 });
const detailsOpen = ref(false), detailsId = useId();
let previousFocus: HTMLElement | undefined;
let pointer: { id: number, x: number, y: number } | undefined;
function reset(): void {
  pointer = undefined;
  zoom.value = 1;
  position.value = { x: 0, y: 0 };
}
watch(index, reset);
function move({ offset }: { offset: number }): void {
  index.value = Math.max(0, Math.min(props.count - 1, index.value + offset));
}
function magnify({ factor }: { factor: number }): void {
  zoom.value = Math.max(0.25, Math.min(8, zoom.value * factor));
}
function keydown({ event }: { event: KeyboardEvent }): void {
  if (event.defaultPrevented || event.isComposing) return;
  trapImageDialogFocus({ root: container.value, event });
  if (event.key === 'Escape') {
    event.preventDefault(); emit('close'); return;
  }
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
  if (event.target instanceof Element && event.target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="slider"], [role="listbox"], [role="menu"], [data-image-viewer-keys="local"]')) return;
  switch (event.key) {
  case 'ArrowLeft': event.preventDefault(); move({ offset: -1 }); break;
  case 'ArrowRight': event.preventDefault(); move({ offset: 1 }); break;
  }
}
function pointerDown({ event }: { event: PointerEvent }): void {
  if (!(event.currentTarget instanceof HTMLElement) || event.button !== 0) return;
  pointer = { id: event.pointerId, x: event.clientX, y: event.clientY };
  event.currentTarget.setPointerCapture(event.pointerId);
}
function pointerMove({ event }: { event: PointerEvent }): void {
  if (!pointer || event.pointerId !== pointer.id) return;
  position.value = { x: position.value.x + event.clientX - pointer.x, y: position.value.y + event.clientY - pointer.y };
  pointer = { ...pointer, x: event.clientX, y: event.clientY };
}
onMounted(() => {
  if (document.activeElement instanceof HTMLElement) previousFocus = document.activeElement;
  container.value?.focus();
});
onBeforeUnmount(() => {
  if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
});
defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: { zoom, position, detailsOpen } }) || {}) });
</script>
<template>
  <Teleport to="body">
    <div ref="container" role="dialog" aria-modal="true" :aria-label="lazyStrings.ImageGenerationViewer__image_preview()" tabindex="-1" @keydown="keydown({ event: $event })" data-testid="image-viewer" tw-class="overscroll-contain fixed inset-0 z-[120] bg-black/95 text-white flex flex-col outline-none">
      <div tw-class="flex flex-wrap items-center justify-between gap-2 p-3">
        <div tw-class="flex items-center gap-2">
          <button type="button" @click="move({ offset: -1 })" :disabled="index <= 0" :aria-label="lazyStrings.ImageGenerationViewer__previous_image()" data-testid="image-viewer-previous" tw-class="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 min-h-10 min-w-10 p-2 rounded-lg hover:bg-white/10 disabled:opacity-30">
            <ChevronLeftIcon tw-class="w-5 h-5" />
          </button>
          <span tw-class="text-xs tabular-nums">{{ count ? index + 1 : 0 }} / {{ count }}</span>
          <button type="button" @click="move({ offset: 1 })" :disabled="index >= count - 1" :aria-label="lazyStrings.ImageGenerationViewer__next_image()" data-testid="image-viewer-next" tw-class="p-2 rounded-lg hover:bg-white/10 disabled:opacity-30">
            <ChevronRightIcon tw-class="w-5 h-5" />
          </button>
        </div>
        <div tw-class="flex items-center gap-2">
          <button type="button" @click="magnify({ factor: 1 / 1.25 })" :aria-label="lazyStrings.ImageGenerationViewer__zoom_out()" tw-class="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 min-h-10 min-w-10 p-2 rounded-lg hover:bg-white/10">
            <ZoomOutIcon tw-class="w-5 h-5" />
          </button>
          <button type="button" @click="reset" :aria-label="lazyStrings.ImageGenerationViewer__reset_view()" tw-class="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 min-h-10 min-w-10 p-2 text-xs tabular-nums rounded-lg hover:bg-white/10">{{ Math.round(zoom * 100) }}%</button>
          <button type="button" @click="magnify({ factor: 1.25 })" :aria-label="lazyStrings.ImageGenerationViewer__zoom_in()" data-testid="image-viewer-zoom-in" tw-class="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 min-h-10 min-w-10 p-2 rounded-lg hover:bg-white/10">
            <ZoomInIcon tw-class="w-5 h-5" />
          </button>
          <slot name="toolbar" />
          <button v-if="$slots.details" type="button" @click="detailsOpen = !detailsOpen" :aria-expanded="detailsOpen" :aria-controls="detailsId" :aria-label="lazyStrings.ImageGenerationViewer__details()" data-testid="image-viewer-details-toggle" :tw-class="['min-h-10 min-w-10 p-2 rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500', detailsOpen ? 'bg-white/20' : 'hover:bg-white/10']"><SlidersHorizontalIcon tw-class="w-5 h-5" /></button>
          <slot v-if="downloadEnabled !== false" name="download"><button type="button" @click="emit('download')" tw-class="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 min-h-10 min-w-10 p-2 text-xs underline">{{ lazyStrings.stableDiffusionCppBrowser__download_png() }}</button></slot>
          <button type="button" @click="emit('close')" :aria-label="lazyStrings.ImageGenerationViewer__close_preview()" data-testid="image-viewer-close" tw-class="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 min-h-10 min-w-10 p-2 rounded-lg hover:bg-white/10">
            <XIcon tw-class="w-5 h-5" />
          </button>
        </div>
      </div>
      <div tw-class="flex flex-col md:flex-row min-h-0 flex-1">
        <div data-testid="image-viewer-stage" tw-class="min-w-0 min-h-0 flex-1 overflow-hidden flex items-center justify-center touch-none cursor-grab" @wheel.prevent="magnify({ factor: $event.deltaY < 0 ? 1.1 : 1 / 1.1 })" @pointerdown="pointerDown({ event: $event })" @pointermove="pointerMove({ event: $event })" @pointerup="pointer = undefined" @pointercancel="pointer = undefined">
          <div :style="{ transform: `translate(${position.x}px, ${position.y}px) scale(${zoom})` }" tw-class="w-full h-full max-w-full max-h-full flex items-center justify-center select-none pointer-events-none">
            <slot :index="index" />
          </div>
        </div>
        <aside v-if="$slots.details && detailsOpen" :id="detailsId" data-image-viewer-details tw-class="overscroll-contain shrink-0 md:w-80 lg:w-96 max-h-[42vh] md:max-h-full overflow-y-auto border-t md:border-t-0 md:border-l border-gray-700 bg-white dark:bg-gray-900 text-gray-800 dark:text-gray-100 p-4 space-y-4">
          <slot name="details" />
        </aside>
      </div>
    </div>
  </Teleport>
</template>
