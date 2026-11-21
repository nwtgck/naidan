<script setup lang="ts">
import { computed } from 'vue';
import ModelSelectorDownloadAction from './ModelSelectorDownloadAction.vue';
import { describeModelSelectorDownload } from './model-selector-download-presentation';
import type { DownloadDestination } from '@/01-models/download';
import type { RepositoryModelDownloadRequest } from '@/features/llama-cpp-browser/hugging-face/repository-row-download';
import { findModelDownloadJob, getDownloadQueue } from '@/features/llama-cpp-browser/hugging-face/download-queue';

const props = defineProps<{ request: RepositoryModelDownloadRequest | undefined, label: string, disabled: boolean, destinationLabel?: ({ destination }: { destination: DownloadDestination }) => string, refreshInventory?: () => Promise<void> }>();
const queue = getDownloadQueue();
const job = computed(() => {
  if (props.request === undefined) {
    return undefined;
  }
  const { key, prepared, destination } = props.request;
  return findModelDownloadJob({ jobs: queue.jobs.value, key, destination, selection: prepared });
});
const display = computed(() => job.value === undefined ? undefined : describeModelSelectorDownload({ status: job.value.status, progress: job.value.progress }));
const active = computed(() => display.value?.active === true);

function download(): void {
  if (props.request === undefined || props.disabled || active.value) {
    return;
  }
  const { key, repository, source, prepare, destination } = props.request;
  const job = queue.enqueue({ key, repository, source, prepare, destination });
  const refreshInventory = props.refreshInventory;
  if (refreshInventory !== undefined) {
    void job.done.then(result => {
      switch (result.status) {
      case 'complete': return refreshInventory();
      case 'queued': case 'resolving': case 'downloading': case 'pausing':
      case 'paused': case 'failed': case 'cancelled': return undefined;
      default: throw new Error(String(result.status satisfies never));
      }
    }).catch(() => {});
  }
}

function stop(): void {
  if (job.value !== undefined) {
    queue.cancel({ id: job.value.id });
  }
}


defineExpose({
  ...((__BUILD_MODE_IS_TEST__ && {
    TEST_ONLY: {
      // Export internal state and logic used only for testing here. Do not reference these in production logic.
      // ESLint-required for defineExpose.
    },
  }) || {}),
});
</script>

<template>
  <ModelSelectorDownloadAction v-if="request" :label="label" :destination-label="destinationLabel?.({ destination: request.destination })" :state="active ? 'active' : job?.status === 'complete' ? 'complete' : 'available'" :active-label="display?.label" :percent="display?.percent" :action="job?.status === 'paused' ? 'resume' : job?.status === 'failed' ? 'retry' : undefined" :disabled="disabled" @download="download" @stop="stop" />
</template>
