<script setup lang="ts">
import { computed, onScopeDispose, ref, useId, watch } from 'vue';
import { CheckIcon, ChevronDownIcon, CopyIcon, FileDownIcon, LinkIcon } from 'lucide-vue-next';
import { lazyStrings } from '@/strings';
import { modelDownloadUrl } from '@/features/llama-cpp-browser/hugging-face/download-url';
import { formatDownloadBytes } from '@/features/llama-cpp-browser/hugging-face/download-plan';
import { selectionSchema } from '@/features/llama-cpp-browser/hugging-face/types';
import type { DownloadJob } from '@/features/llama-cpp-browser/hugging-face/download-queue';

const props = defineProps<{ job: DownloadJob }>();
const open = ref(false);
const trigger = ref<HTMLButtonElement>();
const panelId = useId();
const triggerId = useId();
// Keep the immutable plan separate from byte ticks. Validation/URL construction
// must not run for every progress update; the file list is only mounted on open.
const plan = computed(() => props.job.selection);
const selection = computed(() => {
  const parsed = selectionSchema.safeParse(plan.value);
  return parsed.success ? parsed.data : undefined;
});
const files = computed(() => {
  const source = selection.value;
  return source?.files.map(file => ({ ...file, url: modelDownloadUrl({ ...source, file }) })) ?? [];
});
const currentFileIndex = computed(() => props.job.status === 'downloading' || props.job.status === 'pausing' ? props.job.progress?.currentFileIndex : undefined);
const copyState = ref<{ url: string, status: 'copied' | 'failed' }>();
let generation = 0;
watch([() => props.job.id, plan], () => {
  generation++; open.value = false; copyState.value = undefined;
});
onScopeDispose(() => generation++);
function close(): void {
  if (!open.value) return;
  open.value = false; trigger.value?.focus();
}
async function copyUrl({ url }: { url: string }): Promise<void> {
  const operation = ++generation;
  copyState.value = undefined;
  try {
    await navigator.clipboard.writeText(url);
    if (operation === generation) copyState.value = { url, status: 'copied' };
  } catch {
    if (operation === generation) copyState.value = { url, status: 'failed' };
  }
}
defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>
<template>
  <div v-if="selection" data-testid="model-download-sources" tw-class="min-w-0 text-left" @keydown.esc.stop.prevent="close()">
    <button ref="trigger" :id="triggerId" type="button" :aria-expanded="open" :aria-controls="panelId" data-testid="model-download-sources-toggle" @click="open = !open" tw-class="min-h-11 inline-flex max-w-full items-center gap-2 rounded-lg px-2 text-xs text-gray-500 dark:text-gray-400 hover:text-blue-600 dark:hover:text-blue-400 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500 transition-colors motion-reduce:transition-none">
      <LinkIcon aria-hidden="true" tw-class="w-3.5 h-3.5 shrink-0" />
      <span>{{ lazyStrings.LlamaCppBrowserDownloadSources__files_and_sources() }}</span>
      <ChevronDownIcon aria-hidden="true" :tw-class="['w-3.5 h-3.5 shrink-0 transition-transform duration-150 motion-reduce:transition-none', open ? 'rotate-180' : '']" />
    </button>
    <Transition name="sources">
      <section v-if="open" :id="panelId" :aria-labelledby="triggerId" data-testid="model-download-sources-panel" tw-class="mt-1 min-w-0 space-y-3 border-l-2 border-blue-100 dark:border-blue-900/50 pl-3 sm:pl-4 py-2">
        <p tw-class="text-xs leading-relaxed text-gray-500 dark:text-gray-400">{{ lazyStrings.LlamaCppBrowserDownloadSources__request_urls_help() }}</p>
        <p tw-class="text-xs text-gray-500 dark:text-gray-400 break-all">{{ lazyStrings.LlamaCppBrowserDownloadSources__revision() }} <code tw-class="font-mono text-[11px] select-text">{{ selection.revision }}</code></p>
        <ol tw-class="max-h-72 overflow-y-auto overscroll-contain space-y-4 pr-1">
          <li v-for="(file, index) in files" :key="file.path" :data-current="currentFileIndex === index ? 'true' : undefined" tw-class="min-w-0 space-y-1.5">
            <div tw-class="flex items-start gap-2 text-xs">
              <FileDownIcon aria-hidden="true" :tw-class="['mt-0.5 w-3.5 h-3.5 shrink-0', currentFileIndex === index ? 'text-blue-600 dark:text-blue-400' : 'text-gray-400']" />
              <span tw-class="min-w-0 break-all text-gray-700 dark:text-gray-200">{{ file.path }}</span>
              <span tw-class="ml-auto shrink-0 tabular-nums text-gray-500 dark:text-gray-400">{{ formatDownloadBytes({ bytes: file.size }) }}</span>
            </div>
            <p v-if="currentFileIndex === index" tw-class="text-[11px] font-medium text-blue-600 dark:text-blue-400">{{ lazyStrings.LlamaCppBrowserDownloadSources__current_file() }}</p>
            <!-- Displaying or expanding URLs never makes a request. These are
                 the pinned URLs passed to fetch, not inferred CDN redirects. -->
            <div tw-class="flex items-start gap-2">
              <code data-testid="model-download-url" tw-class="flex-1 min-w-0 break-all select-text font-mono text-[11px] leading-relaxed text-gray-500 dark:text-gray-400">{{ file.url }}</code>
              <button type="button" :aria-label="`${lazyStrings.LlamaCppBrowserDownloadSources__copy_url()}: ${file.path}`" :title="lazyStrings.LlamaCppBrowserDownloadSources__copy_url()" data-testid="model-download-copy" @click="copyUrl({ url: file.url })" tw-class="min-w-11 min-h-11 -mt-2 rounded-lg flex items-center justify-center text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 focus-visible:outline-2 focus-visible:outline-blue-500">
                <CheckIcon v-if="copyState?.url === file.url && copyState.status === 'copied'" aria-hidden="true" tw-class="w-3.5 h-3.5" />
                <CopyIcon v-else aria-hidden="true" tw-class="w-3.5 h-3.5" />
              </button>
            </div>
          </li>
        </ol>
        <p v-if="copyState" role="status" tw-class="text-xs text-gray-500 dark:text-gray-400">{{ copyState.status === 'copied' ? lazyStrings.LlamaCppBrowserDownloadSources__url_copied() : lazyStrings.LlamaCppBrowserDownloadSources__copy_failed() }}</p>
      </section>
    </Transition>
  </div>
</template>
<style scoped>
.sources-enter-active, .sources-leave-active { transition: opacity 150ms ease, transform 150ms ease; }
.sources-enter-from, .sources-leave-to { opacity: 0; transform: translateY(-0.2rem); }
@media (prefers-reduced-motion: reduce) {
  .sources-enter-active, .sources-leave-active { transition: none; }
}
</style>
