import { nextTick } from 'vue';
import { promiseAllKeyed } from '@/utils/promise';

/**
 * Stops same-tab work that may retain native OPFS handles or schedule storage
 * writes after the provider session has been suspended.
 *
 * Other tabs run the same preflight after receiving the transition-started
 * event, release their shared OPFS session lock, and remain blocked until the
 * initiator reports completion or rollback. The initiating tab calls this
 * function directly before requesting the exclusive transition.
 */
export async function prepareForOpfsEncryptionTransition(): Promise<void> {
  const {
    chatProcessing,
    debugEncryptedStorage,
    debugEncryptedStorageClients,
    fileExplorer,
    fileExplorerClients,
    weshClients,
  } = await promiseAllKeyed({
    chatProcessing: import('@/composables/chat/chat-scoped/chat-processing-abort'),
    debugEncryptedStorage: import('@/features/debug-encrypted-storage/composables/useDebugEncryptedStorageInspector'),
    debugEncryptedStorageClients: import('@/features/debug-encrypted-storage/worker/client-registry'),
    fileExplorer: import('@/features/file-explorer/composables/useFileExplorerModal'),
    fileExplorerClients: import('@/features/file-explorer/worker/client-registry'),
    weshClients: import('@/features/wesh/worker/client-registry'),
  });

  chatProcessing.abortAllChatProcessingForStorageTransition();
  debugEncryptedStorage.useDebugEncryptedStorageInspector().closeDebugEncryptedStorageInspector();
  fileExplorer.useFileExplorerModal().closeFileExplorer();
  await nextTick();
  await promiseAllKeyed({
    debugEncryptedStorageClients: debugEncryptedStorageClients.disposeAllDebugEncryptedStorageWorkerClientsForStorageTransition(),
    fileExplorerClients: fileExplorerClients.disposeAllFileExplorerWorkerClientsForStorageTransition(),
    weshClients: weshClients.disposeAllWeshWorkerClientsForStorageTransition(),
  });
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
