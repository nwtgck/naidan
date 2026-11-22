import type { InjectionKey, Ref } from 'vue';
import type { FileExplorerEntry, ViewMode } from '@/features/file-explorer/logic/types';
import type { FileExplorerFileAccess } from '@/features/file-explorer/worker/types';

export const FILE_EXPLORER_FILE_VIEW_KEY: InjectionKey<{
  isActive: Readonly<Ref<boolean>>,
  activeFile: Readonly<Ref<FileExplorerEntry | undefined>>,
  canUnlockFiles: Readonly<Ref<boolean>>,
  access: FileExplorerFileAccess | undefined,
  activate: () => Promise<void>,
  revealFolder: ({ path }: { path: string }) => Promise<void>,
  showBrowser: ({ mode, restoreFocus, rememberMode }: { mode: ViewMode, restoreFocus: boolean, rememberMode: boolean }) => Promise<void>,
  open: ({ entry, startEditing, forceText }: { entry: FileExplorerEntry, startEditing?: boolean, forceText?: boolean }) => Promise<void>,
}> = Symbol('FileExplorerFileView');

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
