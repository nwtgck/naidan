import { ref, computed } from 'vue';
import type { FileExplorerEntry, ClipboardState } from '../logic/types';

export function useFileExplorerClipboard() {
  const clipboardState = ref<ClipboardState>({
    operation: undefined,
    sourceDirectoryPath: undefined,
    entries: [],
  });

  const hasClipboardContent = computed(
    () => clipboardState.value.operation !== undefined && clipboardState.value.entries.length > 0,
  );

  function clipboardCut({
    entries,
    sourceDirectoryPath,
  }: {
    entries: FileExplorerEntry[],
    sourceDirectoryPath: string,
  }): void {
    clipboardState.value = { operation: 'cut', sourceDirectoryPath, sourceDirectory: sourceDirectoryPath, entries: [...entries] };
  }

  function clipboardCopy({
    entries,
    sourceDirectoryPath,
  }: {
    entries: FileExplorerEntry[],
    sourceDirectoryPath: string,
  }): void {
    clipboardState.value = { operation: 'copy', sourceDirectoryPath, sourceDirectory: sourceDirectoryPath, entries: [...entries] };
  }

  function clearClipboard(): void {
    clipboardState.value = { operation: undefined, sourceDirectoryPath: undefined, sourceDirectory: undefined, entries: [] };
  }

  function isCut({ entry }: { entry: FileExplorerEntry }): boolean {
    return (
      clipboardState.value.operation === 'cut' &&
      clipboardState.value.entries.some(e => e.name === entry.name)
    );
  }

  return {
    clipboardState,
    hasClipboardContent,
    clipboardCut,
    clipboardCopy,
    clearClipboard,
    isCut,
    TEST_ONLY: {
      // Export internal state and logic used only for testing here. Do not reference these in production logic.
    },
  };
}
