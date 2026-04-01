import { ref, shallowRef } from 'vue';
import type { WeshMount } from '@/services/wesh/types';
import type { FileExplorerRootDescriptor } from '@/services/file-explorer.worker.types';

export type FileExplorerModalOptions =
  | { kind: 'opfs-root' }
  | {
    kind: 'native-directory';
    title: string;
    rootName: string;
    handle: FileSystemDirectoryHandle;
    readOnly: boolean;
    initialPath: string[] | undefined;
  }
  | {
    kind: 'wesh-mounts';
    title: string;
    rootName: string;
    mounts: WeshMount[];
    initialPath: string[] | undefined;
  };

export function mapFileExplorerModalOptionsToRootDescriptor({
  options,
}: {
  options: FileExplorerModalOptions;
}): FileExplorerRootDescriptor {
  switch (options.kind) {
  case 'opfs-root':
    return {
      kind: 'opfs-root',
      rootName: 'OPFS root',
    };
  case 'native-directory':
    return {
      kind: 'native-directory',
      rootName: options.rootName,
      handle: options.handle,
      readOnly: options.readOnly,
    };
  case 'wesh-mounts':
    return {
      kind: 'wesh-mounts',
      rootName: options.rootName,
      mounts: options.mounts,
    };
  default: {
    const _exhaustiveCheck: never = options;
    throw new Error(`Unhandled file explorer modal options: ${JSON.stringify(_exhaustiveCheck)}`);
  }
  }
}

const isOpen = ref(false);
const options = shallowRef<FileExplorerModalOptions>({ kind: 'opfs-root' });

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
    TEST_ONLY: {
      // Export internal state and logic used only for testing here. Do not reference these in production logic.
    },
  };
}
