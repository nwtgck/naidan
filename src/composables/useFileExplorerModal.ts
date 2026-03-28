import { ref } from 'vue';
import type { ExplorerDirectory } from '@/components/file-explorer/explorer-directory';

export type FileExplorerModalOptions =
  | { kind: 'opfs-root' }
  | { kind: 'explorer'; root: ExplorerDirectory; initialEntryName: string | undefined; title: string };

const isOpen = ref(false);
const options = ref<FileExplorerModalOptions>({ kind: 'opfs-root' });

export function useFileExplorerModal() {
  function openFileExplorer(opts?: FileExplorerModalOptions): void {
    options.value = opts ?? { kind: 'opfs-root' };
    isOpen.value = true;
  }

  function closeFileExplorer(): void {
    isOpen.value = false;
  }

  return {
    isFileExplorerOpen: isOpen,
    fileExplorerOptions: options,
    openFileExplorer,
    closeFileExplorer,
    __testOnly: {
      // Export internal state and logic used only for testing here. Do not reference these in production logic.
    },
  };
}
