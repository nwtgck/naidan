import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  DebugEncryptedStorageWorkerClient,
  EncryptedStorageDebugIntegrityReport,
  EncryptedStorageDebugNode,
  EncryptedStorageDebugSearchResult,
} from '@/features/debug-encrypted-storage/worker/types';
import { useDebugEncryptedStorageInspector } from '@/features/debug-encrypted-storage/composables/useDebugEncryptedStorageInspector';
import DebugEncryptedStorageInspectorModal from './DebugEncryptedStorageInspectorModal.vue';

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(),
  openFileExplorer: vi.fn(),
}));

vi.mock('../worker/client', () => ({
  createDebugEncryptedStorageWorkerClient: mocks.createClient,
}));

vi.mock('@/features/file-explorer/composables/useFileExplorerModal', () => ({
  useFileExplorerModal: () => ({
    openFileExplorer: mocks.openFileExplorer,
  }),
}));

const rootNode: EncryptedStorageDebugNode = {
  ref: { type: 'root' },
  kind: 'encrypted_storage_root',
  title: 'Encrypted store test-store',
  fields: [{ label: 'Store ID', value: 'test-store' }],
  value: { collections: [] },
  references: [{
    label: 'Naidan store manifest',
    ref: { type: 'store_manifest' },
  }],
  warnings: [],
};

const manifestNode: EncryptedStorageDebugNode = {
  ref: { type: 'store_manifest' },
  kind: 'naidan_encrypted_store_manifest',
  title: 'Naidan encrypted store manifest',
  fields: [{ label: 'Collections', value: '0' }],
  value: { collections: [] },
  references: [],
  physicalPath: 'objects/00/example.enc',
  warnings: [],
};

function createClient(): DebugEncryptedStorageWorkerClient {
  return {
    loadNode: vi.fn(async ({ ref }) => ref.type === 'store_manifest' ? manifestNode : rootNode),
    search: vi.fn(async (): Promise<EncryptedStorageDebugSearchResult[]> => [{
      label: 'Store manifest',
      detail: 'singleton:store_manifest',
      ref: { type: 'store_manifest' },
    }]),
    scanIntegrity: vi.fn(async (): Promise<EncryptedStorageDebugIntegrityReport> => ({
      scannedPhysicalObjects: 3,
      knownLogicalObjects: 3,
      findings: [{
        severity: 'warning',
        message: 'Example warning',
        ref: { type: 'store_manifest' },
      }],
    })),
    dispose: vi.fn(async () => undefined),
  };
}

describe('DebugEncryptedStorageInspectorModal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useDebugEncryptedStorageInspector().openDebugEncryptedStorageInspector();
  });

  afterEach(() => {
    useDebugEncryptedStorageInspector().closeDebugEncryptedStorageInspector();
    document.body.innerHTML = '';
  });

  it('navigates the integrated storage graph and runs Worker-backed search and integrity scan', async () => {
    const client = createClient();
    mocks.createClient.mockResolvedValue(client);
    const wrapper = mount(DebugEncryptedStorageInspectorModal, {
      attachTo: document.body,
    });
    await flushPromises();

    const modal = document.body.querySelector('[data-testid="debug-encrypted-storage-inspector"]');
    expect(modal?.textContent).toContain('Encrypted Storage Inspector');
    expect(modal?.textContent).toContain('Encrypted store test-store');
    expect(modal?.textContent).toContain('test-store');

    const manifestReference = [...document.body.querySelectorAll('button')]
      .find(button => button.textContent?.includes('Naidan store manifest'));
    expect(manifestReference).toBeDefined();
    manifestReference?.click();
    await flushPromises();
    expect(document.body.textContent).toContain('Naidan encrypted store manifest');
    expect(document.body.textContent).toContain('objects/00/example.enc');

    const searchInput = document.body.querySelector<HTMLInputElement>('input[placeholder="ID, path, namespace:key"]');
    if (searchInput === null) {
      throw new Error('Search input was not rendered');
    }
    searchInput.value = 'manifest';
    searchInput.dispatchEvent(new Event('input'));
    searchInput.form?.dispatchEvent(new Event('submit', { cancelable: true }));
    await flushPromises();
    expect(client.search).toHaveBeenCalledWith({ query: 'manifest' });
    expect(document.body.textContent).toContain('singleton:store_manifest');

    const scanButton = [...document.body.querySelectorAll('button')]
      .find(button => button.textContent?.includes('Run integrity scan'));
    scanButton?.click();
    await flushPromises();
    expect(client.scanIntegrity).toHaveBeenCalledOnce();
    expect(document.body.textContent).toContain('Example warning');
    expect(document.body.textContent).toContain('Physical');

    wrapper.unmount();
    await flushPromises();
    expect(client.dispose).toHaveBeenCalledOnce();
  });

  it('opens the raw OPFS explorer from the Inspector toolbar', async () => {
    mocks.createClient.mockResolvedValue(createClient());
    const wrapper = mount(DebugEncryptedStorageInspectorModal, {
      attachTo: document.body,
    });
    await flushPromises();

    const rawButton = [...document.body.querySelectorAll<HTMLButtonElement>('button')]
      .find(button => button.title === 'Open raw OPFS explorer');
    rawButton?.click();

    expect(mocks.openFileExplorer).toHaveBeenCalledWith({
      options: { kind: 'opfs-root' },
    });
    wrapper.unmount();
  });
});
