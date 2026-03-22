import type { FileExplorerEntry, MimeCategory, SortConfig } from './types';
import { EXTENSION_MIME_MAP } from './constants';

export function getFileExtension({ name }: { name: string }): string {
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return '';
  return name.slice(dot).toLowerCase();
}

export function getMimeCategory({ extension }: { extension: string }): MimeCategory {
  return EXTENSION_MIME_MAP[extension] ?? 'binary';
}

export function formatSize({ bytes }: { bytes: number | undefined }): string {
  if (bytes === undefined) return '—';
  if (bytes === 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function formatDate({ timestamp }: { timestamp: number | undefined }): string {
  if (timestamp === undefined) return '—';
  return new Date(timestamp).toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function sortEntries({
  entries,
  config,
}: {
  entries: FileExplorerEntry[];
  config: SortConfig;
}): FileExplorerEntry[] {
  return [...entries].sort((a, b) => {
    // Directories always come first
    if (a.kind !== b.kind) {
      switch (a.kind) {
      case 'directory': return -1;
      case 'file': return 1;
      default: {
        const _ex: never = a.kind;
        void _ex;
        return 0;
      }
      }
    }

    let cmp = 0;
    switch (config.field) {
    case 'name':
      cmp = a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
      break;
    case 'size':
      cmp = (a.size ?? -1) - (b.size ?? -1);
      break;
    case 'dateModified':
      cmp = (a.lastModified ?? 0) - (b.lastModified ?? 0);
      break;
    case 'type':
      cmp = a.extension.localeCompare(b.extension);
      if (cmp === 0) cmp = a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
      break;
    default: {
      const _ex: never = config.field;
      throw new Error(`Unhandled sort field: ${_ex}`);
    }
    }

    switch (config.direction) {
    case 'ascending': return cmp;
    case 'descending': return -cmp;
    default: {
      const _ex: never = config.direction;
      throw new Error(`Unhandled direction: ${_ex}`);
    }
    }
  });
}

export function filterEntries({
  entries,
  query,
}: {
  entries: FileExplorerEntry[];
  query: string;
}): FileExplorerEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return entries;
  return entries.filter(e => e.name.toLowerCase().includes(q));
}

/**
 * Recursively copy a FileSystemDirectoryHandle tree into a target directory.
 */
export async function copyDirectoryHandle({
  source,
  targetDir,
  signal,
}: {
  source: FileSystemDirectoryHandle;
  targetDir: FileSystemDirectoryHandle;
  signal: AbortSignal | undefined;
}): Promise<void> {
  const destDir = await targetDir.getDirectoryHandle(source.name, { create: true });
  for await (const entry of source.values()) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    switch (entry.kind) {
    case 'file': {
      const fh = entry as FileSystemFileHandle;
      const file = await fh.getFile();
      const destFh = await destDir.getFileHandle(entry.name, { create: true });
      const writable = await (destFh as unknown as { createWritable(): Promise<FileSystemWritableFileStream> }).createWritable();
      await writable.write(await file.arrayBuffer());
      await writable.close();
      break;
    }
    case 'directory':
      await copyDirectoryHandle({ source: entry as FileSystemDirectoryHandle, targetDir: destDir, signal });
      break;
    default: {
      const _ex: never = entry.kind;
      throw new Error(`Unhandled kind: ${_ex}`);
    }
    }
  }
}

/**
 * Copy a single FileSystemFileHandle into a target directory.
 */
export async function copyFileHandle({
  source,
  targetDir,
}: {
  source: FileSystemFileHandle;
  targetDir: FileSystemDirectoryHandle;
}): Promise<void> {
  const file = await source.getFile();
  const destFh = await targetDir.getFileHandle(source.name, { create: true });
  const writable = await (destFh as unknown as { createWritable(): Promise<FileSystemWritableFileStream> }).createWritable();
  await writable.write(await file.arrayBuffer());
  await writable.close();
}
