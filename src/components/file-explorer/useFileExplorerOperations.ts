import { ref } from 'vue';
import type { FileExplorerEntry } from './types';
import { copyDirectoryHandle, copyFileHandle } from './utils';
import { useConfirm } from '@/composables/useConfirm';
import { useToast } from '@/composables/useToast';

export function useFileExplorerOperations({
  currentHandle,
  refresh,
}: {
  currentHandle: { readonly value: FileSystemDirectoryHandle };
  refresh: () => Promise<void>;
}) {
  const { showConfirm } = useConfirm();
  const { addToast } = useToast();
  const renamingEntryName = ref<string | undefined>(undefined);

  async function createFile({ name }: { name: string }): Promise<void> {
    try {
      const fh = await currentHandle.value.getFileHandle(name, { create: true });
      const writable = await (fh as unknown as { createWritable(): Promise<FileSystemWritableFileStream> }).createWritable();
      await writable.close();
      await refresh();
    } catch (e) {
      addToast({ message: `Failed to create file: ${e instanceof Error ? e.message : String(e)}` });
    }
  }

  async function createFolder({ name }: { name: string }): Promise<void> {
    try {
      await currentHandle.value.getDirectoryHandle(name, { create: true });
      await refresh();
    } catch (e) {
      addToast({ message: `Failed to create folder: ${e instanceof Error ? e.message : String(e)}` });
    }
  }

  async function deleteEntries({ entries }: { entries: FileExplorerEntry[] }): Promise<void> {
    if (entries.length === 0) return;

    const isSingle = entries.length === 1;
    const label = isSingle ? `"${entries[0]!.name}"` : `${entries.length} items`;
    let singleKindLabel = 'Items';
    if (isSingle) {
      switch (entries[0]!.kind) {
      case 'directory': singleKindLabel = 'Folder'; break;
      case 'file': singleKindLabel = 'File'; break;
      default: {
        const _ex: never = entries[0]!.kind;
        throw new Error(`Unhandled kind: ${_ex}`);
      }
      }
    }
    const confirmed = await showConfirm({
      title: `Delete ${isSingle ? singleKindLabel : 'Items'}`,
      message: `Are you sure you want to permanently delete ${label}? This cannot be undone.`,
      confirmButtonText: 'Delete',
      confirmButtonVariant: 'danger',
    });
    if (!confirmed) return;

    let failed = 0;
    for (const entry of entries) {
      try {
        await currentHandle.value.removeEntry(entry.name, { recursive: true });
      } catch {
        failed++;
      }
    }

    if (failed > 0) {
      addToast({ message: `Failed to delete ${failed} item${failed > 1 ? 's' : ''}.` });
    }
    await refresh();
  }

  async function renameEntry({
    entry,
    newName,
  }: {
    entry: FileExplorerEntry;
    newName: string;
  }): Promise<void> {
    const trimmed = newName.trim();
    if (!trimmed || trimmed === entry.name) {
      renamingEntryName.value = undefined;
      return;
    }
    try {
      switch (entry.kind) {
      case 'file': {
        const fh = entry.handle as FileSystemFileHandle;
        const file = await fh.getFile();
        const destFh = await currentHandle.value.getFileHandle(trimmed, { create: true });
        const writable = await (destFh as unknown as { createWritable(): Promise<FileSystemWritableFileStream> }).createWritable();
        await writable.write(await file.arrayBuffer());
        await writable.close();
        await currentHandle.value.removeEntry(entry.name);
        break;
      }
      case 'directory': {
        // Copy tree into new-named dir, then remove original
        const destDir = await currentHandle.value.getDirectoryHandle(trimmed, { create: true });
        const srcDir = entry.handle as FileSystemDirectoryHandle;
        for await (const child of srcDir.values()) {
          switch (child.kind) {
          case 'file': {
            const file = await (child as FileSystemFileHandle).getFile();
            const destFh = await destDir.getFileHandle(child.name, { create: true });
            const writable = await (destFh as unknown as { createWritable(): Promise<FileSystemWritableFileStream> }).createWritable();
            await writable.write(await file.arrayBuffer());
            await writable.close();
            break;
          }
          case 'directory':
            await copyDirectoryHandle({
              source: child as FileSystemDirectoryHandle,
              targetDir: destDir,
              signal: undefined,
            });
            break;
          default: {
            const _ex: never = child.kind;
            throw new Error(`Unhandled kind: ${_ex}`);
          }
          }
        }
        await currentHandle.value.removeEntry(entry.name, { recursive: true });
        break;
      }
      default: {
        const _ex: never = entry.kind;
        throw new Error(`Unhandled kind: ${_ex}`);
      }
      }
      renamingEntryName.value = undefined;
      await refresh();
    } catch (e) {
      addToast({ message: `Failed to rename: ${e instanceof Error ? e.message : String(e)}` });
      renamingEntryName.value = undefined;
    }
  }

  async function moveEntries({
    entries,
    targetDir,
  }: {
    entries: FileExplorerEntry[];
    targetDir: FileSystemDirectoryHandle;
  }): Promise<void> {
    let failed = 0;
    for (const entry of entries) {
      try {
        switch (entry.kind) {
        case 'file':
          await copyFileHandle({ source: entry.handle as FileSystemFileHandle, targetDir });
          await currentHandle.value.removeEntry(entry.name);
          break;
        case 'directory':
          await copyDirectoryHandle({ source: entry.handle as FileSystemDirectoryHandle, targetDir, signal: undefined });
          await currentHandle.value.removeEntry(entry.name, { recursive: true });
          break;
        default: {
          const _ex: never = entry.kind;
          throw new Error(`Unhandled kind: ${_ex}`);
        }
        }
      } catch {
        failed++;
      }
    }
    if (failed > 0) {
      addToast({ message: `Failed to move ${failed} item${failed > 1 ? 's' : ''}.` });
    }
    await refresh();
  }

  async function copyEntriesToDir({
    entries,
    targetDir,
  }: {
    entries: FileExplorerEntry[];
    targetDir: FileSystemDirectoryHandle;
  }): Promise<void> {
    let failed = 0;
    for (const entry of entries) {
      try {
        switch (entry.kind) {
        case 'file':
          await copyFileHandle({ source: entry.handle as FileSystemFileHandle, targetDir });
          break;
        case 'directory':
          await copyDirectoryHandle({ source: entry.handle as FileSystemDirectoryHandle, targetDir, signal: undefined });
          break;
        default: {
          const _ex: never = entry.kind;
          throw new Error(`Unhandled kind: ${_ex}`);
        }
        }
      } catch {
        failed++;
      }
    }
    if (failed > 0) {
      addToast({ message: `Failed to copy ${failed} item${failed > 1 ? 's' : ''}.` });
    }
    await refresh();
  }

  async function downloadEntry({ entry }: { entry: FileExplorerEntry }): Promise<void> {
    switch (entry.kind) {
    case 'directory':
      return;
    case 'file':
      break;
    default: {
      const _ex: never = entry.kind;
      throw new Error(`Unhandled kind: ${_ex}`);
    }
    }
    try {
      const file = await (entry.handle as FileSystemFileHandle).getFile();
      const url = URL.createObjectURL(file);
      const a = document.createElement('a');
      a.href = url;
      a.download = entry.name;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      addToast({ message: `Failed to download: ${e instanceof Error ? e.message : String(e)}` });
    }
  }

  function startRename({ entry }: { entry: FileExplorerEntry }): void {
    renamingEntryName.value = entry.name;
  }

  function cancelRename(): void {
    renamingEntryName.value = undefined;
  }

  return {
    renamingEntryName,
    createFile,
    createFolder,
    deleteEntries,
    renameEntry,
    moveEntries,
    copyEntriesToDir,
    downloadEntry,
    startRename,
    cancelRename,
    __testOnly: {
      // Export internal state and logic used only for testing here. Do not reference these in production logic.
    },
  };
}
