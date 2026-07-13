import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OpfsEncryptionDebugSession } from '@/00-storage/service/opfs-encryption/inspection';
import type { EncryptedOpfsInspectionWorkerClient } from '@/features/debug-encrypted-opfs/worker/types';
import EncryptedOpfsInspectorModal from './EncryptedOpfsInspectorModal.vue';

const mocks = vi.hoisted(() => ({
  closeInspector: vi.fn(),
  createClient: vi.fn(),
  createSession: vi.fn(),
  openControlPlane: vi.fn(),
  openFileExplorer: vi.fn(),
}));

vi.mock('@/00-storage/service', () => ({
  storageService: {
    createOpfsEncryptionDebugSession: mocks.createSession,
  },
}));

vi.mock('@/features/debug-encrypted-opfs/composables/useDebugEncryptedOpfsInspector', () => ({
  useDebugEncryptedOpfsInspector: () => ({
    closeDebugEncryptedOpfsInspector: mocks.closeInspector,
  }),
}));

vi.mock('@/features/debug-opfs-encryption/composables/useDebugOpfsEncryptionInspector', () => ({
  useDebugOpfsEncryptionInspector: () => ({
    openDebugOpfsEncryptionInspector: mocks.openControlPlane,
  }),
}));

vi.mock('@/features/debug-encrypted-opfs/worker/client', () => ({
  createEncryptedOpfsInspectionWorkerClient: mocks.createClient,
}));

vi.mock('@/features/file-explorer/composables/useFileExplorerModal', () => ({
  useFileExplorerModal: () => ({
    openFileExplorer: mocks.openFileExplorer,
  }),
}));

