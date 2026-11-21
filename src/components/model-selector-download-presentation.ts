import { lazyStrings } from '@/strings';
import type { DownloadJob } from '@/features/llama-cpp-browser/hugging-face/download-queue';

export type ModelSelectorDownloadPresentation = { label: string | undefined, active: boolean, percent: number | undefined };

export function describeModelSelectorDownload({ status, progress }: { status: DownloadJob['status'], progress: DownloadJob['progress'] }): ModelSelectorDownloadPresentation | undefined {
  const phase = progress?.phase;
  const percent = progress === undefined || progress.total <= 0 ? undefined : Math.min(100, Math.floor(100 * progress.completed / progress.total));
  switch (status) {
  case 'queued': return { label: lazyStrings.ModelSelectorDownloadAction__queued(), active: true, percent: undefined };
  case 'resolving': return { label: lazyStrings.ModelSelectorDownloadAction__preparing(), active: true, percent: undefined };
  case 'downloading':
    switch (phase) {
    case 'verifying': return { label: lazyStrings.ModelSelectorDownloadAction__verifying(), active: true, percent };
    case 'transferring': case undefined: return { label: lazyStrings.ModelSelectorDownloadAction__downloading(), active: true, percent };
    default: throw new Error(String(phase satisfies never));
    }
  case 'pausing': return { label: lazyStrings.ModelSelectorDownloadAction__stopping(), active: true, percent };
  case 'paused': return { label: lazyStrings.ModelSelectorDownloadAction__paused(), active: false, percent };
  case 'complete': return { label: lazyStrings.ModelSelectorDownloadAction__downloaded(), active: false, percent: undefined };
  case 'failed': return { label: lazyStrings.ModelSelectorDownloadAction__failed(), active: false, percent: undefined };
  case 'cancelled': return undefined;
  default: {
    const exhaustive: never = status;
    throw new Error(String(exhaustive));
  }
  }
}

export const TEST_ONLY = {
};
