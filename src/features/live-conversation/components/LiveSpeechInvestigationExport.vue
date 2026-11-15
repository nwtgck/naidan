<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { DownloadIcon, Loader2Icon, Trash2Icon, XIcon } from 'lucide-vue-next';
import SettingsChoiceControl from '@/components/SettingsChoiceControl.vue';
import type { SpeechInvestigationExportOptions } from '@/features/speech-cpp-browser/investigation/types';
import { lazyStrings } from '@/strings';

const props = defineProps<{ captureId: string | undefined, saving: boolean, failure: string | undefined }>();
const emit = defineEmits<{ download: [options: SpeechInvestigationExportOptions], clear: [], cancel: [] }>();
const includeInputAudio = ref<SpeechInvestigationExportOptions['includeInputAudio']>('off');
const includeInputText = ref<SpeechInvestigationExportOptions['includeInputText']>('off');
const blocked = computed(() => props.captureId === undefined || props.saving);

watch(() => props.captureId, () => {
  includeInputAudio.value = 'off';
  includeInputText.value = 'off';
}, { flush: 'sync' });

function download(): void {
  if (!blocked.value) {
    emit('download', { includeInputAudio: includeInputAudio.value, includeInputText: includeInputText.value });
  }
}

function clear(): void {
  if (!blocked.value) {
    emit('clear');
  }
}

function cancel(): void {
  if (props.saving) {
    emit('cancel');
  }
}

defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>

<template>
  <section :aria-busy="saving" tw-class="space-y-4 rounded-xl border border-gray-200/70 p-4 dark:border-gray-800" data-testid="live-investigation-export">
    <div tw-class="space-y-1.5">
      <h3 tw-class="text-xs font-medium text-gray-700 dark:text-gray-200">{{ lazyStrings.liveConversation__investigation_record() }}</h3>
      <p tw-class="text-xs leading-6 text-gray-500 dark:text-gray-400" data-testid="live-investigation-export-contents">{{ lazyStrings.liveConversation__investigation_zip_contents() }}</p>
    </div>
    <div tw-class="space-y-3">
      <label tw-class="flex items-center gap-3 text-xs text-gray-600 dark:text-gray-300">
        <SettingsChoiceControl presentation="checkbox"><input v-model="includeInputAudio" type="checkbox" true-value="on" false-value="off" :disabled="blocked" data-testid="live-investigation-include-input-audio" /></SettingsChoiceControl>
        <span>{{ lazyStrings.liveConversation__include_input_audio() }}</span>
      </label>
      <label tw-class="flex items-center gap-3 text-xs text-gray-600 dark:text-gray-300">
        <SettingsChoiceControl presentation="checkbox"><input v-model="includeInputText" type="checkbox" true-value="on" false-value="off" :disabled="blocked" data-testid="live-investigation-include-input-text" /></SettingsChoiceControl>
        <span>{{ lazyStrings.liveConversation__include_instruction_text() }}</span>
      </label>
    </div>
    <p v-if="captureId === undefined" role="status" tw-class="text-xs leading-6 text-gray-500 dark:text-gray-400" data-testid="live-investigation-export-empty">{{ lazyStrings.liveConversation__investigation_record_after_run() }}</p>
    <div tw-class="flex flex-wrap items-center gap-3">
      <button type="button" :disabled="blocked" @click="download" tw-class="inline-flex min-h-10 items-center gap-2 rounded-xl bg-blue-600 px-4 py-2.5 text-xs font-medium text-white shadow-sm shadow-blue-500/20 hover:bg-blue-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:cursor-not-allowed disabled:bg-gray-200 disabled:text-gray-400 disabled:shadow-none dark:disabled:bg-gray-700 dark:disabled:text-gray-500" data-testid="live-investigation-save"><Loader2Icon v-if="saving" aria-hidden="true" tw-class="h-4 w-4 animate-spin motion-reduce:animate-none" /><DownloadIcon v-else aria-hidden="true" tw-class="h-4 w-4" />{{ saving ? lazyStrings.liveConversation__creating_investigation_zip() : lazyStrings.liveConversation__save_investigation_zip() }}</button>
      <button v-if="saving" type="button" @click="cancel" tw-class="inline-flex min-h-10 items-center gap-2 rounded-xl border border-gray-200 px-4 py-2.5 text-xs font-medium text-gray-700 hover:bg-gray-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:border-gray-700 dark:text-gray-200 dark:hover:bg-gray-800" data-testid="live-investigation-export-cancel"><XIcon aria-hidden="true" tw-class="h-4 w-4" />{{ lazyStrings.SHARED__cancel() }}</button>
      <button type="button" :disabled="blocked" @click="clear" tw-class="inline-flex min-h-10 items-center gap-2 rounded-xl px-3 py-2.5 text-xs font-medium text-gray-500 hover:bg-gray-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:cursor-not-allowed disabled:opacity-40 dark:text-gray-400 dark:hover:bg-gray-800" data-testid="live-investigation-clear"><Trash2Icon aria-hidden="true" tw-class="h-4 w-4" />{{ lazyStrings.liveConversation__clear_investigation_record() }}</button>
    </div>
    <p v-if="failure" role="alert" tw-class="max-h-48 overflow-y-auto whitespace-pre-wrap break-words text-xs leading-6 text-red-600 dark:text-red-400" data-testid="live-investigation-export-failure">{{ failure }}</p>
  </section>
</template>
