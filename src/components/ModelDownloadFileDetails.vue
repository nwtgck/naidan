<script setup lang="ts">
import type { ManagedDownload, DownloadFile } from '@/01-models/download';
import { downloadTotals, downloadByteLabel } from '@/logic/download-manager/progress';
import { lazyStrings } from '@/strings';

defineProps<{ job: ManagedDownload }>();

function fileLabel({ file, job }: { file: DownloadFile, job: ManagedDownload }): string | undefined {
  if (file.state !== 'complete' && ['pausing', 'paused', 'failed', 'cancelling'].includes(job.status)) {
    switch (job.status) {
    case 'pausing': return lazyStrings.ModelDownloads__pausing();
    case 'paused': return lazyStrings.ModelDownloads__paused();
    case 'failed': return lazyStrings.ModelDownloads__failed();
    case 'cancelling': return lazyStrings.ModelDownloads__cancelling();
    default: break;
    }
  }
  switch (file.state) {
  case 'queued': return lazyStrings.ModelDownloads__waiting();
  case 'checking': return lazyStrings.ModelDownloads__checking();
  case 'transferring': return lazyStrings.ModelDownloads__downloading();
  case 'verifying': return lazyStrings.ModelDownloads__verifying();
  case 'complete': return lazyStrings.ModelDownloads__complete();
  default: {
    const exhaustive: never = file.state;
    throw new Error(String(exhaustive));
  }
  }
}

function fileAmount({ file }: { file: DownloadFile }): string | undefined {
  const known = file.size === undefined ? lazyStrings.ModelDownloads__unknown_size() : downloadByteLabel({ bytes: file.size });
  return known === undefined ? undefined : `${downloadByteLabel({ bytes: file.completed })} / ${known}`;
}

defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>

<template>
  <div role="region" :aria-label="lazyStrings.ModelDownloads__file_details()" data-testid="model-downloads-details" tw-class="min-w-0 border-t border-gray-100 bg-gray-50/60 dark:border-gray-800 dark:bg-gray-950/30">
    <ol tw-class="divide-y divide-gray-100 dark:divide-gray-800/80">
      <li v-for="(file, index) in job.files" :key="`${index}:${file.url}:${file.destination}`" tw-class="px-3 py-3">
        <div tw-class="flex items-start gap-2">
          <span tw-class="flex h-5 w-5 shrink-0 items-center justify-center rounded bg-gray-200/60 text-[10px] tabular-nums text-gray-500 dark:bg-gray-800 dark:text-gray-400">{{ index + 1 }}</span>
          <p :title="file.name" tw-class="min-w-0 flex-1 break-all font-mono text-[11px] leading-5">{{ file.name }}</p>
        </div>
        <div tw-class="mt-2 flex items-center justify-between gap-2 text-[10px] leading-4 text-gray-500 dark:text-gray-400"><span>{{ fileLabel({ file, job }) }}</span><span tw-class="tabular-nums">{{ downloadTotals({ files: [file] }).percent === undefined ? '—' : `${downloadTotals({ files: [file] }).percent}%` }}</span></div>
        <div role="progressbar" :aria-label="file.name" :aria-valuenow="downloadTotals({ files: [file] }).percent" :aria-valuemin="0" :aria-valuemax="100" tw-class="mt-1.5 h-1 overflow-hidden rounded-full bg-gray-200/70 dark:bg-gray-800"><div :style="{ width: downloadTotals({ files: [file] }).percent === undefined ? '30%' : `${downloadTotals({ files: [file] }).percent}%` }" tw-class="h-full rounded-full bg-blue-500/80 dark:bg-blue-400/80" /></div>
        <p tw-class="mt-1.5 text-[10px] tabular-nums leading-4 text-gray-400 dark:text-gray-500">{{ fileAmount({ file }) }}</p>
        <dl tw-class="mt-3 space-y-2.5">
          <div><dt tw-class="text-[10px] text-gray-400 dark:text-gray-500">{{ lazyStrings.ModelDownloads__download_url() }}</dt><dd tw-class="mt-1 select-text break-all font-mono text-[10px] leading-4 text-gray-600 dark:text-gray-400">{{ file.url }}</dd></div>
          <div><dt tw-class="text-[10px] text-gray-400 dark:text-gray-500">{{ lazyStrings.ModelDownloads__destination() }}</dt><dd tw-class="mt-1 select-text break-all font-mono text-[10px] leading-4 text-gray-600 dark:text-gray-400">{{ file.destination }}</dd></div>
        </dl>
      </li>
    </ol>
  </div>
</template>
