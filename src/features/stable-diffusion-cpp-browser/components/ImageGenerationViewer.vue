<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { ChevronLeftIcon, ChevronRightIcon, XIcon, ZoomInIcon, ZoomOutIcon } from 'lucide-vue-next';
import { lazyStrings } from '@/strings';
const props = defineProps<{ count: number, downloadEnabled: boolean }>();
const index = defineModel<number>('index', { required: true });
const emit = defineEmits<{ close: [], download: [] }>();
const container = ref<HTMLElement>(), zoom = ref(1), position = ref({ x: 0, y: 0 });
let previousFocus: HTMLElement | undefined;
let pointer: { id: number, x: number, y: number } | undefined;
function reset(): void {
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
  if (event.key === 'Escape') {
    event.preventDefault();
    emit('close');
  }
  if (event.key === 'ArrowLeft') {
    event.preventDefault();
    move({ offset: -1 });
  }
  if (event.key === 'ArrowRight') {
    event.preventDefault();
    move({ offset: 1 });
  }
  if (event.key === 'Tab') {
    const buttons = Array.from(container.value?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? []);
    const first = buttons[0], last = buttons.at(-1);
    if (event.shiftKey && (document.activeElement === first || document.activeElement === container.value)) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first?.focus();
    }
  }
}
function pointerDown({ event }: { event: PointerEvent }): void {
  if (!(event.currentTarget instanceof HTMLElement)) return;
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
onBeforeUnmount(() => previousFocus?.focus());
defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: { zoom, position } }) || {}) });
</script>
<template>
  <Teleport to="body">
    <div ref="container" role="dialog" aria-modal="true" :aria-label="lazyStrings.ImageGenerationViewer__image_preview()" tabindex="-1" @keydown="keydown({ event: $event })" data-testid="image-viewer" tw-class="fixed inset-0 z-[120] bg-black/95 text-white flex flex-col outline-none">
      <div tw-class="flex flex-wrap items-center justify-between gap-2 p-3">
        <div tw-class="flex items-center gap-2">
          <button type="button" @click="move({ offset: -1 })" :disabled="index <= 0" :aria-label="lazyStrings.ImageGenerationViewer__previous_image()" data-testid="image-viewer-previous" tw-class="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 min-h-10 min-w-10 p-2 rounded-lg hover:bg-white/10 disabled:opacity-30">
            <ChevronLeftIcon tw-class="w-5 h-5" />
          </button>
          <span tw-class="text-xs tabular-nums">{{ index + 1 }} / {{ count }}</span>
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
          <slot v-if="downloadEnabled !== false" name="download"><button type="button" @click="emit('download')" tw-class="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 min-h-10 min-w-10 p-2 text-xs underline">{{ lazyStrings.stableDiffusionCppBrowser__download_png() }}</button></slot>
          <button type="button" @click="emit('close')" :aria-label="lazyStrings.ImageGenerationViewer__close_preview()" tw-class="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 min-h-10 min-w-10 p-2 rounded-lg hover:bg-white/10">
            <XIcon tw-class="w-5 h-5" />
          </button>
        </div>
      </div>
      <div tw-class="min-h-0 flex-1 overflow-hidden flex items-center justify-center touch-none cursor-grab" @wheel.prevent="magnify({ factor: $event.deltaY < 0 ? 1.1 : 1 / 1.1 })" @pointerdown="pointerDown({ event: $event })" @pointermove="pointerMove({ event: $event })" @pointerup="pointer = undefined" @pointercancel="pointer = undefined">
        <div :style="{ transform: `translate(${position.x}px, ${position.y}px) scale(${zoom})` }" tw-class="max-w-full max-h-full select-none pointer-events-none">
          <slot :index="index" />
        </div>
      </div>
    </div>
  </Teleport>
</template>
