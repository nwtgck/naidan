<script setup lang="ts">
import { computed, nextTick, onScopeDispose, ref, shallowRef, useId, watch } from 'vue';
import { onClickOutside } from '@vueuse/core';
import { CheckIcon, ChevronDownIcon, Loader2Icon, RefreshCcwIcon } from 'lucide-vue-next';
import { lazyStrings } from '@/strings';
import { useAnchoredPopup } from '@/composables/useAnchoredPopup';
import { useEventTargetListener } from '@/composables/useEventTargetListener';
import type { RepositoryCatalog } from '@/features/llama-cpp-browser/hugging-face/catalog';
import { artifactRole } from '@/features/llama-cpp-browser/hugging-face/artifact-role';
import { formatDownloadBytes, quantizationChoices, selectedQuantizationChoice } from '@/features/llama-cpp-browser/hugging-face/presentation';

const props = defineProps<{ repository: string, variant: string | undefined, disabled: boolean, inspection: 'model-url' | 'on-request' }>();
const emit = defineEmits<{ select: [path: string], inspected: [catalog: RepositoryCatalog | undefined] }>();
const trigger = ref<HTMLElement | null>(null);
const panel = ref<HTMLElement | null>(null);
const panelId = useId();
const open = ref(false);
const status = ref<'idle' | 'loading' | 'ready' | 'failed'>('idle');
const catalog = shallowRef<RepositoryCatalog>();
let controller: AbortController | undefined;
const popup = useAnchoredPopup({ anchor: trigger, preferredWidth: { unit: 'rem', value: 21 }, maxWidthPx: 400 });
const choices = computed(() => catalog.value === undefined ? [] : quantizationChoices({ repository: catalog.value.repository, models: catalog.value.models })
  .filter(choice => artifactRole({ path: choice.primaryRelativePath }) === 'model'));
const selectedPath = computed(() => props.variant === undefined ? choices.value[0]?.primaryRelativePath
  : selectedQuantizationChoice({ choices: choices.value, variant: props.variant })?.primaryRelativePath);
const selectedLabel = computed(() => choices.value.find(choice => choice.primaryRelativePath === selectedPath.value)?.label ?? props.variant);

function cancelInspection(): void {
  controller?.abort();
  controller = undefined;
}

