<script setup lang="ts">
import { nextTick, onMounted, onScopeDispose, ref, watch } from 'vue';
import { launcherCategories, launcherCategoryLabel, type LauncherCategory } from '@/logic/launcher';
import { lazyStrings } from '@/strings';

const props = defineProps<{ category: LauncherCategory, blocked: boolean }>();
const emit = defineEmits<{ 'update:category': [category: LauncherCategory] }>();
const tabs = ref<HTMLElement>();
const highlight = ref<HTMLElement>();
const indicator = ref<{ transform: string, width: string, height: string }>();
let observer: ResizeObserver | undefined;
let animation: Animation | undefined;
let measurement = 0;

function measureIndicator({ animate }: { animate: boolean }): void {
  const button = tabs.value?.querySelector<HTMLButtonElement>('[aria-pressed="true"]');
  if (button === undefined || button === null || button.offsetWidth === 0) {
    return;
  }
  const next = { transform: `translate(${button.offsetLeft}px, ${button.offsetTop}px)`, width: `${button.offsetWidth}px`, height: `${button.offsetHeight}px` };
  if (indicator.value?.transform === next.transform && indicator.value.width === next.width && indicator.value.height === next.height) {
    return;
  }
  const current = indicator.value === undefined || highlight.value === undefined ? undefined : getComputedStyle(highlight.value);
  const from = current === undefined ? undefined : { transform: current.transform, width: current.width, height: current.height };
  animation?.cancel();
  indicator.value = next;
  const version = ++measurement;
  if (animate && from !== undefined && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches !== true) {
    void nextTick(() => {
      if (measurement === version) {
        animation = highlight.value?.animate?.([from, next], { duration: 220, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' });
      }
    });
  }
}

onMounted(() => {
  measureIndicator({ animate: false });
  if (typeof ResizeObserver !== 'undefined' && tabs.value !== undefined) {
    observer = new ResizeObserver(() => {
      measureIndicator({ animate: false });
    });
    observer.observe(tabs.value);
    for (const button of tabs.value.querySelectorAll('button')) {
      observer.observe(button);
    }
  }
});
watch(() => props.category, () => {
  measureIndicator({ animate: true });
}, { flush: 'post' });
onScopeDispose(() => {
  ++measurement;
  observer?.disconnect();
  animation?.cancel();
});

defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>

<template>
  <div ref="tabs" role="group" :aria-label="lazyStrings.launcher__categories()" tw-class="relative isolate flex shrink-0 items-center gap-[7px] overflow-x-auto whitespace-nowrap py-1">
    <span ref="highlight" aria-hidden="true" :style="indicator" tw-class="pointer-events-none absolute left-0 top-0 z-0 rounded-[9px] bg-blue-100/70 shadow-sm dark:bg-[#253650]" />
    <button v-for="item in launcherCategories" :key="item" type="button" :data-testid="`launcher-category-${item}`" :aria-pressed="category === item" :disabled="blocked" @click="emit('update:category', item)" :tw-class="['relative z-10 min-h-8 shrink-0 rounded-[9px] px-[13px] py-2 text-xs font-medium transition-colors duration-200 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500 disabled:opacity-50 motion-reduce:transition-none', category === item ? 'text-blue-800 dark:text-blue-200' : 'text-gray-500 hover:bg-gray-100 hover:text-gray-800 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-gray-200']">{{ launcherCategoryLabel({ category: item }) }}</button>
  </div>
</template>
