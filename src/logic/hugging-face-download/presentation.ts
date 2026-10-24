import type { DownloadDestination, DownloadFile } from '@/01-models/download';
import type { HuggingFaceSource } from './source';

export function downloadFilesForDisplay({ files, destination, rootName }: {
  files: readonly (HuggingFaceSource & { size?: number })[], destination: DownloadDestination, rootName: string | undefined,
}): DownloadFile[] {
  function path({ file }: { file: HuggingFaceSource }): string {
    switch (destination.kind) {
    case 'opfs': return `models/huggingface.co/${file.repository}/resolve/main/${file.path}`;
    case 'host': return `${rootName ?? `host:${destination.directoryId}`}/${file.repository}/${file.path}`;
    default: {
      const exhaustive: never = destination;
      throw new Error(String(exhaustive));
    }
    }
  }
  return files.map(file => ({
    name: file.path,
    url: `https://huggingface.co/${file.repository}/resolve/${file.revision}/${file.path.split('/').map(encodeURIComponent).join('/')}`,
    destination: path({ file }),
    size: file.size,
    completed: 0,
    state: 'queued',
  }));
}

export const TEST_ONLY = {
};
