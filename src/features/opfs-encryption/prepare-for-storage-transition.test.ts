import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  calls: [] as string[],
  abortAllChatProcessingForStorageTransition: vi.fn(),
  closeDebugHizoFSWorkbench: vi.fn(),
  closeDebugOpfsEncryptionInspector: vi.fn(),
  closeFileExplorer: vi.fn(),
  disposeFileExplorerClients: vi.fn<() => Promise<void>>(),
  disposeWeshClients: vi.fn<() => Promise<void>>(),
}));

vi.mock('@/composables/chat/chat-scoped/chat-processing-abort', () => ({
  abortAllChatProcessingForStorageTransition: mocks.abortAllChatProcessingForStorageTransition,
}));

vi.mock('@/features/debug-hizofs/composables/useDebugHizoFSWorkbench', () => ({
  useDebugHizoFSWorkbench: () => ({
    closeDebugHizoFSWorkbench: mocks.closeDebugHizoFSWorkbench,
  }),
}));

vi.mock('@/features/debug-opfs-encryption/composables/useDebugOpfsEncryptionInspector', () => ({
  useDebugOpfsEncryptionInspector: () => ({
    closeDebugOpfsEncryptionInspector: mocks.closeDebugOpfsEncryptionInspector,
  }),
}));

vi.mock('@/features/file-explorer/composables/useFileExplorerModal', () => ({
  useFileExplorerModal: () => ({
    closeFileExplorer: mocks.closeFileExplorer,
  }),
}));

vi.mock('@/features/file-explorer/worker/client-registry', () => ({
  disposeAllFileExplorerWorkerClientsForStorageTransition: mocks.disposeFileExplorerClients,
}));

vi.mock('@/features/wesh/worker/client-registry', () => ({
  disposeAllWeshWorkerClientsForStorageTransition: mocks.disposeWeshClients,
}));

import { prepareForOpfsEncryptionTransition } from './prepare-for-storage-transition';

beforeEach(() => {
  mocks.calls.length = 0;
  vi.clearAllMocks();
  mocks.abortAllChatProcessingForStorageTransition.mockImplementation(() => {
    mocks.calls.push('abort-chat');
  });
  mocks.closeDebugHizoFSWorkbench.mockImplementation(() => {
    mocks.calls.push('close-hizofs-inspector');
  });
  mocks.closeDebugOpfsEncryptionInspector.mockImplementation(() => {
    mocks.calls.push('close-opfs-encryption-inspector');
  });
  mocks.closeFileExplorer.mockImplementation(() => {
    mocks.calls.push('close-file-explorer');
  });
  mocks.disposeFileExplorerClients.mockImplementation(async () => {
    mocks.calls.push('dispose-file-explorer-workers');
  });
  mocks.disposeWeshClients.mockImplementation(async () => {
    mocks.calls.push('dispose-wesh-workers');
  });
});

describe('prepareForOpfsEncryptionTransition', () => {
  it('closes storage UIs and waits for every worker client before returning', async () => {
    await prepareForOpfsEncryptionTransition();

    expect(mocks.abortAllChatProcessingForStorageTransition).toHaveBeenCalledOnce();
    expect(mocks.closeDebugHizoFSWorkbench).toHaveBeenCalledOnce();
    expect(mocks.closeDebugOpfsEncryptionInspector).toHaveBeenCalledOnce();
    expect(mocks.closeFileExplorer).toHaveBeenCalledOnce();
    expect(mocks.disposeFileExplorerClients).toHaveBeenCalledOnce();
    expect(mocks.disposeWeshClients).toHaveBeenCalledOnce();

    expect(mocks.calls.indexOf('close-file-explorer')).toBeLessThan(
      mocks.calls.indexOf('dispose-file-explorer-workers'),
    );
  });

});
