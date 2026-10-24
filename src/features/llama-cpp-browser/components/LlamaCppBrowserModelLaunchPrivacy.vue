<script setup lang="ts">
import { nextTick, ref, useId } from 'vue';
import { onClickOutside } from '@vueuse/core';
import { ChevronDownIcon, ShieldCheckIcon, CpuIcon, AppWindowIcon, DownloadIcon } from 'lucide-vue-next';
import { lazyStrings } from '@/strings';
import { useAnchoredPopup } from '@/composables/useAnchoredPopup';
import { useEventTargetListener } from '@/composables/useEventTargetListener';

defineProps<{ appearance?: 'full' | 'compact', fileSource?: 'hugging-face' | 'local' }>();
const trigger = ref<HTMLElement | null>(null);
const panel = ref<HTMLElement | null>(null);
const visibility = ref<'closed' | 'open'>('closed');
const explanationId = useId();
const popup = useAnchoredPopup({ anchor: trigger, preferredWidth: { unit: 'rem', value: 23 }, maxWidthPx: 384, preferredPlacement: { direction: 'bottom', minHeightPx: 320 } });

function closeExplanation({ focus }: { focus: 'restore' | 'preserve' }): void {
  visibility.value = 'closed';
  switch (focus) {
  case 'restore': trigger.value?.focus();
    break;
  case 'preserve': break;
  default: {
    const exhaustive: never = focus;
    throw new Error(String(exhaustive));
  }
  }
}

function toggleExplanation(): void {
  switch (visibility.value) {
  case 'closed':
    visibility.value = 'open';
    popup.refresh();
    void nextTick(popup.refresh);
    break;
  case 'open': closeExplanation({ focus: 'preserve' });
    break;
  default: {
    const exhaustive: never = visibility.value;
    throw new Error(String(exhaustive));
  }
  }
}

onClickOutside(panel, () => closeExplanation({ focus: 'preserve' }), { ignore: [trigger] });
useEventTargetListener(document, 'keydown', event => {
  if (event.key !== 'Escape' || event.defaultPrevented || visibility.value !== 'open') {
    return;
  }
  event.preventDefault();
  event.stopPropagation();
  closeExplanation({ focus: 'restore' });
});
useEventTargetListener(document, 'focusin', event => {
  if (!(event.target instanceof Node) || panel.value?.contains(event.target) || trigger.value?.contains(event.target)) {
    return;
  }
  closeExplanation({ focus: 'preserve' });
});
defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>

<template>
  <div data-testid="model-launch-privacy">
    <button ref="trigger" type="button" :aria-controls="explanationId" :aria-expanded="visibility === 'open'" data-testid="model-launch-privacy-trigger" :tw-class="['inline-flex items-center justify-center min-w-0 transition-colors motion-reduce:transition-none focus-visible:outline-2 focus-visible:outline-blue-500', appearance === 'compact' ? 'min-h-9 gap-1.5 whitespace-nowrap rounded-lg px-1 text-[11px] text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 hover:text-gray-700 dark:hover:text-gray-200' : 'min-h-11 gap-2 rounded-full px-4 py-2 text-xs sm:text-sm font-medium text-blue-700 dark:text-blue-300 bg-blue-50/80 dark:bg-blue-500/10 border border-blue-100/70 dark:border-blue-500/15 hover:bg-blue-100/70 dark:hover:bg-blue-500/15 focus-visible:outline-offset-4']" @click="toggleExplanation">
      <ShieldCheckIcon aria-hidden="true" tw-class="h-3.5 w-3.5 shrink-0 text-blue-500 dark:text-blue-400" />
      <span>{{ appearance === 'compact' ? lazyStrings.llamaCppBrowser__runs_in_your_browser() : lazyStrings.LlamaCppBrowserModelLaunch__runs_privately_in_your_browser() }}</span>
      <ChevronDownIcon aria-hidden="true" :tw-class="['h-3 w-3 shrink-0 transition-transform duration-200 motion-reduce:transition-none', visibility === 'open' ? 'rotate-180' : '']" />
    </button>
    <Teleport to="body">
      <Transition tw-enter-active-class="transition-[opacity,transform] duration-200 motion-reduce:transition-none" tw-leave-active-class="transition-opacity duration-150 motion-reduce:transition-none" tw-enter-from-class="opacity-0 translate-y-1" tw-leave-to-class="opacity-0">
        <section v-if="visibility === 'open'" :id="explanationId" ref="panel" role="region" data-testid="model-launch-privacy-explanation" :style="popup.placement.value.style" tw-class="overflow-y-auto overscroll-contain rounded-2xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-5 text-left shadow-xl text-xs leading-relaxed">
          <ul tw-class="space-y-4">
            <li tw-class="flex items-start gap-3">
              <CpuIcon aria-hidden="true" tw-class="mt-0.5 w-4 h-4 shrink-0 text-blue-500 dark:text-blue-400" />
              <div>
                <p tw-class="font-medium text-gray-800 dark:text-gray-100">{{ lazyStrings.LlamaCppBrowserModelLaunchPrivacy__runs_on_your_device() }}</p>
                <p tw-class="mt-1 text-gray-500 dark:text-gray-400">{{ lazyStrings.LlamaCppBrowserModelLaunchPrivacy__inference_in_this_browser() }}</p>
              </div>
            </li>
            <li tw-class="flex items-start gap-3">
              <AppWindowIcon aria-hidden="true" tw-class="mt-0.5 w-4 h-4 shrink-0 text-blue-500 dark:text-blue-400" />
              <div>
                <p tw-class="font-medium text-gray-800 dark:text-gray-100">{{ lazyStrings.LlamaCppBrowserModelLaunchPrivacy__no_apps_or_servers() }}</p>
                <p tw-class="mt-1 text-gray-500 dark:text-gray-400">{{ lazyStrings.LlamaCppBrowserModelLaunchPrivacy__browser_not_cloud_or_native_server() }}</p>
              </div>
            </li>
            <li v-if="fileSource !== 'local'" tw-class="flex items-start gap-3">
              <DownloadIcon aria-hidden="true" tw-class="mt-0.5 w-4 h-4 shrink-0 text-blue-500 dark:text-blue-400" />
              <div>
                <p tw-class="font-medium text-gray-800 dark:text-gray-100">{{ lazyStrings.LlamaCppBrowserModelLaunchPrivacy__model_files_from_hugging_face() }}</p>
                <p tw-class="mt-1 text-gray-500 dark:text-gray-400">{{ lazyStrings.LlamaCppBrowserModelLaunchPrivacy__model_files_are_downloaded() }}</p>
              </div>
            </li>
          </ul>
        </section>
      </Transition>
    </Teleport>
  </div>
</template>
