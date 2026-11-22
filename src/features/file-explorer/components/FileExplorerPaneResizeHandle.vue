<script setup lang="ts">
import type { useFileExplorerPaneWidth } from '@/features/file-explorer/composables/useFileExplorerPaneWidth';

defineProps<{
  edge: 'left' | 'right',
  label: string | undefined,
  controls: string,
  resize: ReturnType<typeof useFileExplorerPaneWidth>,
  wideOnly?: boolean,
}>();

defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>

<template>
  <div
    role="separator"
    aria-orientation="vertical"
    tabindex="0"
    :title="label"
    :aria-label="label"
    :aria-controls="controls"
    :aria-valuemin="resize.minimum.value"
    :aria-valuemax="resize.maximum.value"
    :aria-valuenow="resize.width.value"
    :tw-class="[
      'group absolute inset-y-0 z-10 w-2 touch-none cursor-col-resize items-center focus-visible:outline-none',
      wideOnly ? 'hidden sm:flex' : 'flex',
      edge === 'left' ? 'left-0 justify-start' : 'right-0 justify-end',
      resize.resizing.value && 'bg-blue-500/15',
    ]"
    @pointerdown="resize.start({ event: $event })"
    @pointermove="resize.move({ event: $event })"
    @pointerup="resize.end({ event: $event, finish: 'save' })"
    @pointercancel="resize.end({ event: $event, finish: 'cancel' })"
    @lostpointercapture="resize.end({ event: $event, finish: 'cancel' })"
    @keydown="resize.onKeydown({ event: $event })"
  >
    <span aria-hidden="true" tw-class="h-7 w-0.5 rounded-sm bg-gray-300 group-hover:bg-blue-500 group-focus-visible:bg-blue-500 dark:bg-gray-600" />
  </div>
</template>
