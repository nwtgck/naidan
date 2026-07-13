import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OpfsEncryptionDebugSession } from '@/00-storage/service/opfs-encryption/inspection';
import OpfsEncryptionInspectorModal from './OpfsEncryptionInspectorModal.vue';

const mocks = vi.hoisted(() => ({
  closeInspector: vi.fn(),
  createSession: vi.fn(),
  openEncryptedOpfsWorkbench: vi.fn(),
  openFileExplorer: vi.fn(),
}));

vi.mock('@/00-storage/service', () => ({
  storageService: {
    createOpfsEncryptionDebugSession: mocks.createSession,
  },
}));

vi.mock('@/features/debug-opfs-encryption/composables/useDebugOpfsEncryptionInspector', () => ({
  useDebugOpfsEncryptionInspector: () => ({
    closeDebugOpfsEncryptionInspector: mocks.closeInspector,
  }),
}));

vi.mock('@/features/debug-encrypted-opfs/composables/useDebugEncryptedOpfsWorkbench', () => ({
  useDebugEncryptedOpfsWorkbench: () => ({
    openDebugEncryptedOpfsWorkbench: mocks.openEncryptedOpfsWorkbench,
  }),
}));

vi.mock('@/features/file-explorer/composables/useFileExplorerModal', () => ({
  useFileExplorerModal: () => ({
    openFileExplorer: mocks.openFileExplorer,
  }),
}));

vi.mock('@/features/json-viewer', () => ({
  JsonCodeView: {
    props: ['source'],
    template: '<pre data-testid="json-code-view">{{ source }}</pre>',
  },
}));

function createSession(): OpfsEncryptionDebugSession {
  return {
    state: {
      formatVersion: 1,
      sequence: 8,
      state: 'encrypted',
      keySlots: [{
        id: 'slot-a',
        keyDerivation: {
          type: 'pbkdf2_hmac_sha256',
          salt: 'salt',
          iterations: 600_000,
        },
        wrappedStorageUnlockKey: {
          nonce: 'slot-nonce',
          ciphertext: 'slot-ciphertext',
        },
      }],
      activeEncryptedStoreId: 'store-a',
    },
    header: {
      formatVersion: 1,
      encryptedStoreId: 'store-a',
      fileSystemId: 'filesystem-a',
      wrappedFileSystemRootKey: {
        nonce: 'root-nonce',
        ciphertext: 'root-ciphertext',
      },
    },
    encryptedOpfs: {
      descriptor: {
        formatVersion: 1,
        fileSystemId: 'filesystem-a',
      },
      persistedDescriptorDto: {
        formatVersion: 1,
        fileSystemId: 'filesystem-a',
      },
      superblockSlots: [],
      activeSuperblock: {
        sequence: 10,
        fileSystemId: 'filesystem-a',
        activeCommitObjectId: 'commit-a',
      },
      activeCommitObjectId: 'commit-a',
      activeCommit: {
        revision: 11,
        rootDirectoryNodeId: 'root-a',
        inodeIndexRootObjectId: 'inode-index-a',
      },
      activeCommitPersistedDto: {
        revision: 11,
        rootDirectoryNodeId: 'root-a',
        inodeIndexRootObjectId: 'inode-index-a',
      },
    },
    encryptedOpfsReader: {} as OpfsEncryptionDebugSession['encryptedOpfsReader'],
    decryptedRoot: {
      kind: 'directory',
      name: '',
    } as OpfsEncryptionDebugSession['decryptedRoot'],
    physicalPath: ['naidan-storage', 'encrypted-stores', 'store-a', 'data'],
    dispose: vi.fn(async () => {}),
  };
}

describe('OpfsEncryptionInspectorModal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createSession.mockResolvedValue(createSession());
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('shows exact persisted Naidan encryption DTOs and store identity', async () => {
    const wrapper = mount(OpfsEncryptionInspectorModal, { attachTo: document.body });
    await flushPromises();

    expect(document.body.textContent).toContain('OPFS Encryption Inspector');
    expect(document.body.textContent).toContain('store-a');
    expect(document.body.textContent).toContain('naidan-storage/encrypted-stores/store-a/data');
    expect(document.body.textContent).toContain('slot-a');
    expect(document.body.textContent).toContain('root-ciphertext');

    wrapper.unmount();
  });

  it('opens EncryptedOpfs internals, decrypted File Explorer, and raw OPFS independently', async () => {
    const session = createSession();
    mocks.createSession.mockResolvedValue(session);
    const wrapper = mount(OpfsEncryptionInspectorModal, { attachTo: document.body });
    await flushPromises();

    document.body.querySelector<HTMLButtonElement>('[data-testid="opfs-encryption-open-encrypted-opfs"]')?.click();
    expect(mocks.closeInspector).toHaveBeenCalledOnce();
    expect(mocks.openEncryptedOpfsWorkbench).toHaveBeenCalledOnce();

    document.body.querySelector<HTMLButtonElement>('[data-testid="opfs-encryption-open-decrypted"]')?.click();
    expect(mocks.openFileExplorer).toHaveBeenCalledWith({
      options: {
        kind: 'storage-directory',
        title: 'Decrypted EncryptedOpfs',
        rootName: 'EncryptedOpfs root',
        handle: session.decryptedRoot,
        readOnly: true,
        initialPath: undefined,
      },
    });

    document.body.querySelector<HTMLButtonElement>('[data-testid="opfs-encryption-open-raw"]')?.click();
    expect(mocks.openFileExplorer).toHaveBeenCalledWith({ options: { kind: 'opfs-root' } });

    wrapper.unmount();
  });

  it('disposes the previous inspection lease before reload and on unmount', async () => {
    const first = createSession();
    const second = createSession();
    mocks.createSession.mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    const wrapper = mount(OpfsEncryptionInspectorModal, { attachTo: document.body });
    await flushPromises();

    await (wrapper.vm as unknown as { TEST_ONLY: { reload(): Promise<void> } }).TEST_ONLY.reload();
    expect(first.dispose).toHaveBeenCalledOnce();

    wrapper.unmount();
    await flushPromises();
    expect(second.dispose).toHaveBeenCalledOnce();
  });

  it('keeps retry available when the debug session cannot be opened', async () => {
    mocks.createSession.mockRejectedValue(new Error('inspection unavailable'));
    const wrapper = mount(OpfsEncryptionInspectorModal, { attachTo: document.body });
    await flushPromises();

    expect(document.body.textContent).toContain('inspection unavailable');
    expect(document.body.textContent).toContain('Retry');
    wrapper.unmount();
  });
});
