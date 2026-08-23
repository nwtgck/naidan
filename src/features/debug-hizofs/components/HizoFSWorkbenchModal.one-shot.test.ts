import { flushPromises, mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StorageDirectoryHandle } from '@/00-storage/service/storage-file-system/types';
import { fileExplorerRootDescriptorSchema } from '@/features/file-explorer/worker/types';
import type { HizoFSPhysicalInspectionSource } from '@/features/debug-hizofs/logic/active-physical-inspection-source';
import type { HizoFSAuthenticatedInspectionSession } from '@/features/debug-hizofs/worker/authenticated-inspection-session';
import type { HizoFSPhysicalInspectionWorker } from '@/features/debug-hizofs/worker/physical-inspection';
import HizoFSWorkbenchModal from './HizoFSWorkbenchModal.vue';

const mocks = vi.hoisted(() => ({
  asRef: <T>(value: T): { readonly __v_isRef: true; value: T } => ({ __v_isRef: true, value }),
  close: vi.fn(),
  createTemporary: vi.fn(),
  destroyTemporary: vi.fn(),
  generateTemporaryFixture: vi.fn(),
  refreshActive: vi.fn(),
  refreshTemporary: vi.fn(),
  selectTemporary: vi.fn(),
  createStandaloneInspector: vi.fn(),
  temporaryAuthenticatedSession: undefined as HizoFSAuthenticatedInspectionSession | undefined,
  temporaryDecryptedRoot: undefined as StorageDirectoryHandle | undefined,
  temporaryWorkspace: undefined as
    | { readonly status: 'live'; readonly workspaceId: string; readonly createdAt: number; readonly fileSystemId: string; readonly physicalPath: readonly string[] }
    | { readonly status: 'stale'; readonly workspaceId: string; readonly fileSystemId: undefined; readonly physicalPath: readonly string[] }
    | undefined,
  temporaryWorkspaces: [] as readonly (
    | { readonly status: 'live'; readonly workspaceId: string; readonly createdAt: number; readonly fileSystemId: string; readonly physicalPath: readonly string[] }
    | { readonly status: 'stale'; readonly workspaceId: string; readonly fileSystemId: undefined; readonly physicalPath: readonly string[] }
  )[],
}));

vi.mock('@/features/debug-hizofs/worker/opfs-physical-inspection', () => ({
  createHizoFSPhysicalInspectionWorkerForDirectory: mocks.createStandaloneInspector,
}));

vi.mock('@/features/debug-hizofs/composables/useDebugHizoFSWorkbench', () => ({
  useDebugHizoFSWorkbench: () => ({
    authenticatedInspectionSession: mocks.asRef(undefined),
    closeDebugHizoFSWorkbench: mocks.close,
    createTemporaryHizoFSWorkspace: mocks.createTemporary,
    decryptedRoot: mocks.asRef(undefined),
    destroyTemporaryHizoFSWorkspace: mocks.destroyTemporary,
    generateTemporaryHizoFSFixture: mocks.generateTemporaryFixture,
    physicalInspectionSource: mocks.asRef(undefined),
    refreshActiveHizoFSReadAuthorities: mocks.refreshActive,
    refreshTemporaryHizoFSWorkspaces: mocks.refreshTemporary,
    selectTemporaryHizoFSWorkspace: mocks.selectTemporary,
    selectedTemporaryWorkspaceId: mocks.asRef(mocks.temporaryWorkspace?.workspaceId),
    temporaryAuthenticatedInspectionSession: mocks.asRef(mocks.temporaryAuthenticatedSession),
    temporaryDecryptedRoot: mocks.asRef(mocks.temporaryDecryptedRoot),
    temporaryInspectionRevision: mocks.asRef(0),
    temporaryWorkspace: mocks.asRef(mocks.temporaryWorkspace),
    temporaryWorkspaces: mocks.asRef(mocks.temporaryWorkspaces.length === 0 && mocks.temporaryWorkspace !== undefined ? [mocks.temporaryWorkspace] : mocks.temporaryWorkspaces),
  }),
}));

