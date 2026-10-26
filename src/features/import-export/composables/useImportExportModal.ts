import { readonly, shallowRef } from 'vue';

export type ImportExportInitialMode = 'menu' | 'export';
type ImportExportModalRequest = {
  id: number,
  initialMode: ImportExportInitialMode,
  status: 'loading' | 'ready' | 'failed',
};

// This state owns only an explicit UI request. Importing it must not load storage
// or an exporter, and the request must outlive the popover that opened it.
const request = shallowRef<ImportExportModalRequest | undefined>(undefined);
let nextRequestId = 0;

export function useImportExportModal() {
  function open({ initialMode }: { initialMode: ImportExportInitialMode }): number {
    const id = ++nextRequestId;
    request.value = { id, initialMode, status: 'loading' };
    return id;
  }

  function close({ requestId }: { requestId: number }): void {
    if (request.value?.id === requestId) {
      request.value = undefined;
    }
  }

  function completeLoad({ requestId, status }: { requestId: number, status: 'ready' | 'failed' }): void {
    const current = request.value;
    if (current?.id === requestId) {
      request.value = { ...current, status };
    }
  }

  return {
    request: readonly(request),
    open,
    close,
    completeLoad,
    ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}),
  };
}

export const TEST_ONLY = {
};
