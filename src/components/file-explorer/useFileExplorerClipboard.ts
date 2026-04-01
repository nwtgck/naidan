import { ref, computed } from 'vue';
import type { FileExplorerEntry, ClipboardState } from './types';
import type { ExplorerDirectory } from './explorer-directory';

export function useFileExplorerClipboard() {
  const clipboardState = ref<ClipboardState>({
    operation: undefined,
    sourceDirectory: undefined,
    entries: [],
  });

  const hasClipboardContent = computed(
    () => clipboardState.value.operation !== undefined && clipboardState.value.entries.length > 0,
  );

  function clipboardCut({
    entries,
    sourceDirectory,
  }: {
    entries: FileExplorerEntry[];
    sourceDirectory: ExplorerDirectory;
  }): void {
    clipboardState.value = { operation: 'cut', sourceDirectory, entries: [...entries] };
  }

  function clipboardCopy({
    entries,
    sourceDirectory,
  }: {
    entries: FileExplorerEntry[];
    sourceDirectory: ExplorerDirectory;
  }): void {
    clipboardState.value = { operation: 'copy', sourceDirectory, entries: [...entries] };
  }

  function clearClipboard(): void {
    clipboardState.value = { operation: undefined, sourceDirectory: undefined, entries: [] };
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
    __testOnly: {
      // Export internal state and logic used only for testing here. Do not reference these in production logic.
    },
  };
}