vi.mock('@/features/file-explorer/components/FileExplorer.vue', () => ({
  default: {
    name: 'FileExplorer',
    props: ['entryContextActionLabel', 'root', 'revealPath'],
    template: '<div data-testid="workbench-companion-file-explorer">{{ revealPath }}</div>',
  },
}));

vi.mock('./HizoFSPhysicalInspectorPanel.vue', () => ({
  default: {
    name: 'HizoFSPhysicalInspectorPanel',
    emits: ['namespaceInspected', 'traversalChanged'],
    props: ['authenticatedSession', 'embeddedInWorkbench', 'inspector', 'requestedNamespacePath'],
    template: '<div data-testid="physical-inspector">physical inspector</div>',
  },
}));

vi.mock('./HizoFSBenchmarkPanel.vue', () => ({
  default: {
    name: 'HizoFSBenchmarkPanel',
    template: '<div data-testid="benchmark">benchmark</div>',
  },
}));

function authenticatedInspectionSession(): HizoFSAuthenticatedInspectionSession {
  return {
    inspectContainer: vi.fn(async () => ({}) as never),
    inspectHomeRecord: vi.fn(async () => ({}) as never),
    inspectNamespacePath: vi.fn(async () => ({}) as never),
    inspectRecord: vi.fn(async () => ({}) as never),
    inspectRecordFrame: vi.fn(async () => ({}) as never),
  };
}

function inspector(): HizoFSPhysicalInspectionWorker {
  return {
    inspectContainer: vi.fn(async () => ({}) as never),
    inspectHomeRecord: vi.fn(async () => ({}) as never),
    inspectNamespacePath: vi.fn(async () => ({}) as never),
    inspectRecord: vi.fn(async () => ({}) as never),
    inspectRecordFrame: vi.fn(async () => ({}) as never),
  };
}