vi.mock('@/features/file-explorer/components/FileExplorer.vue', () => ({
  default: {
    props: ['root'],
    template: '<div data-testid="embedded-file-explorer">{{ root.rootName }}</div>',
  },
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
      sequence: 3,
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
      descriptor: { formatVersion: 1, fileSystemId: 'filesystem-a' },
      superblockSlots: [],
      activeSuperblock: {
        sequence: 4,
        fileSystemId: 'filesystem-a',
        activeCommitObjectId: 'commit-a',
      },
      activeCommitObjectId: 'commit-a',
      activeCommit: {
        revision: 5,
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
    dispose: vi.fn<EncryptedOpfsInspectionWorkerClient['dispose']>(async () => {}),
  };
}

function createClient(): EncryptedOpfsInspectionWorkerClient {
  return {
    readOverview: vi.fn<EncryptedOpfsInspectionWorkerClient['readOverview']>(async () => ({
      descriptor: { formatVersion: 1, fileSystemId: 'filesystem-a' },
      superblockSlots: [{
        slot: 0,
        status: 'valid',
        selected: true,
        physicalPath: ['superblock-0.eopfs'],
        value: {
          sequence: 4,
          fileSystemId: 'filesystem-a',
          activeCommitObjectId: 'commit-a',
        },
      }, {
        slot: 1,
        status: 'missing',
        selected: false,
        physicalPath: ['superblock-1.eopfs'],
      }],
      activeSuperblock: {
        sequence: 4,
        fileSystemId: 'filesystem-a',
        activeCommitObjectId: 'commit-a',
      },
      activeCommitObjectId: 'commit-a',
      activeCommit: {
        revision: 5,
        rootDirectoryNodeId: 'root-a',
        inodeIndexRootObjectId: 'inode-index-a',
      },
    })),
    listPhysicalObjects: vi.fn<EncryptedOpfsInspectionWorkerClient['listPhysicalObjects']>(async () => ({
      entries: [{ objectId: 'object-a', physicalPath: ['objects', '00', 'object-a.eopfs'] }],
      nextCursor: undefined,
      ignoredPhysicalPaths: ['objects/unexpected'],
    })),
    inspectObject: vi.fn<EncryptedOpfsInspectionWorkerClient['inspectObject']>(async () => ({
      object: {
        objectId: 'object-a',
        physicalPath: ['objects', '00', 'object-a.eopfs'],
        physicalByteLength: 64,
        envelope: {
          formatVersion: 1,
          nonceBytes: new Array<number>(12).fill(1),
          ciphertextByteLength: 32,
        },
        record: {
          kind: 'commit',
          recordVersion: 1,
          metadata: {
            revision: 5,
            rootDirectoryNodeId: 'root-a',
            inodeIndexRootObjectId: 'inode-index-a',
          },
          binaryPayloadByteLength: 0,
          binaryPayloadPreviewBytes: [],
          binaryPayloadPreviewTruncated: false,
        },
      },
      validation: {
        status: 'valid',
        persistedDto: {
          revision: 5,
          rootDirectoryNodeId: 'root-a',
          inodeIndexRootObjectId: 'inode-index-a',
        },
      },
      references: [{ relation: 'inode index root', objectId: 'inode-index-a' }],
    })),
    readNamespace: vi.fn<EncryptedOpfsInspectionWorkerClient['readNamespace']>(async () => ({
      entries: [{
        path: '/settings.json',
        name: 'settings.json',
        kind: 'file',
        nodeId: 'node-a',
        inodeObjectId: 'object-a',
        revision: 2,
        size: 12,
        storage: 'inline',
      }],
      truncated: false,
      issues: [],
    })),
    runIntegrityScan: vi.fn<EncryptedOpfsInspectionWorkerClient['runIntegrityScan']>(async () => ({
      activeCommitObjectId: 'commit-a',
      activeReachableObjectCount: 4,
      fallbackReachableObjectCount: 2,
      reachableObjectCount: 5,
      fallbackOnlyObjectIds: ['fallback-a'],
      physicalObjectCount: 6,
      orphanObjectIds: ['orphan-a'],
      ignoredPhysicalPaths: [],
      recordKindCounts: { commit: 1 },
      totalBinaryPayloadBytes: 12,
      issues: [],
    })),
    cancelCurrentOperation: vi.fn<EncryptedOpfsInspectionWorkerClient['cancelCurrentOperation']>(async () => {}),
    dispose: vi.fn<EncryptedOpfsInspectionWorkerClient['dispose']>(async () => {}),
  };
}

describe('EncryptedOpfsInspectorModal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createSession.mockResolvedValue(createSession());
    mocks.createClient.mockResolvedValue(createClient());
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('shows the frozen persisted overview and embeds the decrypted File Explorer read-only', async () => {
    const wrapper = mount(EncryptedOpfsInspectorModal, { attachTo: document.body });
    await flushPromises();

    expect(document.body.textContent).toContain('EncryptedOpfs Inspector');
    expect(document.body.textContent).toContain('revision 5');
    expect(document.body.textContent).toContain('filesystem-a');
    expect(document.body.textContent).toContain('superblock-0.eopfs');

    document.body.querySelector<HTMLButtonElement>('[data-testid="encrypted-opfs-tab-namespace"]')?.click();
    await flushPromises();
    expect(document.body.textContent).toContain('EncryptedOpfs root');
    expect(document.body.textContent).toContain('/settings.json');

    wrapper.unmount();
  });

  it('inspects physical objects and runs a read-only integrity scan in the worker', async () => {
    const client = createClient();
    mocks.createClient.mockResolvedValue(client);
    const wrapper = mount(EncryptedOpfsInspectorModal, { attachTo: document.body });
    await flushPromises();

    document.body.querySelector<HTMLButtonElement>('[data-testid="encrypted-opfs-tab-objects"]')?.click();
    await flushPromises();
    const objectButton = Array.from(document.body.querySelectorAll<HTMLButtonElement>('button'))
      .find(button => button.textContent?.includes('object-a'));
    objectButton?.click();
    await flushPromises();
    expect(client.inspectObject).toHaveBeenCalledWith({
      objectId: 'object-a',
      binaryPayloadPreviewByteLength: 512,
    });
    expect(document.body.textContent).toContain('inode index root');

    document.body.querySelector<HTMLButtonElement>('[data-testid="encrypted-opfs-tab-integrity"]')?.click();
    await flushPromises();
    document.body.querySelector<HTMLButtonElement>('[data-testid="encrypted-opfs-run-integrity"]')?.click();
    await flushPromises();
    expect(client.runIntegrityScan).toHaveBeenCalledOnce();
    expect(document.body.textContent).toContain('orphan-a');

    wrapper.unmount();
  });

  it('links to the Naidan control plane and raw OPFS without leaking the root key', async () => {
    const wrapper = mount(EncryptedOpfsInspectorModal, { attachTo: document.body });
    await flushPromises();

    document.body.querySelector<HTMLButtonElement>('[data-testid="encrypted-opfs-open-control-plane"]')?.click();
    expect(mocks.closeInspector).toHaveBeenCalledOnce();
    expect(mocks.openControlPlane).toHaveBeenCalledOnce();

    document.body.querySelector<HTMLButtonElement>('[data-testid="encrypted-opfs-open-raw"]')?.click();
    expect(mocks.openFileExplorer).toHaveBeenCalledWith({ options: { kind: 'opfs-root' } });

    wrapper.unmount();
  });

  it('releases the worker and maintenance inspection session on unmount', async () => {
    const session = createSession();
    const client = createClient();
    mocks.createSession.mockResolvedValue(session);
    mocks.createClient.mockResolvedValue(client);
    const wrapper = mount(EncryptedOpfsInspectorModal, { attachTo: document.body });
    await flushPromises();

    wrapper.unmount();
    await flushPromises();
    expect(client.dispose).toHaveBeenCalledOnce();
    expect(session.dispose).toHaveBeenCalledOnce();
  });
});
