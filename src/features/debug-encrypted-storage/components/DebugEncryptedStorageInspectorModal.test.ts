import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  DebugEncryptedStorageWorkerClient,
  EncryptedStorageDebugIntegrityReport,
  EncryptedStorageDebugNode,
  EncryptedStorageDebugPersistedJson,
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
  value: { $debugInspectorRuntimeType: 'Uint8Array', byteLength: 32 },
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

const manifestPersistedJson: EncryptedStorageDebugPersistedJson = {
  json: '{"collections":[],"formatVersion":1}',
  parseStatus: 'valid',
  source: 'decrypted_persisted_bytes',
};

function createClient(): DebugEncryptedStorageWorkerClient {
  return {
    loadNode: vi.fn(async ({ ref }) => ref.type === 'store_manifest' ? manifestNode : rootNode),
    loadPersistedJson: vi.fn(async ({ ref }) => ref.type === 'store_manifest'
      ? manifestPersistedJson
      : undefined),
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

function findButton({ text }: { text: string }): HTMLButtonElement | undefined {
  return [...document.body.querySelectorAll<HTMLButtonElement>('button')]
    .find(button => button.textContent?.includes(text));
}

describe('DebugEncryptedStorageInspectorModal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: vi.fn(async () => undefined),
      },
    });
    useDebugEncryptedStorageInspector().openDebugEncryptedStorageInspector();
  });

  afterEach(() => {
    vi.useRealTimers();
    useDebugEncryptedStorageInspector().closeDebugEncryptedStorageInspector();
    document.body.innerHTML = '';
  });

  it('prioritizes exact persisted JSON and keeps runtime previews collapsed', async () => {
    const client = createClient();
    mocks.createClient.mockResolvedValue(client);
    const wrapper = mount(DebugEncryptedStorageInspectorModal, {
      attachTo: document.body,
    });
    await flushPromises();

    expect(document.body.textContent).toContain('Encrypted Storage Inspector');
    expect(document.body.textContent).toContain('Encrypted store test-store');
    expect(document.body.textContent).toContain('no directly persisted JSON DTO');

    findButton({ text: 'Naidan store manifest' })?.click();
    await flushPromises();

    expect(client.loadPersistedJson).toHaveBeenCalledWith({ ref: { type: 'store_manifest' } });
    expect(document.body.textContent).toContain('Exact decrypted persisted bytes');
    expect(document.body.querySelector('.json-syntax-property')?.textContent).toBe('"collections"');
    expect(document.body.textContent).not.toContain('$debugInspectorRuntimeType');
    const derivedDetails = document.body.querySelector<HTMLDetailsElement>('[data-testid="encrypted-storage-derived-details"]');
    expect(derivedDetails?.open).toBe(false);

    findButton({ text: 'Copy persisted JSON' })?.click();
    await flushPromises();
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(manifestPersistedJson.json);

    expect(document.body.querySelector('[data-testid="encrypted-storage-breadcrumb-0"]')?.textContent).toContain('Encrypted store test-store');
    expect(document.body.querySelector('[data-testid="encrypted-storage-breadcrumb-current"]')?.textContent).toContain('Naidan encrypted store manifest');
    expect(document.body.querySelectorAll('section[data-testid^="encrypted-storage-column-"]').length).toBe(2);

    const navigationPane = document.body.querySelector('[data-testid="encrypted-storage-navigation-pane"]');
    const detailPane = document.body.querySelector('[data-testid="encrypted-storage-detail-pane"]');
    const columnView = document.body.querySelector('[data-testid="encrypted-storage-column-view"]');
    const jsonView = document.body.querySelector('[data-testid="json-code-view"]');
    expect(navigationPane?.contains(columnView)).toBe(true);
    expect(detailPane?.contains(jsonView)).toBe(true);

    wrapper.unmount();
    await flushPromises();
    expect(client.dispose).toHaveBeenCalledOnce();
  });

  it('searches after input settles and clears results immediately for an empty query', async () => {
    vi.useFakeTimers();
    const client = createClient();
    mocks.createClient.mockResolvedValue(client);
    const wrapper = mount(DebugEncryptedStorageInspectorModal, {
      attachTo: document.body,
    });
    await flushPromises();

    const searchInput = document.body.querySelector<HTMLInputElement>('[data-testid="encrypted-storage-search-input"]');
    if (searchInput === null) {
      throw new Error('Search input was not rendered');
    }
    searchInput.value = 'manifest';
    searchInput.dispatchEvent(new Event('input'));
    await vi.advanceTimersByTimeAsync(249);
    expect(client.search).not.toHaveBeenCalled();
    expect(document.body.querySelector('[data-testid="encrypted-storage-navigation-results"]')).not.toBeNull();

    await vi.advanceTimersByTimeAsync(1);
    await flushPromises();
    expect(client.search).toHaveBeenCalledWith({ query: 'manifest' });
    expect(document.body.textContent).toContain('singleton:store_manifest');

    searchInput.value = '';
    searchInput.dispatchEvent(new Event('input'));
    await flushPromises();
    expect(document.body.textContent).not.toContain('singleton:store_manifest');
    expect(document.body.querySelector('[data-testid="encrypted-storage-navigation-results"]')).toBeNull();

    wrapper.unmount();
  });

  it('ignores a stale Worker search response as soon as the query changes', async () => {
    vi.useFakeTimers();
    const client = createClient();
    let resolveFirst: ((results: EncryptedStorageDebugSearchResult[]) => void) | undefined;
    vi.mocked(client.search)
      .mockImplementationOnce(async () => await new Promise<EncryptedStorageDebugSearchResult[]>(resolve => {
        resolveFirst = resolve;
      }))
      .mockResolvedValueOnce([{
        label: 'Second result',
        detail: 'second:result',
        ref: { type: 'store_manifest' },
      }]);
    mocks.createClient.mockResolvedValue(client);
    const wrapper = mount(DebugEncryptedStorageInspectorModal, {
      attachTo: document.body,
    });
    await flushPromises();

    const searchInput = document.body.querySelector<HTMLInputElement>('[data-testid="encrypted-storage-search-input"]');
    if (searchInput === null) {
      throw new Error('Search input was not rendered');
    }
    searchInput.value = 'first';
    searchInput.dispatchEvent(new Event('input'));
    await vi.advanceTimersByTimeAsync(250);
    expect(client.search).toHaveBeenCalledWith({ query: 'first' });

    searchInput.value = 'second';
    searchInput.dispatchEvent(new Event('input'));
    resolveFirst?.([{
      label: 'Stale result',
      detail: 'stale:result',
      ref: { type: 'store_manifest' },
    }]);
    await flushPromises();
    expect(document.body.textContent).not.toContain('Stale result');

    await vi.advanceTimersByTimeAsync(250);
    await flushPromises();
    expect(client.search).toHaveBeenLastCalledWith({ query: 'second' });
    expect(document.body.textContent).toContain('Second result');

    wrapper.unmount();
  });

  it('uses the navigation trail for breadcrumbs and column selection', async () => {
    const client = createClient();
    mocks.createClient.mockResolvedValue(client);
    const wrapper = mount(DebugEncryptedStorageInspectorModal, {
      attachTo: document.body,
    });
    await flushPromises();

    findButton({ text: 'Naidan store manifest' })?.click();
    await flushPromises();
    document.body.querySelector<HTMLButtonElement>('[data-testid="encrypted-storage-breadcrumb-0"]')?.click();
    await flushPromises();

    expect(document.body.querySelector('[data-testid="encrypted-storage-breadcrumb-current"]')?.textContent).toContain('Encrypted store test-store');
    expect(document.body.querySelectorAll('section[data-testid^="encrypted-storage-column-"]').length).toBe(1);
    expect(vi.mocked(client.loadNode).mock.calls.at(-1)?.[0]).toEqual({ ref: { type: 'root' } });

    wrapper.unmount();
  });

  it('runs integrity scan and opens the raw OPFS explorer', async () => {
    const client = createClient();
    mocks.createClient.mockResolvedValue(client);
    const wrapper = mount(DebugEncryptedStorageInspectorModal, {
      attachTo: document.body,
    });
    await flushPromises();

    findButton({ text: 'Run integrity scan' })?.click();
    await flushPromises();
    expect(client.scanIntegrity).toHaveBeenCalledOnce();
    expect(document.body.textContent).toContain('Example warning');
    expect(document.body.textContent).toContain('Physical');

    const rawButton = [...document.body.querySelectorAll<HTMLButtonElement>('button')]
      .find(button => button.title === 'Open raw OPFS explorer');
    rawButton?.click();
    expect(mocks.openFileExplorer).toHaveBeenCalledWith({
      options: { kind: 'opfs-root' },
    });

    wrapper.unmount();
  });
});
