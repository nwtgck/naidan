<script setup lang="ts">
import { computed, defineAsyncComponent, ref, useTemplateRef, watch } from 'vue';
import { ImageOffIcon, PencilIcon, ZoomInIcon, ZoomOutIcon } from 'lucide-vue-next';
import { useImageViewport } from '@/composables/useImageViewport';
import { trapImageDialogFocus } from '@/features/image-generation/dialog-keyboard';
import { lazyStrings } from '@/strings';

const props = defineProps<{ url: string, fileName: string, mimeType: string, canSave: boolean, compact?: boolean }>();
const emit = defineEmits<{ save: [result: { blob: Blob }] }>();
const ImageEditor = defineAsyncComponent({ loader: () => import('@/components/ImageEditor.vue'), suspensible: false });
const { zoom, position, reset, magnify, pointerDown, pointerMove, endPan } = useImageViewport();
const imageState = ref<'loading' | 'loaded' | 'failed'>('loading');
const editorUrl = ref<string>();
const editButton = useTemplateRef<HTMLButtonElement>('editButton');
const editorDialog = useTemplateRef<HTMLElement>('editorDialog');
const canEdit = computed(() => props.canSave && imageState.value === 'loaded');

watch(() => props.url, () => {
  imageState.value = 'loading';
  editorUrl.value = undefined;
  reset();
});

watch(editorUrl, url => {
  if (url !== undefined) {
    editorDialog.value?.focus();
  } else if (document.activeElement === document.body) {
    editButton.value?.focus();
  }
}, { flush: 'post' });

function updateLoadState({ event, state }: { event: Event, state: 'loaded' | 'failed' }): void {
  if (event.currentTarget instanceof HTMLImageElement && event.currentTarget.getAttribute('src') === props.url) {
    imageState.value = state;
  }
}

function openEditor(): void {
  if (canEdit.value) {
    editorUrl.value = props.url;
  }
}

function finishEditing({ blob }: { blob: Blob }): void {
  if (editorUrl.value === props.url && props.canSave) {
    editorUrl.value = undefined;
    emit('save', { blob });
  }
}

defineExpose({
  ...((__BUILD_MODE_IS_TEST__ && {
    TEST_ONLY: {
      // Export internal state and logic used only for testing here. Do not reference these in production logic.
      // ESLint-required for defineExpose.
    },
  }) || {}),
});
</script>

<template>
  <div tw-class="flex min-h-0 flex-1 flex-col" data-testid="file-explorer-image-view">
    <div tw-class="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-gray-100 px-3 py-2 dark:border-gray-800">
      <div tw-class="flex items-center gap-1">
        <button
          type="button"
          :disabled="imageState !== 'loaded'"
          :aria-label="lazyStrings.FileExplorerImageView__zoom_out()"
          :title="lazyStrings.FileExplorerImageView__zoom_out()"
          tw-class="grid h-8 w-8 place-items-center rounded-md text-gray-500 hover:bg-gray-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/50 disabled:opacity-40 dark:text-gray-400 dark:hover:bg-gray-800"
          data-testid="file-explorer-image-zoom-out"
          @click="magnify({ factor: 1 / 1.25 })"
        >
          <ZoomOutIcon aria-hidden="true" tw-class="h-4 w-4" />
        </button>
        <button
          type="button"
          :disabled="imageState !== 'loaded'"
          :aria-label="lazyStrings.FileExplorerImageView__fit_image()"
          :title="lazyStrings.FileExplorerImageView__fit_image()"
          tw-class="h-8 min-w-12 rounded-md px-2 text-xs tabular-nums text-gray-600 hover:bg-gray-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/50 disabled:opacity-40 dark:text-gray-300 dark:hover:bg-gray-800"
          data-testid="file-explorer-image-fit"
          @click="reset()"
        >
          {{ Math.round(zoom * 100) }}%
        </button>
        <button
          type="button"
          :disabled="imageState !== 'loaded'"
          :aria-label="lazyStrings.FileExplorerImageView__zoom_in()"
          :title="lazyStrings.FileExplorerImageView__zoom_in()"
          tw-class="grid h-8 w-8 place-items-center rounded-md text-gray-500 hover:bg-gray-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/50 disabled:opacity-40 dark:text-gray-400 dark:hover:bg-gray-800"
          data-testid="file-explorer-image-zoom-in"
          @click="magnify({ factor: 1.25 })"
        >
          <ZoomInIcon aria-hidden="true" tw-class="h-4 w-4" />
        </button>
      </div>
      <button
        v-if="!compact"
        ref="editButton"
        type="button"
        :disabled="!canEdit"
        :title="canSave ? undefined : lazyStrings.fileExplorer__read_only()"
        tw-class="flex h-8 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium text-blue-600 hover:bg-blue-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/50 disabled:opacity-40 dark:text-blue-300 dark:hover:bg-blue-950"
        data-testid="file-explorer-edit-image"
        @click="openEditor()"
      >
        <PencilIcon aria-hidden="true" tw-class="h-3.5 w-3.5" />
        {{ lazyStrings.FileExplorerImageView__edit_image() }}
      </button>
    </div>

    <div v-if="imageState === 'failed'" role="alert" tw-class="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-4 text-center text-sm text-gray-500 dark:text-gray-400">
      <ImageOffIcon aria-hidden="true" tw-class="h-6 w-6" />
      {{ lazyStrings.FileExplorerImageView__could_not_load_image() }}
    </div>
    <div
      v-else
      :tw-class="['flex min-h-0 flex-1 touch-none items-center justify-center overflow-hidden bg-gray-100 p-3 dark:bg-gray-950', imageState === 'loaded' ? 'cursor-grab' : '']"
      data-testid="file-explorer-image-stage"
      @wheel.prevent="imageState === 'loaded' && magnify({ factor: $event.deltaY < 0 ? 1.1 : 1 / 1.1 })"
      @pointerdown="imageState === 'loaded' && pointerDown({ event: $event })"
      @pointermove="pointerMove({ event: $event })"
      @pointerup="endPan({ event: $event })"
      @pointercancel="endPan({ event: $event })"
      @lostpointercapture="endPan({ event: $event })"
    >
      <div :style="{ transform: `translate(${position.x}px, ${position.y}px) scale(${zoom})` }" tw-class="pointer-events-none flex h-full w-full min-w-0 items-center justify-center select-none" data-testid="file-explorer-image-transform">
        <img
          :key="url"
          :src="url"
          :alt="fileName"
          tw-class="max-h-full max-w-full object-contain"
          @load="updateLoadState({ event: $event, state: 'loaded' })"
          @error="updateLoadState({ event: $event, state: 'failed' })"
        />
      </div>
    </div>

    <Teleport to="body">
      <div
        v-if="editorUrl !== undefined"
        ref="editorDialog"
        role="dialog"
        aria-modal="true"
        :aria-label="lazyStrings.ImageEditor__image_editor()"
        tabindex="-1"
        tw-class="fixed inset-0 z-[140] bg-black/95 outline-none"
        data-testid="file-explorer-image-editor-dialog"
        @keydown.tab="trapImageDialogFocus({ root: editorDialog ?? undefined, event: $event })"
      >
        <ImageEditor
          :image-url="editorUrl"
          :file-name="fileName"
          :original-mime-type="mimeType"
          initial-output-format="original"
          @save="finishEditing"
          @cancel="editorUrl = undefined"
        />
      </div>
    </Teleport>
  </div>
</template>
