<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { BinaryObjectId } from '@/01-models/ids';
import { lazyStrings } from '@/strings';
const props = defineProps<{ binaryObjectId: BinaryObjectId, alt: string, eager?: boolean, thumbnail?: boolean, getImage: ({ binaryObjectId }: { binaryObjectId: BinaryObjectId }) => Promise<Blob | undefined> }>();
const url = ref<string>(), state = ref<'loading' | 'ready' | 'missing' | 'failed'>('loading');
const element = ref<HTMLElement>(), visible = ref(false);
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
watch(() => [props.binaryObjectId, props.getImage, visible.value] as const, async ([binaryObjectId, , visible]) => {
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
  <div ref="element" :tw-class="['rounded-lg bg-gray-50 dark:bg-gray-800/50 overflow-hidden min-h-20 flex items-center justify-center', thumbnail ? 'aspect-square' : '']" data-testid="image-history-image">
    <img v-if="url" :src="url" :alt="alt" loading="lazy" :tw-class="thumbnail ? 'w-full h-full object-cover' : 'max-w-full max-h-[36rem] object-contain'" />
    <p v-else role="status" tw-class="p-4 text-xs text-gray-500 dark:text-gray-400">{{ state === 'loading' ? lazyStrings.ImageHistoryImage__loading_image() : state === 'missing' ? lazyStrings.ImageHistoryImage__image_unavailable() : lazyStrings.ImageHistoryImage__could_not_load_image() }}</p>
  </div>
</template>
