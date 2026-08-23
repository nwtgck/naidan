import { flushPromises, mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StorageDirectoryHandle } from '@/00-storage/service/storage-file-system/types';
import type { HizoFSPhysicalInspectionSource } from '@/features/debug-hizofs/logic/active-physical-inspection-source';
import type { HizoFSAuthenticatedInspectionSession } from '@/features/debug-hizofs/worker/authenticated-inspection-session';
import type { HizoFSPhysicalInspectionWorker } from '@/features/debug-hizofs/worker/physical-inspection';
import HizoFSWorkbenchModal from './HizoFSWorkbenchModal.vue';

const mocks = vi.hoisted(() => ({
  close: vi.fn(),
  createTemporary: vi.fn(),
  destroyTemporary: vi.fn(),
  temporaryAuthenticatedSession: undefined as HizoFSAuthenticatedInspectionSession | undefined,
  temporaryDecryptedRoot: undefined as StorageDirectoryHandle | undefined,
  temporaryWorkspace: undefined as { readonly status: 'live'; readonly workspaceId: string; readonly createdAt: number; readonly fileSystemId: string; readonly physicalPath: readonly string[] } | undefined,
}));

vi.mock('@/features/debug-hizofs/composables/useDebugHizoFSWorkbench', () => ({
  useDebugHizoFSWorkbench: () => ({
    authenticatedInspectionSession: { value: undefined },
    closeDebugHizoFSWorkbench: mocks.close,
    createTemporaryHizoFSWorkspace: mocks.createTemporary,
    decryptedRoot: { value: undefined },
    destroyTemporaryHizoFSWorkspace: mocks.destroyTemporary,
    physicalInspectionSource: { value: undefined },
    temporaryAuthenticatedInspectionSession: { value: mocks.temporaryAuthenticatedSession },
    temporaryDecryptedRoot: { value: mocks.temporaryDecryptedRoot },
    temporaryWorkspace: { value: mocks.temporaryWorkspace },
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

function inspector(): HizoFSPhysicalInspectionWorker {
  return {
    inspectContainer: vi.fn(),
    inspectHomeRecord: vi.fn(),
    inspectNamespacePath: vi.fn(),
    inspectRecord: vi.fn(),
  } as unknown as HizoFSPhysicalInspectionWorker;
}

describe('HizoFSWorkbenchModal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.temporaryAuthenticatedSession = undefined;
    mocks.temporaryDecryptedRoot = undefined;
    mocks.temporaryWorkspace = undefined;
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
    const authenticatedSession = {
      inspectContainer: vi.fn(),
      inspectHomeRecord: vi.fn(),
      inspectNamespacePath: vi.fn(),
      inspectRecord: vi.fn(),
    } as unknown as HizoFSAuthenticatedInspectionSession;
    const source: HizoFSPhysicalInspectionSource = { open: vi.fn(async () => inspector()) };
    const wrapper = mount(HizoFSWorkbenchModal, {
      props: { authenticatedSession, physicalInspectionSource: source },
    });
    await flushPromises();

    const renderedInspector = wrapper.getComponent({ name: 'HizoFSPhysicalInspectorPanel' });
    expect(renderedInspector.props('authenticatedSession')).toStrictEqual(authenticatedSession);
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
    inspectorPanel.vm.$emit('namespaceInspected', { path: '/docs' });
    await flushPromises();
    expect(wrapper.text()).toContain('following /docs');
    expect(wrapper.get('[data-testid="hizofs-workbench-breadcrumbs"]').text()).toContain('Decrypted namespace');
    expect(wrapper.get('[data-testid="hizofs-workbench-breadcrumbs"]').text()).toContain('Root Inode Table');
    expect(wrapper.get('[data-testid="hizofs-workbench-breadcrumbs"]').text()).toContain('logical /docs');

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
    const activeSession = {
      inspectContainer: vi.fn(),
      inspectHomeRecord: vi.fn(),
      inspectNamespacePath: vi.fn(),
      inspectRecord: vi.fn(),
    } as unknown as HizoFSAuthenticatedInspectionSession;
    const temporarySession = {
      inspectContainer: vi.fn(),
      inspectHomeRecord: vi.fn(),
      inspectNamespacePath: vi.fn(),
      inspectRecord: vi.fn(),
    } as unknown as HizoFSAuthenticatedInspectionSession;
    mocks.temporaryAuthenticatedSession = temporarySession;
    mocks.temporaryDecryptedRoot = { kind: 'directory', name: 'temporary-root' } as StorageDirectoryHandle;
    mocks.temporaryWorkspace = {
      status: 'live',
      workspaceId: 'temporary-workspace',
      createdAt: 1,
      fileSystemId: 'temporary-file-system',
      physicalPath: ['naidan-debug-hizofs', 'runtime-temporary-workspace.hizofs'],
    };

    const wrapper = mount(HizoFSWorkbenchModal, { props: { authenticatedSession: activeSession } });
    await flushPromises();
    const activeInspectorElement = wrapper.getComponent({ name: 'HizoFSPhysicalInspectorPanel' }).element;

    await wrapper.get('[data-source-kind="ephemeral_debug_workspace"]').trigger('click');
    await flushPromises();
    const temporaryInspector = wrapper.getComponent({ name: 'HizoFSPhysicalInspectorPanel' });
    expect(temporaryInspector.props('authenticatedSession')).toStrictEqual(temporarySession);
    expect(temporaryInspector.element).not.toBe(activeInspectorElement);

    const temporaryInspectorElement = temporaryInspector.element;
    await wrapper.get('[data-source-kind="active_encrypted_store"]').trigger('click');
    await flushPromises();
    const nextActiveInspector = wrapper.getComponent({ name: 'HizoFSPhysicalInspectorPanel' });
    expect(nextActiveInspector.props('authenticatedSession')).toStrictEqual(activeSession);
    expect(nextActiveInspector.element).not.toBe(temporaryInspectorElement);
  });

  it('renders a connected Temporary HizoFS through the same authenticated and decrypted surfaces', async () => {
    const authenticatedSession = {
      inspectContainer: vi.fn(),
      inspectHomeRecord: vi.fn(),
      inspectNamespacePath: vi.fn(),
      inspectRecord: vi.fn(),
    } as unknown as HizoFSAuthenticatedInspectionSession;
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
    renderedInspector.vm.$emit('namespaceInspected', { path: '/docs' });
    await wrapper.vm.$nextTick();
    const temporaryBreadcrumbs = wrapper.get('[data-testid="hizofs-workbench-breadcrumbs"]').text();
    expect(temporaryBreadcrumbs).toContain('Physical authority');
    expect(temporaryBreadcrumbs).toContain('Active Commit');
    expect(temporaryBreadcrumbs).toContain('logical /docs');
    expect(wrapper.find('[data-testid="workbench-companion-file-explorer"]').exists()).toBe(true);
    expect(wrapper.get('[data-testid="hizofs-workbench-companion-explorer"]').text()).toContain('following /docs');
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
