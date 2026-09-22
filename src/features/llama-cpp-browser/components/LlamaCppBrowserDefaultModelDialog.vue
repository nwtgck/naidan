<script setup lang="ts">
import { computed, nextTick, onUnmounted, ref, useId, watch } from 'vue';
import { ArrowDownIcon, ArrowRightIcon, Loader2Icon, XIcon } from 'lucide-vue-next';
import { lazyStrings } from '@/strings';
import { cloneEndpoint } from '@/01-models/endpoint';
import { endpointTypeLabel } from '@/components/endpoint-type-label';
import { isDefaultLocalModel, localModelDisplayName, type ApplyDefaultModel, type DefaultModelContext } from '@/features/llama-cpp-browser/default-model';
import type { LocalModel } from '@/features/llama-cpp-browser/types';
const props = defineProps<{ model: LocalModel | undefined, current: DefaultModelContext | undefined, models: LocalModel[], apply: ApplyDefaultModel | undefined }>();
const emit = defineEmits<{ close: [] }>();
const id = useId();
const dialog = ref<HTMLElement>();
const saving = ref(false);
const failure = ref<'failed' | 'changed'>();
let previousFocus: HTMLElement | undefined;
let disposed = false;
const oldName = computed(() => {
  const name = props.current?.modelId;
  const model = props.models.find(entry => isDefaultLocalModel({ model: entry, current: props.current }));
  return model ? localModelDisplayName({ model }) : name ?? lazyStrings.llamaCppBrowserDownloads__not_set();
});
function close(): void {
  if (!saving.value) emit('close');
}
function restoreFocus(): void {
  if (previousFocus?.isConnected) previousFocus.focus();
  previousFocus = undefined;
}
watch(() => props.model, async model => {
  failure.value = undefined;
  if (!model) {
    restoreFocus(); return;
  }
  if (document.activeElement instanceof HTMLElement) previousFocus = document.activeElement;
  await nextTick();
  if (!disposed && props.model) dialog.value?.focus();
}, { immediate: true });
onUnmounted(() => {
  disposed = true; restoreFocus();
});
function keydown({ event }: { event: KeyboardEvent }): void {
  if (event.key === 'Escape') {
    event.stopPropagation(); close(); return;
  }
  if (event.key !== 'Tab') return;
  const elements = Array.from(dialog.value?.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input:not(:disabled), [tabindex="0"]') ?? []);
  const first = elements[0]; const last = elements.at(-1);
  if (!first || !last) {
    event.preventDefault(); return;
  }
  if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog.value)) {
    event.preventDefault(); last.focus();
  } else if (!event.shiftKey && (document.activeElement === last || document.activeElement === dialog.value)) {
    event.preventDefault(); first.focus();
  }
}
async function confirm(): Promise<void> {
  if (saving.value || !props.model || !props.current || !props.apply) return;
  const model = props.model;
  const previous = { endpoint: cloneEndpoint({ endpoint: props.current.endpoint }), modelId: props.current.modelId };
  saving.value = true; failure.value = undefined;
  try {
    const result = await props.apply({ model, previous });
    if (disposed) return;
    switch (result) {
    case 'applied': emit('close'); break;
    case 'changed': failure.value = 'changed'; break;
    default: { const exhaustive: never = result; throw new Error(String(exhaustive)); }
    }
  } catch {
    if (!disposed) failure.value = 'failed';
  } finally {
    saving.value = false;
  }
}
defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>
<template>
  <Teleport to="body">
    <Transition tw-enter-active-class="transition-opacity duration-200 motion-reduce:transition-none" tw-leave-active-class="transition-opacity duration-150 motion-reduce:transition-none" tw-enter-from-class="opacity-0" tw-leave-to-class="opacity-0">
      <div v-if="model" tw-class="fixed inset-0 z-[210] flex items-center justify-center p-4 bg-black/50 backdrop-blur-[2px]" data-testid="llama-default-model-dialog">
        <div ref="dialog" role="dialog" aria-modal="true" :aria-labelledby="`${id}-title`" :aria-describedby="`${id}-scope`" tabindex="-1" tw-class="w-full max-w-lg max-h-[90vh] overflow-y-auto rounded-2xl border border-gray-100 dark:border-gray-800 bg-white dark:bg-gray-900 shadow-2xl outline-none" @keydown="keydown({ event: $event })">
          <div tw-class="flex items-start justify-between gap-4 px-6 py-4 border-b border-gray-100 dark:border-gray-800 bg-gray-50/50 dark:bg-gray-800/30">
            <h3 :id="`${id}-title`" tw-class="text-base font-bold text-gray-800 dark:text-white">{{ lazyStrings.llamaCppBrowserDownloads__change_default_model() }}</h3>
            <button type="button" :disabled="saving" :aria-label="lazyStrings.SHARED__cancel()" tw-class="p-1 rounded-lg text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 disabled:opacity-50" @click="close"><XIcon tw-class="w-4 h-4" /></button>
          </div>
          <div tw-class="p-6 space-y-5">
            <!-- The model is the user's focus; always show it BEFORE the endpoint. -->
            <div data-testid="llama-default-model-change" tw-class="space-y-2">
              <p tw-class="text-xs font-bold text-gray-500 dark:text-gray-400">{{ lazyStrings.llamaCppBrowserDownloads__default_model() }}</p>
              <div tw-class="grid grid-cols-1 sm:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] gap-3 items-center">
                <p tw-class="text-sm break-all text-gray-500 dark:text-gray-400">{{ oldName }}</p>
                <ArrowRightIcon tw-class="hidden sm:block w-4 h-4 text-gray-400" /><ArrowDownIcon tw-class="sm:hidden w-4 h-4 text-gray-400" />
                <p tw-class="text-sm font-bold break-words text-purple-700 dark:text-purple-300">{{ localModelDisplayName({ model }) }}</p>
              </div>
            </div>
            <div v-if="current && current.endpoint.type !== 'llama_cpp_browser'" data-testid="llama-default-endpoint-change" tw-class="space-y-2">
              <p tw-class="text-xs font-bold text-gray-500 dark:text-gray-400">{{ lazyStrings.llamaCppBrowserDownloads__endpoint_type() }}</p>
              <div tw-class="flex flex-wrap items-center gap-3 text-sm text-gray-600 dark:text-gray-300"><span>{{ endpointTypeLabel({ endpointType: current.endpoint.type }) }}</span><ArrowRightIcon tw-class="w-4 h-4 text-gray-400" /><span tw-class="font-bold">llama.cpp browser</span></div>
            </div>
            <p :id="`${id}-scope`" tw-class="text-xs leading-relaxed text-gray-500 dark:text-gray-400">{{ lazyStrings.llamaCppBrowserDownloads__global_settings_scope() }}</p>
            <p v-if="failure" role="alert" tw-class="text-xs text-red-600 dark:text-red-400">{{ failure === 'changed' ? lazyStrings.llamaCppBrowserDownloads__settings_changed_review_again() : lazyStrings.llamaCppBrowser__operation_failed() }}</p>
            <div tw-class="flex justify-end gap-3 pt-2">
              <button type="button" :disabled="saving" data-testid="llama-default-cancel" tw-class="px-4 py-2.5 text-xs font-bold rounded-xl text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 disabled:opacity-50" @click="close">{{ lazyStrings.SHARED__cancel() }}</button>
              <button type="button" :disabled="saving || !apply || !current" data-testid="llama-default-confirm" tw-class="inline-flex items-center gap-2 px-4 py-2.5 text-xs font-bold rounded-xl text-white bg-purple-600 hover:bg-purple-700 shadow-lg shadow-purple-500/20 disabled:opacity-50 disabled:cursor-not-allowed" @click="confirm"><Loader2Icon v-if="saving" tw-class="w-4 h-4 animate-spin" />{{ lazyStrings.llamaCppBrowserDownloads__set_as_default() }}</button>
            </div>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>
