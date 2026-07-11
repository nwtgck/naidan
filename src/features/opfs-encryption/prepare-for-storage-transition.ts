import { nextTick } from 'vue';
import { promiseAllKeyed } from '@/utils/promise';

/**
 * Stops same-tab work that may retain native OPFS handles or schedule storage
 * writes after the provider session has been suspended.
 *
 * Other tabs receive the transition event and reload. This preflight is only
 * for the tab that is about to execute the transition itself.
 */
export async function prepareForOpfsEncryptionTransition(): Promise<void> {
  const {
    chatProcessing,
    fileExplorer,
    fileExplorerClients,
    weshClients,
  } = await promiseAllKeyed({
    chatProcessing: import('@/composables/chat/chat-scoped/chat-processing-abort'),
    fileExplorer: import('@/features/file-explorer/composables/useFileExplorerModal'),
    fileExplorerClients: import('@/features/file-explorer/worker/client-registry'),
    weshClients: import('@/features/wesh/worker/client-registry'),
  });

  chatProcessing.abortAllChatProcessingForStorageTransition();
  fileExplorer.useFileExplorerModal().closeFileExplorer();
  await nextTick();
  await promiseAllKeyed({
    fileExplorerClients: fileExplorerClients.disposeAllFileExplorerWorkerClientsForStorageTransition(),
    weshClients: weshClients.disposeAllWeshWorkerClientsForStorageTransition(),
  });
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
