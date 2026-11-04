<script setup lang="ts">
import { onScopeDispose, ref, useId, useTemplateRef, watch } from 'vue';
import { CheckIcon, ChevronDownIcon, CopyIcon } from 'lucide-vue-next';
import SettingsCollapse from '@/components/SettingsCollapse.vue';
import { lazyStrings } from '@/strings';

const props = defineProps<{ summary: string | undefined, details: string | undefined }>();
const expanded = ref(false);
const visited = ref(false);
const copyStatus = ref<'copied' | 'failed'>();
const trigger = useTemplateRef<HTMLButtonElement>('trigger');
const panelId = useId();
let generation = 0;
watch(() => props.details, () => {
  generation++;
  expanded.value = false;
  visited.value = false;
  copyStatus.value = undefined;
});
onScopeDispose(() => generation++);

async function copyDetails(): Promise<void> {
  const details = props.details;
  if (details === undefined) {
    return;
  }
  const operation = ++generation;
  copyStatus.value = undefined;
  try {
    await navigator.clipboard.writeText(details);
    if (generation === operation) {
      copyStatus.value = 'copied';
    }
  } catch {
    if (generation === operation) {
      copyStatus.value = 'failed';
    }
  }
}

function close({ event }: { event: KeyboardEvent }): void {
  if (expanded.value && !event.isComposing && event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    expanded.value = false;
    trigger.value?.focus({ preventScroll: true });
  }
}

defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>

<template>
  <div v-if="summary || details" data-testid="llama-error-details" tw-class="min-w-0 text-left" @keydown="close({ event: $event })">
    <p data-testid="llama-error-summary-row" role="alert" tw-class="text-xs leading-relaxed text-red-600 dark:text-red-400">
      <button v-if="details" ref="trigger" type="button" data-testid="llama-error-details-toggle" :title="lazyStrings.LlamaCppBrowserErrorDetails__error_details()" :aria-expanded="expanded" :aria-controls="expanded ? panelId : undefined" tw-class="inline-flex max-w-full items-center gap-1.5 rounded-sm text-left transition-colors hover:text-red-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 dark:hover:text-red-300 motion-reduce:transition-none" @click="visited = true; expanded = !expanded">
        <span tw-class="min-w-0">{{ summary ?? lazyStrings.LlamaCppBrowserErrorDetails__error_details() }}</span>
        <span data-testid="llama-error-details-label" tw-class="inline-flex shrink-0 items-center gap-0.5 whitespace-nowrap rounded-md bg-gray-100 px-1.5 py-0.5 font-medium text-gray-500 transition-colors hover:bg-gray-200 hover:text-gray-700 dark:bg-gray-800 dark:text-gray-400 dark:hover:bg-gray-700 dark:hover:text-gray-200 motion-reduce:transition-none">
          {{ lazyStrings.LlamaCppBrowserErrorDetails__details() }}
          <ChevronDownIcon aria-hidden="true" :tw-class="['h-3 w-3 transition-transform duration-150 motion-reduce:transition-none', expanded ? 'rotate-180' : '']" />
        </span>
      </button>
      <template v-else>{{ summary }}</template>
    </p>
    <SettingsCollapse :id="panelId" :open="expanded" :return-focus="trigger ?? undefined">
      <div v-if="visited" data-testid="llama-error-details-panel" tw-class="min-w-0 space-y-2 pb-2 pt-1">
        <div tw-class="flex justify-end">
          <button type="button" data-testid="llama-error-details-copy" tw-class="inline-flex min-h-9 items-center gap-1.5 rounded-lg px-2 text-xs text-gray-500 hover:bg-gray-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 dark:text-gray-400 dark:hover:bg-gray-800" @click="copyDetails">
            <CheckIcon v-if="copyStatus === 'copied'" aria-hidden="true" tw-class="h-3.5 w-3.5" /><CopyIcon v-else aria-hidden="true" tw-class="h-3.5 w-3.5" />
            {{ copyStatus === 'copied' ? lazyStrings.LlamaCppBrowserErrorDetails__copied() : lazyStrings.LlamaCppBrowserErrorDetails__copy_details() }}
          </button>
        </div>
        <pre data-testid="llama-error-details-text" tabindex="0" tw-class="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-xl border border-gray-200/70 bg-gray-50/80 p-3 font-mono text-xs leading-relaxed text-gray-600 select-text dark:border-gray-700/70 dark:bg-gray-950/40 dark:text-gray-300">{{ details }}</pre>
        <p v-if="copyStatus === 'failed'" role="status" tw-class="text-xs text-gray-500 dark:text-gray-400">{{ lazyStrings.LlamaCppBrowserErrorDetails__copy_failed_select_the_text() }}</p>
      </div>
    </SettingsCollapse>
  </div>
</template>
