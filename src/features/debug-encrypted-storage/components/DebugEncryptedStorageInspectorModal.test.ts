import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EncryptedStorageDebugSession } from '@/00-storage/service/opfs-encryption/inspection';
import { useDebugEncryptedStorageInspector } from '@/features/debug-encrypted-storage/composables/useDebugEncryptedStorageInspector';
import DebugEncryptedStorageInspectorModal from './DebugEncryptedStorageInspectorModal.vue';

const mocks = vi.hoisted(() => ({
  createSession: vi.fn(),
  openFileExplorer: vi.fn(),
}));

vi.mock('@/00-storage/service', () => ({
  storageService: {
    createEncryptedStorageDebugSession: mocks.createSession,
  },
}));

vi.mock('@/features/file-explorer/composables/useFileExplorerModal', () => ({
  useFileExplorerModal: () => ({
    openFileExplorer: mocks.openFileExplorer,
  }),
}));

function createSession(): EncryptedStorageDebugSession {
  return {
    state: {
      formatVersion: 1,
      sequence: 4,
      state: 'encrypted',
      keySlots: [],
      activeEncryptedStoreId: 'store-a',
    },
    header: {
      formatVersion: 1,
      encryptedStoreId: 'store-a',
      fileSystemId: 'filesystem-a',
      wrappedFileSystemRootKey: {
        nonce: 'nonce',
        ciphertext: 'ciphertext',
      },
    },
    encryptedOpfs: {
      descriptor: {
        formatVersion: 1,
        fileSystemId: 'filesystem-a',
      },
      superblock: {
        sequence: 9,
        fileSystemId: 'filesystem-a',
        activeCommitObjectId: 'commit-object-a',
      },
      activeCommitObjectId: 'commit-object-a',
      activeCommit: {
        revision: 12,
        rootDirectoryNodeId: 'root-node-a',
        inodeIndexRootObjectId: 'inode-index-a',
      },
    },
    decryptedRoot: {
      kind: 'directory',
      name: '',
    } as EncryptedStorageDebugSession['decryptedRoot'],
    physicalPath: ['naidan-storage', 'encrypted-stores', 'store-a', 'data'],
  };
}

describe('DebugEncryptedStorageInspectorModal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createSession.mockResolvedValue(createSession());
    useDebugEncryptedStorageInspector().openDebugEncryptedStorageInspector();
  });

  afterEach(() => {
    useDebugEncryptedStorageInspector().closeDebugEncryptedStorageInspector();
    document.body.innerHTML = '';
  });

  it('shows the management state and EncryptedOpfs active commit', async () => {
    const wrapper = mount(DebugEncryptedStorageInspectorModal, { attachTo: document.body });
    await flushPromises();

    expect(document.body.textContent).toContain('Encrypted Storage Inspector');
    expect(document.body.textContent).toContain('store-a');
    expect(document.body.textContent).toContain('filesystem-a');
    expect(document.body.textContent).toContain('12');
    expect(document.body.textContent).toContain('naidan-storage/encrypted-stores/store-a/data');
    expect(document.body.textContent).toContain('activeCommitObjectId');

    wrapper.unmount();
  });

  it('opens the decrypted root through the existing File Explorer', async () => {
    const session = createSession();
    mocks.createSession.mockResolvedValue(session);
    const wrapper = mount(DebugEncryptedStorageInspectorModal, { attachTo: document.body });
    await flushPromises();

    document.body.querySelector<HTMLButtonElement>('[data-testid="encrypted-storage-open-decrypted"]')?.click();
    await flushPromises();

    expect(mocks.openFileExplorer).toHaveBeenCalledWith({
      options: {
        kind: 'wesh-mounts',
        title: 'Decrypted EncryptedOpfs',
        rootName: 'EncryptedOpfs root',
        mounts: [{
          type: 'storage_directory',
          path: '/',
          handle: session.decryptedRoot,
          readOnly: true,
        }],
        initialPath: undefined,
      },
    });
    expect(useDebugEncryptedStorageInspector().isDebugEncryptedStorageInspectorOpen.value).toBe(false);

    wrapper.unmount();
  });

  it('opens the raw physical OPFS explorer', async () => {
    const wrapper = mount(DebugEncryptedStorageInspectorModal, { attachTo: document.body });
    await flushPromises();

    document.body.querySelector<HTMLButtonElement>('[data-testid="encrypted-storage-open-physical"]')?.click();
    await flushPromises();

    expect(mocks.openFileExplorer).toHaveBeenCalledWith({ options: { kind: 'opfs-root' } });
    wrapper.unmount();
  });

  it('keeps the modal usable when inspection fails', async () => {
    mocks.createSession.mockRejectedValue(new Error('inspection failed'));
    const wrapper = mount(DebugEncryptedStorageInspectorModal, { attachTo: document.body });
    await flushPromises();

    expect(document.body.textContent).toContain('inspection failed');
    expect(document.body.textContent).toContain('Retry');
    wrapper.unmount();
  });
});
