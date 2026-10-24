import type { DownloadFile } from '@/01-models/download';

export function downloadTotals({ files }: { files: readonly DownloadFile[] }): { completed: number, size: number | undefined, percent: number | undefined } {
  const completed = files.reduce((sum, file) => sum + file.completed, 0);
  const size = files.length && files.every(file => file.size !== undefined) ? files.reduce((sum, file) => sum + file.size!, 0) : undefined;
  return { completed, size, percent: size !== undefined && size > 0 ? Math.min(100, Math.floor(completed / size * 100)) : undefined };
}

export function downloadByteLabel({ bytes }: { bytes: number }): string {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  const index = bytes > 0 ? Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024))) : 0;
  return `${(bytes / 1024 ** index).toFixed(index ? 1 : 0)} ${units[index]}`;
}

export const TEST_ONLY = {
};
