<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { BinaryObjectId } from '@/01-models/ids';
import { lazyStrings } from '@/strings';
const props = defineProps<{ binaryObjectId: BinaryObjectId, width: number, height: number, alt: string, eager?: boolean, thumbnail?: boolean, viewer?: boolean, invalidation?: { binaryObjectId: BinaryObjectId, revision: number }, getImage: ({ binaryObjectId }: { binaryObjectId: BinaryObjectId }) => Promise<Blob | undefined> }>();
const url = ref<string>(), state = ref<'loading' | 'ready' | 'missing' | 'failed'>('loading');
const element = ref<HTMLElement>(), visible = ref(false);
const imageRevision = ref(0);
watch(() => props.invalidation, event => {
  if (event?.binaryObjectId === props.binaryObjectId) imageRevision.value++;
});
let observer: IntersectionObserver | undefined;
let revision = 0;
onMounted(() => {
  if (props.eager || typeof IntersectionObserver === 'undefined') {
    visible.value = true;
    return;
  }
  observer = new IntersectionObserver(entries => {
    visible.value = entries.some(entry => entry.isIntersecting);
  });
  if (element.value) observer.observe(element.value);
});
function release(): void {
  if (url.value) URL.revokeObjectURL(url.value);
  url.value = undefined;
}
watch(() => [props.binaryObjectId, props.getImage, visible.value, imageRevision.value] as const, async ([binaryObjectId, , visible]) => {
  const current = ++revision;
  release();
  state.value = 'loading';
  if (!visible) return;
  try {
    const blob = await props.getImage({ binaryObjectId });
    if (revision !== current) return;
    if (blob) {
      url.value = URL.createObjectURL(blob);
      state.value = 'ready';
    } else state.value = 'missing';
  } catch {
    if (revision === current) state.value = 'failed';
  }
}, { immediate: true });
onBeforeUnmount(() => {
  revision++;
  observer?.disconnect();
  release();
});
defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>
<template>
  <div ref="element" :tw-class="viewer ? 'w-full h-full min-h-0 flex items-center justify-center' : 'rounded-xl bg-gray-50 dark:bg-gray-800/50 overflow-hidden min-h-20 flex items-center justify-center'" data-testid="image-history-image">
    <template v-if="viewer">
      <img v-if="url" :src="url" :alt="alt" :width="width" :height="height" decoding="async" tw-class="block max-w-full max-h-full object-contain" />
      <p v-else role="status" tw-class="p-4 text-xs text-gray-400">{{ state === 'loading' ? lazyStrings.ImageHistoryImage__loading_image() : state === 'missing' ? lazyStrings.ImageHistoryImage__image_unavailable() : lazyStrings.ImageHistoryImage__could_not_load_image() }}</p>
    </template>
    <!-- Releasing an offscreen URL must not collapse the image area and trigger
         another intersection/read cycle. Dimensions are known before loading. -->
    <div v-else :style="thumbnail ? undefined : { width: `${width}px`, aspectRatio: `${width} / ${height}` }" :tw-class="['relative max-w-full', thumbnail ? 'w-full aspect-square' : 'max-h-[36rem]']" data-testid="image-history-frame">
      <img v-if="url" :src="url" :alt="alt" :width="width" :height="height" :tw-class="['absolute inset-0 w-full h-full', thumbnail ? 'object-cover' : 'object-contain']" />
      <div v-else tw-class="absolute inset-0 flex items-center justify-center">
        <p role="status" tw-class="p-4 text-xs text-gray-500 dark:text-gray-400">{{ state === 'loading' ? lazyStrings.ImageHistoryImage__loading_image() : state === 'missing' ? lazyStrings.ImageHistoryImage__image_unavailable() : lazyStrings.ImageHistoryImage__could_not_load_image() }}</p>
      </div>
    </div>
  </div>
</template>
