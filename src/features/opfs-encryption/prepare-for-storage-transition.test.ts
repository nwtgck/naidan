import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  calls: [] as string[],
  abortAllChatProcessingForStorageTransition: vi.fn(),
  closeDebugEncryptedStorageInspector: vi.fn(),
  closeFileExplorer: vi.fn(),
  disposeDebugClients: vi.fn<() => Promise<void>>(),
  disposeFileExplorerClients: vi.fn<() => Promise<void>>(),
  disposeWeshClients: vi.fn<() => Promise<void>>(),
}));

vi.mock('@/composables/chat/chat-scoped/chat-processing-abort', () => ({
  abortAllChatProcessingForStorageTransition: mocks.abortAllChatProcessingForStorageTransition,
}));

vi.mock('@/features/debug-encrypted-storage/composables/useDebugEncryptedStorageInspector', () => ({
  useDebugEncryptedStorageInspector: () => ({
    closeDebugEncryptedStorageInspector: mocks.closeDebugEncryptedStorageInspector,
  }),
}));

vi.mock('@/features/debug-encrypted-storage/worker/client-registry', () => ({
  disposeAllDebugEncryptedStorageWorkerClientsForStorageTransition: mocks.disposeDebugClients,
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
  mocks.closeDebugEncryptedStorageInspector.mockImplementation(() => {
    mocks.calls.push('close-inspector');
  });
  mocks.closeFileExplorer.mockImplementation(() => {
    mocks.calls.push('close-file-explorer');
  });
  mocks.disposeDebugClients.mockImplementation(async () => {
    mocks.calls.push('dispose-inspector-workers');
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
    expect(mocks.closeDebugEncryptedStorageInspector).toHaveBeenCalledOnce();
    expect(mocks.closeFileExplorer).toHaveBeenCalledOnce();
    expect(mocks.disposeDebugClients).toHaveBeenCalledOnce();
    expect(mocks.disposeFileExplorerClients).toHaveBeenCalledOnce();
    expect(mocks.disposeWeshClients).toHaveBeenCalledOnce();

    expect(mocks.calls.indexOf('close-inspector')).toBeLessThan(
      mocks.calls.indexOf('dispose-inspector-workers'),
    );
    expect(mocks.calls.indexOf('close-file-explorer')).toBeLessThan(
      mocks.calls.indexOf('dispose-file-explorer-workers'),
    );
  });

  it('does not resolve while the Inspector worker still owns its debug session', async () => {
    let releaseInspector: (() => void) | undefined;
    mocks.disposeDebugClients.mockImplementation(async () => {
      mocks.calls.push('dispose-inspector-workers');
      await new Promise<void>((resolve) => {
        releaseInspector = resolve;
      });
    });

    let completed = false;
    const preparation = prepareForOpfsEncryptionTransition().then(() => {
      completed = true;
    });
    await vi.waitFor(() => {
      expect(mocks.disposeDebugClients).toHaveBeenCalledOnce();
      expect(releaseInspector).toBeTypeOf('function');
    });

    expect(completed).toBe(false);
    releaseInspector?.();
    await preparation;
    expect(completed).toBe(true);
  });
});