describe('HizoFSWorkbenchModal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createTemporary.mockResolvedValue(undefined);
    mocks.destroyTemporary.mockResolvedValue(undefined);
    mocks.generateTemporaryFixture.mockResolvedValue({
      coverage: [],
      manifestPath: '/__hizofs_fixture__/manifest.json',
      rootPath: '/__hizofs_fixture__',
    });
    mocks.refreshActive.mockResolvedValue(undefined);
    mocks.refreshTemporary.mockResolvedValue(undefined);
    mocks.selectTemporary.mockResolvedValue(undefined);
    mocks.temporaryAuthenticatedSession = undefined;
    mocks.temporaryDecryptedRoot = undefined;
    mocks.temporaryWorkspace = undefined;
    mocks.temporaryWorkspaces = [];
    Reflect.deleteProperty(window, 'showDirectoryPicker');
  });

  it('uses an injected one-shot physical Inspector without opening another source', async () => {
    const physicalInspector = inspector();
    const source: HizoFSPhysicalInspectionSource = { open: vi.fn(async () => inspector()) };
    const wrapper = mount(HizoFSWorkbenchModal, {
      props: { physicalInspectionSource: source, physicalInspector },
    });
    await flushPromises();

    expect(wrapper.find('[data-testid="physical-inspector"]').exists()).toBe(true);
    expect(wrapper.getComponent({ name: 'HizoFSPhysicalInspectorPanel' }).props('embeddedInWorkbench')).toBe(true);
    expect(source.open).not.toHaveBeenCalled();
  });

  it('passes an already-authenticated inspection session without opening a passphrase source', async () => {
    const authenticatedSession = authenticatedInspectionSession();
    const source: HizoFSPhysicalInspectionSource = { open: vi.fn(async () => inspector()) };
    const wrapper = mount(HizoFSWorkbenchModal, {
      props: { authenticatedSession, physicalInspectionSource: source },
    });
    await flushPromises();

    const renderedInspector = wrapper.getComponent({ name: 'HizoFSPhysicalInspectorPanel' });
    expect(renderedInspector.props('authenticatedSession')).toStrictEqual(authenticatedSession);
    expect(renderedInspector.props('inspector')).toBeUndefined();
    expect(source.open).not.toHaveBeenCalled();
  });

  it('keeps an explicit decrypted root in the Workbench companion instead of passing it into physical inspection', async () => {
    const physicalInspector = inspector();
    const decryptedRoot = { kind: 'directory', name: 'HizoFS' } as StorageDirectoryHandle;
    const wrapper = mount(HizoFSWorkbenchModal, {
      props: { decryptedRoot, physicalInspector },
    });
    await flushPromises();

    const renderedInspector = wrapper.getComponent({ name: 'HizoFSPhysicalInspectorPanel' });
    expect(renderedInspector.props('requestedNamespacePath')).toBeUndefined();
    expect(wrapper.getComponent({ name: 'FileExplorer' }).props('root')).toStrictEqual({
      handle: decryptedRoot,
      kind: 'storage-directory',
      readOnly: true,
      rootName: 'HizoFS',
    });
  });

  it('adapts the unnamed active logical root to the File Explorer root contract', async () => {
    const decryptedRoot = { kind: 'directory', name: '' } as StorageDirectoryHandle;
    const wrapper = mount(HizoFSWorkbenchModal, {
      props: { decryptedRoot, physicalInspector: inspector() },
    });
    await flushPromises();

    const rootDescriptor = wrapper.getComponent({ name: 'FileExplorer' }).props('root');
    expect(rootDescriptor).toStrictEqual({
      handle: decryptedRoot,
      kind: 'storage-directory',
      readOnly: true,
      rootName: '/',
    });
    expect(() => fileExplorerRootDescriptorSchema.parse(rootDescriptor)).not.toThrow();
  });

  it('shows the decrypted companion and follows an inspected namespace path', async () => {
    const physicalInspector = inspector();
    const decryptedRoot = { kind: 'directory', name: 'HizoFS' } as StorageDirectoryHandle;
    const wrapper = mount(HizoFSWorkbenchModal, {
      props: { decryptedRoot, physicalInspector },
    });
    await flushPromises();

    expect(wrapper.find('[data-testid="hizofs-workbench-companion-explorer"]').exists()).toBe(true);
    expect(wrapper.text()).toContain('read snapshot connected · no persisted path selected');

    const inspectorPanel = wrapper.getComponent({ name: 'HizoFSPhysicalInspectorPanel' });
    inspectorPanel.vm.$emit('traversalChanged', { breadcrumbs: [{ kind: 'namespace', label: 'Decrypted namespace' }, { columnIndex: 0, kind: 'record', label: 'Root Inode Table' }] });
    inspectorPanel.vm.$emit('namespaceInspected', {
      authorityMode: 'active',
      commitSequence: '4',
      path: '/docs',
    });
    await flushPromises();
    expect(wrapper.text()).toContain('following current path /docs · record identity not asserted');
    expect(wrapper.get('[data-testid="hizofs-workbench-breadcrumbs"]').text()).toContain('Decrypted namespace');
    expect(wrapper.get('[data-testid="hizofs-workbench-breadcrumbs"]').text()).toContain('Root Inode Table');
    expect(wrapper.get('[data-testid="hizofs-workbench-breadcrumbs"]').text()).toContain('current logical path /docs');

    const workbenchScroll = wrapper.get('[data-testid="hizofs-workbench-column-scroll"]').element as HTMLElement;
    const recordColumn = document.createElement('div');
    recordColumn.dataset.workbenchTraversalColumnIndex = '0';
    Object.defineProperty(recordColumn, 'offsetLeft', { configurable: true, value: 733 });
    workbenchScroll.appendChild(recordColumn);
    const namespaceColumn = document.createElement('div');
    namespaceColumn.dataset.workbenchInspectorSurface = 'namespace';
    Object.defineProperty(namespaceColumn, 'offsetLeft', { configurable: true, value: 411 });
    workbenchScroll.appendChild(namespaceColumn);

    const traversalBreadcrumbs = wrapper.findAll('[data-testid="hizofs-workbench-traversal-breadcrumb"]');
    expect(traversalBreadcrumbs).toHaveLength(2);
    expect(traversalBreadcrumbs[0]?.attributes('data-breadcrumb-kind')).toBe('namespace');
    expect(traversalBreadcrumbs[1]?.attributes('data-breadcrumb-kind')).toBe('record');
    await traversalBreadcrumbs[1]?.trigger('click');
    await flushPromises();
    expect(workbenchScroll.scrollLeft).toBe(733);

    await wrapper.get('[data-testid="hizofs-workbench-logical-breadcrumb"]').trigger('click');
    await flushPromises();
    expect(workbenchScroll.scrollLeft).toBe(411);

    const explorer = wrapper.getComponent({ name: 'FileExplorer' });
    expect(explorer.props('revealPath')).toBe('/docs');
    expect(explorer.props('entryContextActionLabel')).toBe('Use path in HizoFS Inspector');

    await wrapper.get('[data-testid="hizofs-toggle-companion-follow"]').trigger('click');
    expect(wrapper.text()).toContain('detached · persisted selection /docs');
    expect(wrapper.getComponent({ name: 'FileExplorer' }).props('revealPath')).toBeUndefined();

    explorer.vm.$emit('entry-context-action', {
      entry: {
        canMutate: false,
        canNavigate: true,
        directory: '/docs',
        extension: '.txt',
        handle: undefined,
        kind: 'file',
        lastModified: 120,
        mimeCategory: 'text',
        name: 'notes.txt',
        path: '/docs/notes.txt',
        readOnly: true,
        size: 12,
      },
    });
    await flushPromises();
    expect(wrapper.getComponent({ name: 'HizoFSPhysicalInspectorPanel' }).props('requestedNamespacePath')).toBe('/docs/notes.txt');
  });

  it('does not project a fallback namespace observation onto the current decrypted snapshot', async () => {
    const decryptedRoot = { kind: 'directory', name: 'HizoFS' } as StorageDirectoryHandle;
    const wrapper = mount(HizoFSWorkbenchModal, {
      props: { decryptedRoot, physicalInspector: inspector() },
    });
    await flushPromises();

    wrapper.getComponent({ name: 'HizoFSPhysicalInspectorPanel' }).vm.$emit('namespaceInspected', {
      authorityMode: 'fallback_read_only',
      commitSequence: '3',
      path: '/historical-docs',
    });
    await flushPromises();

    expect(wrapper.get('[data-testid="hizofs-workbench-companion-explorer"]').text()).toContain(
      'fallback read-only /historical-docs · current snapshot detached',
    );
    expect(wrapper.get('[data-testid="hizofs-workbench-logical-breadcrumb"]').text()).toContain(
      'fallback authority logical /historical-docs',
    );
    expect(wrapper.getComponent({ name: 'FileExplorer' }).props('revealPath')).toBeUndefined();
  });

  it('opens the active source lazily and rejects a stale completion after the source changes', async () => {
    let completeFirst: ((value: HizoFSPhysicalInspectionWorker) => void) | undefined;
    const first: HizoFSPhysicalInspectionSource = {
      open: vi.fn(async () => await new Promise<HizoFSPhysicalInspectionWorker>(resolve => {
        completeFirst = resolve;
      })),
    };
    const secondInspector = inspector();
    const second: HizoFSPhysicalInspectionSource = { open: vi.fn(async () => secondInspector) };
    const wrapper = mount(HizoFSWorkbenchModal, { props: { physicalInspectionSource: first } });
    await flushPromises();

    await wrapper.setProps({ physicalInspectionSource: second });
    await flushPromises();
    completeFirst?.(inspector());
    await flushPromises();

    expect(first.open).toHaveBeenCalledOnce();
    expect(second.open).toHaveBeenCalledOnce();
    const renderedInspector = wrapper.getComponent({ name: 'HizoFSPhysicalInspectorPanel' }).props('inspector') as HizoFSPhysicalInspectionWorker;
    expect(renderedInspector.inspectContainer).toBe(secondInspector.inspectContainer);
  });

  it('clears stale inspection output when refresh fails', async () => {
    const source: HizoFSPhysicalInspectionSource = {
      open: vi.fn()
        .mockResolvedValueOnce(inspector())
        .mockRejectedValueOnce(new Error('proof unavailable')),
    };
    const wrapper = mount(HizoFSWorkbenchModal, { props: { physicalInspectionSource: source } });
    await flushPromises();
    expect(wrapper.find('[data-testid="physical-inspector"]').exists()).toBe(true);

    await wrapper.setProps({ physicalInspectionSource: { open: source.open } });
    await flushPromises();

    expect(wrapper.find('[data-testid="physical-inspector"]').exists()).toBe(false);
    expect(wrapper.text()).toContain('proof unavailable');
  });

  it('remounts the physical Inspector when switching between connected filesystem sources', async () => {
    const activeSession = authenticatedInspectionSession();
    const activeRoot = { kind: 'directory', name: '' } as StorageDirectoryHandle;
    const temporarySession = authenticatedInspectionSession();
    const temporaryRoot = { kind: 'directory', name: 'temporary-root' } as StorageDirectoryHandle;
    mocks.temporaryAuthenticatedSession = temporarySession;
    mocks.temporaryDecryptedRoot = temporaryRoot;
    mocks.temporaryWorkspace = {
      status: 'live',
      workspaceId: 'temporary-workspace',
      createdAt: 1,
      fileSystemId: 'temporary-file-system',
      physicalPath: ['naidan-debug-hizofs', 'runtime-temporary-workspace.hizofs'],
    };

    const wrapper = mount(HizoFSWorkbenchModal, {
      props: { authenticatedSession: activeSession, decryptedRoot: activeRoot },
    });
    await flushPromises();
    const activeInspectorElement = wrapper.getComponent({ name: 'HizoFSPhysicalInspectorPanel' }).element;
    expect(wrapper.getComponent({ name: 'FileExplorer' }).props('root')).toStrictEqual(expect.objectContaining({
      handle: activeRoot,
      rootName: '/',
    }));

    await wrapper.get('[data-source-kind="ephemeral_debug_workspace"]').trigger('click');
    await flushPromises();
    const temporaryInspector = wrapper.getComponent({ name: 'HizoFSPhysicalInspectorPanel' });
    expect(temporaryInspector.props('authenticatedSession')).toStrictEqual(temporarySession);
    expect(wrapper.getComponent({ name: 'FileExplorer' }).props('root')).toStrictEqual(expect.objectContaining({
      handle: temporaryRoot,
      rootName: 'temporary-root',
    }));
    expect(temporaryInspector.element).not.toBe(activeInspectorElement);

    const temporaryInspectorElement = temporaryInspector.element;
    await wrapper.get('[data-source-kind="active_encrypted_store"]').trigger('click');
    await flushPromises();
    const nextActiveInspector = wrapper.getComponent({ name: 'HizoFSPhysicalInspectorPanel' });
    expect(nextActiveInspector.props('authenticatedSession')).toStrictEqual(activeSession);
    expect(nextActiveInspector.element).not.toBe(temporaryInspectorElement);
    expect(mocks.refreshActive).toHaveBeenCalledOnce();
    expect(wrapper.getComponent({ name: 'FileExplorer' }).props('root')).toStrictEqual(expect.objectContaining({
      handle: activeRoot,
      rootName: '/',
    }));
  });

  it('fails closed when the active source has no stable decrypted read snapshot', async () => {
    const wrapper = mount(HizoFSWorkbenchModal, {
      props: { authenticatedSession: authenticatedInspectionSession() },
    });
    await flushPromises();

    expect(wrapper.findComponent({ name: 'FileExplorer' }).exists()).toBe(false);
    expect(wrapper.get('[data-testid="hizofs-workbench-companion-body"]').text())
      .toContain('Unlock the active HizoFS and refresh this source');
  });

  it('renders a connected Temporary HizoFS through the same authenticated and decrypted surfaces', async () => {
    const authenticatedSession = authenticatedInspectionSession();
    const decryptedRoot = { kind: 'directory', name: 'temporary-root' } as StorageDirectoryHandle;
    mocks.temporaryAuthenticatedSession = authenticatedSession;
    mocks.temporaryDecryptedRoot = decryptedRoot;
    mocks.temporaryWorkspace = {
      status: 'live',
      workspaceId: 'temporary-workspace',
      createdAt: 1,
      fileSystemId: 'temporary-file-system',
      physicalPath: ['naidan-debug-hizofs', 'runtime-temporary-workspace.hizofs'],
    };

    const wrapper = mount(HizoFSWorkbenchModal);
    await flushPromises();
    await wrapper.get('[data-source-kind="ephemeral_debug_workspace"]').trigger('click');
    await flushPromises();

    expect(wrapper.get('[data-source-kind="active_encrypted_store"]').text()).toContain('unavailable');
    const renderedInspector = wrapper.getComponent({ name: 'HizoFSPhysicalInspectorPanel' });
    expect(renderedInspector.props('authenticatedSession')).toStrictEqual(authenticatedSession);
    expect(wrapper.get('[data-testid="hizofs-workbench-breadcrumbs"]').text()).toContain('Persisted structure');
    renderedInspector.vm.$emit('traversalChanged', { breadcrumbs: [{ kind: 'authority', label: 'Physical authority' }, { columnIndex: 0, kind: 'record', label: 'Active Commit' }] });
    renderedInspector.vm.$emit('namespaceInspected', {
      authorityMode: 'active',
      commitSequence: '4',
      path: '/docs',
    });
    await wrapper.vm.$nextTick();
    const temporaryBreadcrumbs = wrapper.get('[data-testid="hizofs-workbench-breadcrumbs"]').text();
    expect(temporaryBreadcrumbs).toContain('Physical authority');
    expect(temporaryBreadcrumbs).toContain('Active Commit');
    expect(temporaryBreadcrumbs).toContain('current logical path /docs');
    expect(wrapper.find('[data-testid="workbench-companion-file-explorer"]').exists()).toBe(true);
    expect(wrapper.get('[data-testid="hizofs-workbench-companion-explorer"]').text()).toContain('following current path /docs');
    await wrapper.get('[data-testid="hizofs-toggle-companion-follow"]').trigger('click');
    expect(wrapper.get('[data-testid="hizofs-workbench-companion-explorer"]').text()).toContain('Detached');
    expect(wrapper.get('[data-testid="hizofs-workbench-companion-explorer"]').text()).toContain('detached · persisted selection /docs');
    expect(wrapper.getComponent({ name: 'FileExplorer' }).props('revealPath')).toBeUndefined();
    expect(wrapper.getComponent({ name: 'FileExplorer' }).props('root')).toStrictEqual(expect.objectContaining({
      handle: decryptedRoot,
      readOnly: true,
    }));
    expect(wrapper.find('[data-testid="hizofs-destroy-temporary-workspace"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="hizofs-workbench-preview-columns"]').exists()).toBe(false);
  });

  it('runs the purpose-specific comprehensive fixture and reveals its logical root', async () => {
    const authenticatedSession = authenticatedInspectionSession();
    mocks.temporaryAuthenticatedSession = authenticatedSession;
    mocks.temporaryDecryptedRoot = { kind: 'directory', name: 'temporary-root' } as StorageDirectoryHandle;
    mocks.temporaryWorkspace = {
      status: 'live',
      workspaceId: 'temporary-workspace',
      createdAt: 1,
      fileSystemId: 'temporary-file-system',
      physicalPath: ['naidan-debug-hizofs', 'runtime-temporary-workspace.hizofs'],
    };
    mocks.generateTemporaryFixture.mockImplementationOnce(async ({ onProgress }: {
      onProgress: (args: { progress: { phase: 'complete'; completedPhaseCount: number; totalPhaseCount: number; detail: string } }) => void;
      workspaceId: string;
    }) => {
      onProgress({
        progress: {
          phase: 'complete',
          completedPhaseCount: 7,
          totalPhaseCount: 7,
          detail: 'Comprehensive fixture generated',
        },
      });
      return {
        coverage: [{ id: 'sample', path: '/sample', purpose: 'audit', expectedStructures: [] }],
        manifestPath: '/__hizofs_fixture__/manifest.json',
        rootPath: '/__hizofs_fixture__',
      };
    });
    const wrapper = mount(HizoFSWorkbenchModal);
    await flushPromises();
    await wrapper.get('[data-source-kind="ephemeral_debug_workspace"]').trigger('click');

    await wrapper.get('[data-testid="hizofs-generate-temporary-fixture"]').trigger('click');
    await flushPromises();

    expect(mocks.generateTemporaryFixture).toHaveBeenCalledWith(expect.objectContaining({
      onProgress: expect.any(Function),
      workspaceId: 'temporary-workspace',
    }));
    expect(wrapper.get('[data-testid="hizofs-temporary-fixture-progress"]').text()).toContain('complete · 7 / 7');
    expect(wrapper.get('[data-testid="hizofs-temporary-fixture-result"]').text()).toContain('1 audit cases');
    expect(wrapper.getComponent({ name: 'HizoFSPhysicalInspectorPanel' }).props('requestedNamespacePath'))
      .toBe('/__hizofs_fixture__');
  });

  it('lists and selects any document-scoped temporary workspace', async () => {
    const first = {
      status: 'live' as const,
      workspaceId: 'temporary-workspace-a',
      createdAt: 1,
      fileSystemId: 'temporary-file-system-a',
      physicalPath: ['naidan-debug-hizofs', 'runtime-temporary-workspace-a.hizofs'],
    };
    const second = {
      ...first,
      workspaceId: 'temporary-workspace-b',
      fileSystemId: 'temporary-file-system-b',
    };
    mocks.temporaryWorkspace = second;
    mocks.temporaryWorkspaces = [first, second];
    const wrapper = mount(HizoFSWorkbenchModal);
    await flushPromises();

    const workspaceRows = wrapper.findAll('[data-testid="hizofs-temporary-workspace"]');
    expect(workspaceRows).toHaveLength(2);
    expect(wrapper.get('[data-testid="hizofs-temporary-workspace-list"]').text()).toContain('Temporary HizoFS');
    expect(wrapper.get('[data-testid="hizofs-temporary-workspace-list"]').text()).toContain('Available until reload');
    await workspaceRows[0]!.trigger('click');
    await flushPromises();

    expect(mocks.selectTemporary).toHaveBeenCalledWith({ workspaceId: first.workspaceId });
  });

  it('lists stale raw residue without exposing it as an inspectable filesystem', async () => {
    const residue = {
      status: 'stale' as const,
      workspaceId: 'stale-workspace',
      fileSystemId: undefined,
      physicalPath: ['naidan-debug-hizofs', 'runtime-stale-workspace.hizofs'],
    };
    mocks.temporaryWorkspace = residue;
    mocks.temporaryWorkspaces = [residue];
    const wrapper = mount(HizoFSWorkbenchModal);
    await flushPromises();
    await wrapper.get('[data-source-kind="ephemeral_debug_workspace"]').trigger('click');

    expect(wrapper.get('[data-testid="hizofs-temporary-workspace-list"]').text()).toContain('Expired · cleanup only');
    expect(wrapper.find('[data-testid="physical-inspector"]').exists()).toBe(false);
    expect(wrapper.text()).toContain('Expired Temporary HizoFS · cleanup removes remaining raw OPFS data without reopening it.');
    await wrapper.get('[data-testid="hizofs-cleanup-selected-temporary"]').trigger('click');
    await flushPromises();
    expect(mocks.destroyTemporary).toHaveBeenCalledWith({ workspaceId: 'stale-workspace' });
  });

  it('opens an independently selected container through the same physical projection without inventing a decrypted session', async () => {
    const standaloneInspector = inspector();
    const containerRoot = { kind: 'directory', name: 'portable.hizofs' } as FileSystemDirectoryHandle;
    Object.defineProperty(window, 'showDirectoryPicker', {
      configurable: true,
      value: vi.fn(async () => containerRoot),
    });
    mocks.createStandaloneInspector.mockReturnValueOnce(standaloneInspector);
    const wrapper = mount(HizoFSWorkbenchModal);
    await flushPromises();

    await wrapper.get('[data-source-kind="standalone_container"]').trigger('click');
    await wrapper.get('[data-testid="hizofs-open-standalone-container"]').trigger('click');
    await flushPromises();

    expect(mocks.createStandaloneInspector).toHaveBeenCalledWith({ containerRoot });
    expect(wrapper.getComponent({ name: 'HizoFSPhysicalInspectorPanel' }).props('inspector'))
      .toStrictEqual(standaloneInspector);
    expect(wrapper.get('[data-source-kind="standalone_container"]').text()).toContain('ready');
    expect(wrapper.get('[data-testid="hizofs-workbench-companion-explorer"]').text())
      .toContain('decrypted filesystem session unavailable');
    expect(wrapper.findComponent({ name: 'FileExplorer' }).exists()).toBe(false);
  });

  it('keeps benchmark execution independent from physical inspection', async () => {
    const wrapper = mount(HizoFSWorkbenchModal, { props: { physicalInspector: inspector() } });
    await wrapper.get('[data-testid="benchmark-tab"]').trigger('click');
    expect(wrapper.find('[data-testid="benchmark"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="physical-inspector"]').exists()).toBe(false);
  });

  it('closes through the modal close control', async () => {
    const wrapper = mount(HizoFSWorkbenchModal, { props: { physicalInspector: inspector() } });
    await wrapper.get('button[aria-label="Close HizoFS Workbench"]').trigger('click');
    expect(mocks.close).toHaveBeenCalledOnce();
  });
  it('uses the instance column as navigation without fabricating backend results', async () => {
    const wrapper = mount(HizoFSWorkbenchModal, { props: { physicalInspector: inspector() } });
    await flushPromises();

    await wrapper.get('[data-instance-entry-kind="root_namespace"]').trigger('click');
    await flushPromises();
    expect(wrapper.getComponent({ name: 'HizoFSPhysicalInspectorPanel' }).props('requestedNamespacePath')).toBe('/');

    await wrapper.get('[data-testid="hizofs-toggle-companion-explorer"]').trigger('click');
    expect(wrapper.get('[data-testid="hizofs-workbench-companion-explorer"]').attributes('data-expanded')).toBe('false');
    await wrapper.get('[data-instance-entry-kind="derived_filesystem"]').trigger('click');
    await flushPromises();
    expect(wrapper.get('[data-testid="hizofs-workbench-companion-explorer"]').attributes('data-expanded')).toBe('true');
    expect(wrapper.find('[data-testid="hizofs-workbench-companion-explorer"]').text()).toContain('Derived filesystem view');
  });

});