function close({ focus }: { focus: 'restore' | 'preserve' }): void {
  open.value = false;
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

function focusPicker(): void {
  const selected = panel.value?.querySelector<HTMLElement>('[aria-selected="true"]');
  (selected ?? panel.value?.querySelector<HTMLElement>('[data-testid="quantization-fetch-options"], [role="option"]'))?.focus();
}

async function toggle(): Promise<void> {
  if (props.disabled) {
    return;
  }
  if (open.value) {
    close({ focus: 'preserve' });
    return;
  }
  popup.refresh();
  open.value = true;
  await nextTick();
  popup.refresh();
  focusPicker();
}

async function inspect({ freshness }: { freshness: 'reuse' | 'refresh' }): Promise<void> {
  if (controller !== undefined || !props.repository) {
    return;
  }
  const inspection = props.inspection;
  switch (inspection) {
  case 'model-url': break;
  case 'on-request':
    if (props.disabled) {
      return;
    }
    break;
  default: {
    const exhaustive: never = inspection;
    throw new Error(String(exhaustive));
  }
  }
  const input = props.repository;
  const request = new AbortController();
  controller = request;
  status.value = 'loading';
  try {
    // The model-url policy is a privacy exception authorized by the URL itself.
    // It only inspects metadata; downloading files still requires Start.
    const { getMetadataSession } = await import('@/features/llama-cpp-browser/hugging-face/metadata-session');
    if (request.signal.aborted) {
      return;
    }
    const result = await getMetadataSession().inspect({ input, signal: request.signal, freshness });
    if (controller !== request || request.signal.aborted || props.repository !== input) {
      return;
    }
    catalog.value = result;
    status.value = 'ready';
    emit('inspected', result);
    await nextTick();
    if (controller === request && open.value) {
      popup.refresh();
      focusPicker();
    }
  } catch {
    if (controller === request && !request.signal.aborted) {
      status.value = 'failed';
    }
  } finally {
    if (controller === request) {
      controller = undefined;
    }
  }
}

function select({ path }: { path: string }): void {
  if (props.disabled || status.value !== 'ready' || !choices.value.some(choice => choice.primaryRelativePath === path)) {
    return;
  }
  emit('select', path);
  close({ focus: 'restore' });
}

function handleKeydown({ event }: { event: KeyboardEvent }): void {
  if (event.isComposing || event.defaultPrevented || !open.value) {
    return;
  }
  if (event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    close({ focus: 'restore' });
    return;
  }
  if (event.key === 'Tab') {
    close({ focus: 'restore' });
    return;
  }
  const options = Array.from(panel.value?.querySelectorAll<HTMLElement>('[role="option"]') ?? []);
  if (!options.length) {
    return;
  }
  const index = options.indexOf(document.activeElement as HTMLElement);
  const next = event.key === 'ArrowDown' ? (index + 1) % options.length : event.key === 'ArrowUp' ? (index - 1 + options.length) % options.length
    : event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1 : undefined;
  if (next !== undefined) {
    event.preventDefault();
    options[next]?.focus();
  }
}

watch([() => props.repository, () => props.inspection], ([repository, inspection]) => {
  cancelInspection();
  close({ focus: 'preserve' });
  const hadCatalog = catalog.value !== undefined;
  catalog.value = undefined;
  status.value = 'idle';
  if (hadCatalog) {
    emit('inspected', undefined);
  }
  switch (inspection) {
  case 'model-url':
    // This exception must not spread to ordinary home/discovery views. Merely
    // opening/closing the choices does not start, repeat, or cancel this read.
    if (repository) {
      void inspect({ freshness: 'reuse' });
    }
    break;
  case 'on-request': break;
  default: {
    const exhaustive: never = inspection;
    throw new Error(String(exhaustive));
  }
  }
}, { immediate: true, flush: 'sync' });
watch(() => props.disabled, disabled => {
  if (disabled) {
    close({ focus: 'preserve' });
  }
}, { flush: 'sync' });
onScopeDispose(cancelInspection);
onClickOutside(panel, () => close({ focus: 'preserve' }), { ignore: [trigger] });
useEventTargetListener(document, 'keydown', event => handleKeydown({ event }));
useEventTargetListener(document, 'focusin', event => {
  if (open.value && event.target instanceof Node && !panel.value?.contains(event.target) && !trigger.value?.contains(event.target)) {
    close({ focus: 'preserve' });
  }
});
defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>

<template>
  <button ref="trigger" type="button" :disabled="disabled" :title="selectedLabel" :aria-label="lazyStrings.LlamaCppBrowserModelLaunch__quantization()" aria-haspopup="dialog" :aria-expanded="open" :aria-controls="open ? panelId : undefined" data-testid="model-preview-quantization" tw-class="inline-flex h-6 max-w-[12rem] items-center gap-1 rounded-md border border-transparent bg-transparent py-0 pl-1.5 pr-1 text-[11px] leading-4 font-normal text-gray-500 dark:text-gray-400 enabled:hover:border-gray-200 dark:enabled:hover:border-gray-700 enabled:hover:bg-gray-100/70 dark:enabled:hover:bg-gray-800/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors" @click="toggle"><Loader2Icon v-if="status === 'loading'" aria-hidden="true" tw-class="h-2.5 w-2.5 shrink-0 animate-spin motion-reduce:animate-none" /><span tw-class="min-w-0 truncate">{{ selectedLabel ?? lazyStrings.LlamaCppBrowserModelLaunch__quantization() }}</span><ChevronDownIcon aria-hidden="true" :tw-class="['h-2.5 w-2.5 shrink-0 text-gray-400 dark:text-gray-500 transition-transform motion-reduce:transition-none', open ? 'rotate-180' : '']" /></button>
  <Teleport to="body">
    <Transition tw-enter-active-class="transition-[opacity,transform] duration-150 motion-reduce:transition-none" tw-leave-active-class="transition-opacity duration-100 motion-reduce:transition-none" tw-enter-from-class="opacity-0 translate-y-1" tw-leave-to-class="opacity-0">
      <section v-if="open" :id="panelId" ref="panel" role="dialog" :aria-label="lazyStrings.LlamaCppBrowserModelLaunch__quantization()" :aria-busy="status === 'loading'" :style="popup.placement.value.style" data-testid="quantization-picker" tw-class="flex flex-col overflow-hidden rounded-xl border border-gray-200 bg-white text-left shadow-xl shadow-gray-950/15 dark:border-gray-700 dark:bg-gray-900 dark:shadow-black/40">
        <header tw-class="flex min-h-10 shrink-0 items-center justify-between gap-3 border-b border-gray-100 px-3 py-1.5 dark:border-gray-800">
          <h3 tw-class="text-xs font-medium text-gray-500 dark:text-gray-400">{{ lazyStrings.LlamaCppBrowserModelLaunch__quantization() }}</h3>
          <button v-if="status === 'ready'" type="button" :disabled="disabled" :aria-label="lazyStrings.LlamaCppBrowserQuantizationPicker__fetch_options()" data-testid="quantization-check-again" tw-class="-mr-1 grid h-7 w-7 shrink-0 place-items-center rounded-lg text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600 focus-visible:outline-2 focus-visible:outline-blue-500 disabled:opacity-50 dark:hover:bg-gray-800 dark:hover:text-gray-200" @click="inspect({ freshness: 'refresh' })"><RefreshCcwIcon aria-hidden="true" tw-class="h-3 w-3" /></button>
        </header>
        <div v-if="status === 'loading'" role="status" tw-class="flex items-center gap-2 p-4 text-xs text-gray-500 dark:text-gray-400"><Loader2Icon aria-hidden="true" tw-class="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />{{ lazyStrings.LlamaCppBrowserQuantizationPicker__fetching_options() }}</div>
        <div v-else-if="status === 'idle' || status === 'failed'" tw-class="space-y-3 p-3">
          <p v-if="status === 'failed'" role="alert" tw-class="text-xs leading-relaxed text-red-600 dark:text-red-400">{{ lazyStrings.LlamaCppBrowserQuantizationPicker__could_not_fetch_options() }}</p>
          <button type="button" :disabled="disabled" data-testid="quantization-fetch-options" tw-class="min-h-9 rounded-lg border border-gray-200 px-3 py-2 text-xs font-medium text-blue-600 transition-colors hover:bg-gray-50 focus-visible:outline-2 focus-visible:outline-blue-500 disabled:opacity-50 dark:border-gray-700 dark:text-blue-400 dark:hover:bg-gray-800" @click="inspect({ freshness: 'refresh' })">{{ lazyStrings.LlamaCppBrowserQuantizationPicker__fetch_options() }}</button>
        </div>
        <div v-else-if="choices.length" role="listbox" :aria-label="lazyStrings.LlamaCppBrowserModelLaunch__quantization()" tw-class="min-h-0 overflow-y-auto overscroll-contain p-1.5">
          <button v-for="choice in choices" :key="choice.primaryRelativePath" type="button" role="option" :aria-selected="selectedPath === choice.primaryRelativePath" :data-testid="'quantization-option-' + choice.primaryRelativePath" :tw-class="['flex min-h-9 w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-xs outline-none transition-colors focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-400/50', selectedPath === choice.primaryRelativePath ? 'bg-blue-50 text-blue-600 dark:bg-blue-500/10 dark:text-blue-400' : 'text-gray-700 hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-gray-800']" @click="select({ path: choice.primaryRelativePath })"><span tw-class="min-w-0 flex-1 break-words font-medium">{{ choice.label }}</span><span tw-class="shrink-0 text-[11px] tabular-nums text-gray-500 dark:text-gray-400">{{ formatDownloadBytes({ bytes: choice.models.reduce((total, model) => total + model.size, 0) }) }}</span><CheckIcon v-if="selectedPath === choice.primaryRelativePath" aria-hidden="true" tw-class="h-3 w-3 shrink-0" /></button>
        </div>
        <p v-else tw-class="p-4 text-xs leading-relaxed text-gray-500 dark:text-gray-400">{{ lazyStrings.LlamaCppBrowserHuggingFaceManager__no_complete_gguf_models_found() }}</p>
      </section>
    </Transition>
  </Teleport>
</template>
