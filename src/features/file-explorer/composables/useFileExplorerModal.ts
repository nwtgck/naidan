import { ref, shallowRef } from 'vue';
import type { WeshMount } from '@/features/wesh/types';
import type { FileExplorerRemoteMount, FileExplorerRootDescriptor } from '@/features/file-explorer/worker/types';
import { mapWeshMountsToWorkerMounts } from '@/features/wesh/worker/types';

export type FileExplorerModalOptions =
  | { kind: 'opfs-root', initialPath?: string[] }
  | {
    kind: 'native-directory',
    title: string,
    rootName: string,
    handle: FileSystemDirectoryHandle,
    readOnly: boolean,
    initialPath: string[] | undefined,
    initialLocked?: boolean,
  }
  | {
    kind: 'wesh-mounts',
    title: string,
    rootName: string,
    mounts: WeshMount[],
    remoteMounts?: FileExplorerRemoteMount[],
    initialPath: string[] | undefined,
    initialLocked?: boolean,
  }
  | {
    kind: 'archive-root',
    title: string,
    rootName: string,
    archive: Extract<FileExplorerRootDescriptor, { kind: 'archive-root' }>['archive'],
  };

export function mapFileExplorerModalOptionsToRootDescriptor({
  options,
}: {
  options: FileExplorerModalOptions,
}): FileExplorerRootDescriptor {
  switch (options.kind) {
  case 'opfs-root':
    return {
      kind: 'opfs-root',
      // TODO(strings-localize): Localize this worker descriptor after the synchronous root mapping accepts a resolved display label separately.
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
      mounts: mapWeshMountsToWorkerMounts({ mounts: options.mounts }),
      ...(options.remoteMounts === undefined ? {} : { remoteMounts: options.remoteMounts.map(({ access: _access, ...mount }) => mount) }),
    };
  case 'archive-root':
    return {
      kind: 'archive-root',
      rootName: options.rootName,
      archive: options.archive,
    };
  default: {
    const _exhaustiveCheck: never = options;
    throw new Error(`Unhandled file explorer modal options: ${JSON.stringify(_exhaustiveCheck)}`);
  }
  }
}

const isOpen = ref(false);
const options = shallowRef<FileExplorerModalOptions>({ kind: 'opfs-root' });
let onClose: (() => void) | undefined;

export function useFileExplorerModal() {
  function openFileExplorer({ options: opts, onClose: callback }: { options?: FileExplorerModalOptions, onClose?: () => void }): void {
    onClose?.();
    onClose = callback;
    options.value = opts ?? { kind: 'opfs-root' };
    isOpen.value = true;
  }

  function closeFileExplorer(): void {
    isOpen.value = false;
    options.value = { kind: 'opfs-root' };
    const callback = onClose;
    onClose = undefined;
    callback?.();
  }

  return {
    isFileExplorerOpen: isOpen,
    fileExplorerOptions: options,
    openFileExplorer,
    closeFileExplorer,
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
