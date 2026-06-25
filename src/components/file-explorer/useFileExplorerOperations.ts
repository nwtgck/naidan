import { ref } from 'vue';
import type { FileExplorerWorkerClient } from '@/services/file-explorer/worker/types';
import type { FileExplorerEntry } from './types';
import { useConfirm } from '@/composables/useConfirm';
import { useToast } from '@/composables/useToast';

export function useFileExplorerOperations({
  client,
  currentDirectoryPath,
  refresh,
}: {
  client: FileExplorerWorkerClient,
  currentDirectoryPath: { readonly value: string },
  refresh: () => Promise<void>,
}) {
  const { showConfirm } = useConfirm();
  const { addToast } = useToast();
  const renamingEntryName = ref<string | undefined>(undefined);

  async function createFile({ name }: { name: string }): Promise<void> {
    try {
      await client.createFile({ parentPath: currentDirectoryPath.value, name });
      await refresh();
    } catch (error) {
      addToast({ message: `Failed to create file: ${error instanceof Error ? error.message : String(error)}` });
    }
  }

  async function createFolder({ name }: { name: string }): Promise<void> {
    try {
      await client.createFolder({ parentPath: currentDirectoryPath.value, name });
      await refresh();
    } catch (error) {
      addToast({ message: `Failed to create folder: ${error instanceof Error ? error.message : String(error)}` });
    }
  }

  async function deleteEntries({ entries }: { entries: FileExplorerEntry[] }): Promise<void> {
    if (entries.length === 0) return;

    const isSingle = entries.length === 1;
    const label = isSingle ? `"${entries[0]!.name}"` : `${entries.length} items`;
    let singleKindLabel = 'Items';
    if (isSingle) {
      switch (entries[0]!.kind) {
      case 'directory':
        singleKindLabel = 'Folder';
        break;
      case 'file':
        singleKindLabel = 'File';
        break;
      default: {
        const _exhaustiveCheck: never = entries[0]!.kind;
        throw new Error(`Unhandled kind: ${_exhaustiveCheck}`);
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

    try {
      await client.deleteEntries({ paths: entries.map(entry => entry.path) });
      await refresh();
    } catch (error) {
      addToast({ message: `Failed to delete: ${error instanceof Error ? error.message : String(error)}` });
    }
  }

  async function renameEntry({
    entry,
    newName,
  }: {
    entry: FileExplorerEntry,
    newName: string,
  }): Promise<void> {
    const trimmed = newName.trim();
    if (!trimmed || trimmed === entry.name) {
      renamingEntryName.value = undefined;
      return;
    }

    try {
      await client.renameEntry({ path: entry.path, newName: trimmed });
      renamingEntryName.value = undefined;
      await refresh();
    } catch (error) {
      addToast({ message: `Failed to rename: ${error instanceof Error ? error.message : String(error)}` });
      renamingEntryName.value = undefined;
    }
  }

  async function moveEntries({
    entries,
    targetPath,
  }: {
    entries: FileExplorerEntry[],
    targetPath: string,
  }): Promise<void> {
    try {
      await client.moveEntries({
        sourcePaths: entries.map(entry => entry.path),
        targetDirectoryPath: targetPath,
      });
      await refresh();
    } catch (error) {
      addToast({ message: `Failed to move items: ${error instanceof Error ? error.message : String(error)}` });
    }
  }

  async function copyEntriesToDir({
    entries,
    targetPath,
  }: {
    entries: FileExplorerEntry[],
    targetPath: string,
  }): Promise<void> {
    try {
      await client.copyEntries({
        sourcePaths: entries.map(entry => entry.path),
        targetDirectoryPath: targetPath,
      });
      await refresh();
    } catch (error) {
      addToast({ message: `Failed to copy items: ${error instanceof Error ? error.message : String(error)}` });
    }
  }

  async function downloadEntry({ entry }: { entry: FileExplorerEntry }): Promise<void> {
    switch (entry.kind) {
    case 'directory':
      return;
    case 'file':
      break;
    default: {
      const _exhaustiveCheck: never = entry.kind;
      throw new Error(`Unhandled kind: ${_exhaustiveCheck}`);
    }
    }

    try {
      const response = await client.readFile({ path: entry.path });
      const url = URL.createObjectURL(response.blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = entry.name;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      addToast({ message: `Failed to download: ${error instanceof Error ? error.message : String(error)}` });
    }
  }

  function startRename({ entry }: { entry: FileExplorerEntry }): void {
    renamingEntryName.value = entry.name;
  }

  function cancelRename(): void {
    renamingEntryName.value = undefined;
  }

  async function uploadFiles({ files }: { files: FileList | File[] }): Promise<void> {
    const fileArray = Array.from(files);
    if (fileArray.length === 0) return;

    try {
      await client.uploadFiles({
        targetDirectoryPath: currentDirectoryPath.value,
        files: fileArray.map(file => ({ name: file.name, blob: file })),
      });
      await refresh();
    } catch (error) {
      addToast({ message: `Failed to upload files: ${error instanceof Error ? error.message : String(error)}` });
    }
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
    uploadFiles,
    startRename,
    cancelRename,
    TEST_ONLY: {
      // Export internal state and logic used only for testing here. Do not reference these in production logic.
    },
  };
}
