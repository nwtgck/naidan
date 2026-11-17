<script setup lang="ts">
import { onScopeDispose, ref } from 'vue';
import { ChevronDownIcon, ExternalLinkIcon, InfoIcon, Loader2Icon } from 'lucide-vue-next';
import type { useAudioTranscriptionModels } from '@/features/audio-transcription/composables/useAudioTranscriptionModels';
import { formatDownloadBytes } from '@/features/llama-cpp-browser/hugging-face/presentation';
import { lazyStrings } from '@/strings';

const props = defineProps<{ models: ReturnType<typeof useAudioTranscriptionModels> }>();
const { selectedDetails, quantizations, selectedQuantizationId, selectedQuantizationLabel, quantizationsBusy, quantizationsFailure, canInspectQuantizations } = props.models;
const controller = ref<AbortController>();

async function inspect(): Promise<void> {
  controller.value?.abort();
  const request = new AbortController();
  controller.value = request;
  try {
    await props.models.inspectSelectedQuantizations({ signal: request.signal });
  } finally {
    if (controller.value === request) {
      controller.value = undefined;
    }
  }
}

function chooseQuantization({ event }: { event: Event }): void {
  if (event.target instanceof HTMLSelectElement) {
    props.models.selectQuantization({ id: event.target.value });
  }
}

onScopeDispose(() => controller.value?.abort());
defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>

<template>
  <div tw-class="space-y-2">
    <div tw-class="flex flex-wrap items-center justify-between gap-2">
      <label v-if="quantizations.length" tw-class="flex min-w-0 flex-1 items-center gap-2 text-[11px] text-gray-500 dark:text-gray-400"><span tw-class="shrink-0">{{ lazyStrings.AudioTranscriptionModelDetails__quantization() }}</span><select :value="selectedQuantizationId ?? ''" :disabled="models.busy.value" data-testid="audio-transcription-quantization" @change="chooseQuantization({ event: $event })" tw-class="min-h-8 min-w-0 flex-1 rounded-lg border border-gray-200 bg-white px-2 text-xs text-gray-700 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-200"><option v-if="selectedQuantizationId === undefined" value="" disabled>{{ lazyStrings.AudioTranscriptionModelDetails__quantization() }}</option><option v-for="choice in quantizations" :key="choice.id" :value="choice.id">{{ choice.label }} · {{ formatDownloadBytes({ bytes: choice.bytes }) }}</option></select></label>
      <span v-else tw-class="text-[11px] text-gray-400">{{ selectedQuantizationLabel || lazyStrings.AudioTranscriptionModelDetails__quantization() }}</span>
      <button v-if="canInspectQuantizations && quantizations.length === 0" type="button" :disabled="quantizationsBusy" @click="inspect" data-testid="audio-transcription-check-model-details" tw-class="flex min-h-8 items-center gap-1.5 rounded-lg px-2 text-[11px] text-gray-500 hover:bg-gray-100 focus-visible:outline-2 focus-visible:outline-blue-500 disabled:cursor-wait dark:text-gray-400 dark:hover:bg-gray-700"><Loader2Icon v-if="quantizationsBusy" aria-hidden="true" tw-class="h-3 w-3 animate-spin" /><ExternalLinkIcon v-else aria-hidden="true" tw-class="h-3 w-3" />{{ lazyStrings.AudioTranscriptionModelDetails__check_on_hugging_face() }}</button>
    </div>
    <p v-if="quantizationsFailure" role="alert" tw-class="text-xs text-red-600 dark:text-red-400">{{ lazyStrings.AudioTranscriptionModelDetails__could_not_check() }}</p>
    <details v-if="selectedDetails" tw-class="group">
      <summary tw-class="flex min-h-7 cursor-pointer list-none items-center gap-1.5 rounded text-[11px] text-gray-400 focus-visible:outline-2 focus-visible:outline-blue-500 dark:text-gray-500 [&::-webkit-details-marker]:hidden"><InfoIcon aria-hidden="true" tw-class="h-3 w-3" />{{ lazyStrings.AudioTranscriptionModelDetails__details() }}<ChevronDownIcon aria-hidden="true" tw-class="h-3 w-3 transition-transform group-open:rotate-180 motion-reduce:transition-none" /></summary>
      <div tw-class="space-y-3 py-2 text-xs leading-5 text-gray-600 dark:text-gray-300">
        <template v-if="selectedDetails.kind === 'huggingface'">
          <div><p tw-class="mb-1 text-[10px] text-gray-400">{{ lazyStrings.AudioTranscriptionModelDetails__repository() }}</p><a :href="selectedDetails.repositoryUrl" target="_blank" rel="noopener noreferrer" tw-class="break-all rounded hover:text-blue-600 focus-visible:outline-2 focus-visible:outline-blue-500 dark:hover:text-blue-400">{{ selectedDetails.repository }} <ExternalLinkIcon aria-hidden="true" tw-class="inline h-3 w-3" /></a></div>
          <div v-if="selectedDetails.revision"><p tw-class="mb-1 text-[10px] text-gray-400">{{ lazyStrings.AudioTranscriptionModelDetails__revision() }}</p><code tw-class="break-all text-[11px]">{{ selectedDetails.revision }}</code></div>
          <div v-if="selectedDetails.files"><p tw-class="mb-1 text-[10px] text-gray-400">{{ lazyStrings.AudioTranscriptionModelDetails__download_files() }}</p><ul tw-class="space-y-2"><li v-for="file in selectedDetails.files" :key="file.url"><p tw-class="break-all">{{ file.name }} <span tw-class="text-gray-400">· {{ formatDownloadBytes({ bytes: file.bytes }) }}</span></p><a :href="file.url" target="_blank" rel="noopener noreferrer" tw-class="block break-all rounded font-mono text-[10px] text-gray-400 hover:text-blue-600 focus-visible:outline-2 focus-visible:outline-blue-500 dark:hover:text-blue-400">{{ file.url }}</a></li></ul></div>
          <p v-else tw-class="text-[11px] text-gray-400">{{ lazyStrings.AudioTranscriptionModelDetails__download_targets_not_checked() }}</p>
        </template>
        <template v-else><p tw-class="text-[10px] text-gray-400">{{ lazyStrings.AudioTranscriptionModelDetails__local_file() }}</p><p tw-class="break-all">{{ selectedDetails.fileName || selectedDetails.name }} · {{ formatDownloadBytes({ bytes: selectedDetails.bytes }) }}</p></template>
      </div>
    </details>
  </div>
</template>
