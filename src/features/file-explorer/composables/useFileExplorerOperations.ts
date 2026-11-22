import { downloadFile, downloadStream } from '@/utils/stream-download';
import { ensureStrings } from '@/strings';
import { ref } from 'vue';
import type { FileExplorerWorkerClient } from '@/features/file-explorer/worker/types';
import type { FileExplorerEntry } from '@/features/file-explorer/logic/types';
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

  async function createFile({ directoryPath, name, blob }: { directoryPath: string, name: string, blob: Blob }): Promise<boolean> {
    try {
      if (client.fileAccess !== undefined) {
        await client.fileAccess.save({ target: { kind: 'create', directoryPath, name }, blob });
      } else if (blob.size === 0) {
        await client.createFile({ parentPath: directoryPath, name });
      } else {
        throw new Error('File writes with content are unavailable');
      }
      await refresh();
      return true;
    } catch (error) {
      // A failed write may have already reserved an empty destination.
      await refresh().catch(() => undefined);
      addToast({ message: await ensureStrings.fileExplorer__failed_to_create_file({ errorMessage: error instanceof Error ? error.message : String(error) }) });
      return false;
    }
  }

  async function createFolder({ name }: { name: string }): Promise<void> {
    try {
      await client.createFolder({ parentPath: currentDirectoryPath.value, name });
      await refresh();
    } catch (error) {
      addToast({ message: await ensureStrings.fileExplorer__failed_to_create_folder({ errorMessage: error instanceof Error ? error.message : String(error) }) });
    }
  }

  async function deleteEntries({ entries, onSuccess }: { entries: FileExplorerEntry[], onSuccess?: () => Promise<void> }): Promise<void> {
    if (entries.length === 0) {
      return;
    }

    const isSingle = entries.length === 1;
    const label = isSingle
      ? `"${entries[0]!.name}"`
      : await ensureStrings.fileExplorer__item_count_label({ count: entries.length });
    let title: string;
    if (!isSingle) {
      title = await ensureStrings.fileExplorer__delete_items();
    } else {
      switch (entries[0]!.kind) {
      case 'directory':
        title = await ensureStrings.fileExplorer__delete_folder();
        break;
      case 'file':
        title = await ensureStrings.fileExplorer__delete_file();
        break;
      default: {
        const _exhaustiveCheck: never = entries[0]!.kind;
        throw new Error(`Unhandled kind: ${_exhaustiveCheck}`);
      }
      }
    }

    const confirmed = await showConfirm({
      title,
      message: await ensureStrings.fileExplorer__delete_confirmation({ label }),
      confirmButtonText: await ensureStrings.fileExplorer__delete(),
      confirmButtonVariant: 'danger',
    });
    if (!confirmed) {
      return;
    }

    try {
      await client.deleteEntries({ paths: entries.map(entry => entry.path) });
      await (onSuccess ?? refresh)();
    } catch (error) {
      addToast({ message: await ensureStrings.fileExplorer__failed_to_delete({ errorMessage: error instanceof Error ? error.message : String(error) }) });
    }
  }

  async function renameEntry({
    entry,
    newName,
    onSuccess,
  }: {
    entry: FileExplorerEntry,
    newName: string,
    onSuccess?: () => Promise<void>,
  }): Promise<void> {
    const trimmed = newName.trim();
    if (!trimmed || trimmed === entry.name) {
      renamingEntryName.value = undefined;
      return;
    }

    try {
      await client.renameEntry({ path: entry.path, newName: trimmed });
      renamingEntryName.value = undefined;
      await (onSuccess ?? refresh)();
    } catch (error) {
      addToast({ message: await ensureStrings.fileExplorer__failed_to_rename({ errorMessage: error instanceof Error ? error.message : String(error) }) });
      renamingEntryName.value = undefined;
    }
  }

  async function moveEntries({
    entries,
    targetPath,
    onSuccess,
  }: {
    entries: FileExplorerEntry[],
    targetPath: string,
    onSuccess?: () => Promise<void>,
  }): Promise<void> {
    try {
      await client.moveEntries({
        sourcePaths: entries.map(entry => entry.path),
        targetDirectoryPath: targetPath,
      });
      await (onSuccess ?? refresh)();
    } catch (error) {
      addToast({ message: await ensureStrings.fileExplorer__failed_to_move_items({ errorMessage: error instanceof Error ? error.message : String(error) }) });
    }
  }

  async function copyEntriesToDir({
    entries,
    targetPath,
    onSuccess,
  }: {
    entries: FileExplorerEntry[],
    targetPath: string,
    onSuccess?: () => Promise<void>,
  }): Promise<void> {
    try {
      await client.copyEntries({
        sourcePaths: entries.map(entry => entry.path),
        targetDirectoryPath: targetPath,
      });
      await (onSuccess ?? refresh)();
    } catch (error) {
      addToast({ message: await ensureStrings.fileExplorer__failed_to_copy_items({ errorMessage: error instanceof Error ? error.message : String(error) }) });
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

    const abort = new AbortController();
    const onPageHide = () => abort.abort(new DOMException('Download page closed', 'AbortError'));
    window.addEventListener('pagehide', onPageHide, { once: true });
    try {
      const { path, name } = entry;
      const source = await client.prepareFileDownload({ path });
      abort.signal.throwIfAborted();
      switch (source.kind) {
      case 'file':
        await downloadFile({ file: source.blob, filename: name, signal: abort.signal });
        break;
      case 'stream':
        await downloadStream({
          openStream: () => client.openFileStream({ path }),
          filename: name,
          // A mutable/computed VFS file's listing is not an exact output length.
          size: undefined,
          signal: abort.signal,
        });
        break;
      default: {
        const exhaustive: never = source;
        throw new Error(`Unhandled download source: ${String(exhaustive)}`);
      }
      }
    } catch (error) {
      if (abort.signal.aborted) {
        return;
      }
      addToast({ message: await ensureStrings.fileExplorer__failed_to_download({ errorMessage: error instanceof Error ? error.message : String(error) }) });
    } finally {
      window.removeEventListener('pagehide', onPageHide);
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
    ...((__BUILD_MODE_IS_TEST__ && {
      TEST_ONLY: {
        // Export internal state and logic used only for testing here. Do not reference these in production logic.
      },
    }) || {}),
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
