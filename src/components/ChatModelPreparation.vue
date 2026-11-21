<script setup lang="ts">
import { computed } from 'vue';
import { AlertCircleIcon, ArrowLeftIcon, CpuIcon, DownloadIcon, Loader2Icon, XIcon } from 'lucide-vue-next';
import { lazyStrings } from '@/strings';
import type { ChatLocalModelUi } from '@/composables/chat/chat-scoped/useChatLocalModel';
import type { ModelDirectoryInput } from '@/features/llama-cpp-browser/types';
import type { LocalModelLaunchChatUi } from '@/features/llama-cpp-browser/composables/useLocalModelLaunchChat';
import LlamaCppBrowserDownloadJob from '@/features/llama-cpp-browser/components/LlamaCppBrowserDownloadJob.vue';
import LocalModelPreparation from './LocalModelPreparation.vue';

const props = defineProps<{ selection: ChatLocalModelUi, localState: LocalModelLaunchChatUi | undefined }>();
const emit = defineEmits<{ cancel: [], 'choose-again': [] }>();
const downloadModelName = computed(() => {
  const job = props.selection.downloadJob.value;
  if (job === undefined) {
    return undefined;
  }
  return job.repository.split('/').at(-1) ?? job.repository;
});
const disabled = computed(() => props.selection.operation.value?.phase === 'committing' || props.selection.operation.value?.phase === 'cancelling');

const operationFailed = computed(() => props.selection.operation.value?.phase === 'error');
const operationError = computed(() => {
  const error = props.selection.operation.value?.error;
  switch (error) {
  case 'not-empty': return lazyStrings.ChatLocalModelInput__this_chat_already_has_messages();
  case 'unavailable': return lazyStrings.LlamaCppBrowserModelLaunch__unavailable_here();
  case undefined: case 'invalid-gguf': case 'duplicate-model': case 'missing-model': case 'storage-error':
  case 'runtime-error': case 'template-unsupported': case 'reasoning-unsupported': case 'context-full': case 'unsupported-input':
  case 'busy': case 'aborted': case 'worker-failed': case 'audio-model-unsupported': case 'audio-reference-required':
  case 'audio-reference-invalid': case 'audio-output-empty': return lazyStrings.LlamaCppBrowserModelLaunch__could_not_prepare_model();
  default: throw new Error(String(error satisfies never));
  }
});

function acceptFailedDownloadFiles({ directories, controller }: { directories: Promise<ModelDirectoryInput[]>, controller: AbortController }): Promise<void> {
  void directories.catch(() => {});
  const selection = props.selection;
  const operation = selection.operation.value;
  if (disabled.value || operation?.phase !== 'error' || selection.downloadJob.value?.status !== 'failed') {
    controller.abort();
    return Promise.resolve();
  }
  return selection.acceptAfterFailedDownload({ directories, controller, operationId: operation.id });
}

defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>

<template>
  <section data-testid="chat-model-preparation" class="chat-model-preparation" tw-class="mx-auto w-full max-w-4xl rounded-xl border border-gray-200/80 bg-white px-3 py-3 text-left shadow-sm dark:border-gray-700 dark:bg-gray-900 sm:px-4">
    <div tw-class="flex items-start gap-2.5">
      <span tw-class="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-lg bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400"><AlertCircleIcon v-if="localState?.status.value === 'error' || selection.operation.value?.phase === 'error'" aria-hidden="true" tw-class="h-3.5 w-3.5 text-red-500 dark:text-red-400" /><Loader2Icon v-else-if="localState?.status.value === 'loading' || (selection.operation.value && !selection.downloadJob.value)" aria-hidden="true" tw-class="h-3.5 w-3.5 animate-spin text-blue-500 motion-reduce:animate-none" /><DownloadIcon v-else-if="selection.downloadJob.value" aria-hidden="true" tw-class="h-3.5 w-3.5" /><CpuIcon v-else aria-hidden="true" tw-class="h-3.5 w-3.5" /></span>
      <div tw-class="min-w-0 flex-1 space-y-1.5">
        <LocalModelPreparation v-if="localState !== undefined" :state="localState" appearance="compact" :error-message="selection.operation.value?.error === 'not-empty' ? lazyStrings.ChatLocalModelInput__this_chat_already_has_messages() : undefined" />
        <LlamaCppBrowserDownloadJob v-else-if="selection.downloadJob.value !== undefined && (!operationFailed || selection.downloadJob.value.status !== 'complete')" :key="selection.operation.value?.id" :job="selection.downloadJob.value" :disabled="disabled" :accept-local-input="acceptFailedDownloadFiles" appearance="welcome" density="compact" sources-visibility="hidden" @resume="selection.retry()"><template #metadata><p :title="selection.downloadJob.value.repository" data-testid="preparation-model-name" tw-class="min-w-0 max-w-full truncate text-[10px] text-gray-500 dark:text-gray-400">{{ downloadModelName }}</p></template></LlamaCppBrowserDownloadJob>
        <div v-else-if="selection.operation.value" tw-class="space-y-1">
          <p v-if="operationFailed" role="alert" tw-class="text-xs text-red-600 dark:text-red-400">{{ operationError }}</p>
          <p v-else role="status" tw-class="text-xs text-gray-500 dark:text-gray-400">{{ lazyStrings.BrowserModelPreparation__checking_model() }}</p>
          <button v-if="operationFailed" type="button" :disabled="disabled" data-testid="chat-model-prepare-retry" tw-class="rounded-md px-2 py-1 text-xs font-medium text-gray-600 hover:bg-gray-100 focus-visible:outline-2 focus-visible:outline-blue-500 dark:text-gray-300 dark:hover:bg-gray-800" @click="selection.retry()">{{ lazyStrings.LlamaCppBrowserModelLaunch__retry() }}</button>
        </div>
        <button type="button" :disabled="disabled" data-testid="chat-model-prepare-choose" tw-class="inline-flex min-h-8 items-center gap-1.5 rounded-md text-[11px] text-gray-500 transition-colors hover:text-gray-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500 dark:text-gray-400 dark:hover:text-gray-100 disabled:opacity-50" @click="emit('choose-again')"><ArrowLeftIcon aria-hidden="true" tw-class="h-3 w-3" />{{ lazyStrings.BrowserModelPreparation__back_to_model_selection() }}</button>
      </div>
      <button type="button" :disabled="disabled" data-testid="chat-model-prepare-cancel" :aria-label="lazyStrings.SHARED__cancel()" :title="lazyStrings.SHARED__cancel()" tw-class="-mr-1 -mt-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600 focus-visible:outline-2 focus-visible:outline-blue-500 dark:hover:bg-gray-800 dark:hover:text-gray-200 disabled:opacity-50" @click="emit('cancel')"><XIcon aria-hidden="true" tw-class="h-3.5 w-3.5" /></button>
    </div>
  </section>
</template>

<style scoped>
.chat-model-preparation {
  animation: chat-model-preparation-appear 360ms cubic-bezier(0.22, 1, 0.36, 1) both;
}
@keyframes chat-model-preparation-appear {
  from {
    opacity: 0;
    transform: translateY(8px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}
@media (prefers-reduced-motion: reduce) {
  .chat-model-preparation {
    animation: none;
  }
}
</style>
