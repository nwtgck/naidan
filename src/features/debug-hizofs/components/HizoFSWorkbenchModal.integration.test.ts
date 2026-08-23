import { flushPromises, mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HizoFSPhysicalInspectionSource } from '@/features/debug-hizofs/logic/active-physical-inspection-source';
import type { HizoFSPhysicalInspectionWorker } from '@/features/debug-hizofs/worker/physical-inspection';
import HizoFSWorkbenchModal from './HizoFSWorkbenchModal.vue';

vi.mock('@/features/file-explorer/components/FileExplorer.vue', () => ({
  default: {
    name: 'FileExplorer',
    props: ['root', 'revealPath'],
    template: '<div data-testid="workbench-companion-file-explorer">{{ revealPath }}</div>',
  },
}));

const mocks = vi.hoisted(() => ({
  close: vi.fn(),
  createTemporary: vi.fn(),
  destroyTemporary: vi.fn(),
}));

vi.mock('@/features/debug-hizofs/composables/useDebugHizoFSWorkbench', () => ({
  useDebugHizoFSWorkbench: () => ({
    authenticatedInspectionSession: { value: undefined },
    closeDebugHizoFSWorkbench: mocks.close,
    createTemporaryHizoFSWorkspace: mocks.createTemporary,
    decryptedRoot: { value: undefined },
    destroyTemporaryHizoFSWorkspace: mocks.destroyTemporary,
    physicalInspectionSource: { value: undefined },
    temporaryAuthenticatedInspectionSession: { value: undefined },
    temporaryDecryptedRoot: { value: undefined },
    temporaryWorkspace: { value: undefined },
  }),
}));

function createInspector(): HizoFSPhysicalInspectionWorker {
  return {
    inspectContainer: vi.fn(async () => ({}) as never),
    inspectHomeRecord: vi.fn(async () => ({}) as never),
    inspectNamespacePath: vi.fn(async () => ({}) as never),
    inspectRecord: vi.fn(async () => ({}) as never),
    inspectRecordFrame: vi.fn(async () => ({}) as never),
  };
}

describe('HizoFSWorkbenchModal integrated tools', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('keeps Benchmark available when opening the Physical Inspector fails', async () => {
    const source: HizoFSPhysicalInspectionSource = {
      open: vi.fn(async () => {
        throw new Error('physical proof unavailable');
      }),
    };
    const wrapper = mount(HizoFSWorkbenchModal, {
      props: { physicalInspectionSource: source },
    });
    await flushPromises();

    expect(wrapper.text()).toContain('Physical Inspector is unavailable');
    expect(wrapper.text()).toContain('physical proof unavailable');
    expect(wrapper.find('[data-testid="hizofs-benchmark-panel"]').exists()).toBe(false);

    await wrapper.get('[data-testid="benchmark-tab"]').trigger('click');
    expect(wrapper.find('[data-testid="hizofs-benchmark-panel"]').exists()).toBe(true);
  });

  it('exposes source and instance columns before backend source composition is complete', async () => {
    const wrapper = mount(HizoFSWorkbenchModal, {
      props: { physicalInspector: createInspector() },
    });
    await flushPromises();

    expect(wrapper.find('[data-testid="hizofs-workbench-sources-column"]').exists()).toBe(true);
    const sourceButtons = wrapper.findAll('[data-testid="hizofs-workbench-source"]');
    expect(sourceButtons.map(button => button.attributes('data-source-kind'))).toStrictEqual([
      'active_encrypted_store',
      'ephemeral_debug_workspace',
      'standalone_container',
    ]);
    expect(wrapper.text()).toContain('Persisted / authenticated');
    expect(wrapper.text()).toContain('Derived / decrypted');
    expect(wrapper.findAll('[data-testid="hizofs-workbench-instance-entry"]')).toHaveLength(5);
    expect(wrapper.text()).toContain('Physical authority');
    expect(wrapper.text()).toContain('Active Commit and roots');
    expect(wrapper.text()).toContain('Root directory / namespace');
    expect(wrapper.text()).toContain('Segments / frames');
    const capabilityText = wrapper.get('[data-testid="hizofs-workbench-source-capabilities"]').text();
    expect(capabilityText).toContain('Physical inspection');
    expect(capabilityText).toContain('Decrypted filesystem');
    expect(capabilityText).toContain('Mutation authority');
    expect(capabilityText).toContain('not exposed');

    await wrapper.get('[data-source-kind="ephemeral_debug_workspace"]').trigger('click');
    expect(wrapper.get('[data-testid="hizofs-workbench-breadcrumbs"]').text()).toContain('Persisted structure');
    expect(wrapper.text()).toContain('Disposable self-contained filesystem for isolated inspection and experiments.');
    expect(wrapper.text()).toContain('Create temporary filesystem');
    expect(wrapper.text()).toContain('Persisted structure');
    expect(wrapper.text()).toContain('Derived filesystem view');
    expect(wrapper.find('[data-testid="hizofs-workbench-preview-columns"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="hizofs-workbench-preview-control-column"]').exists()).toBe(true);
    expect(wrapper.text()).toContain('Inspection controls');
    expect(wrapper.findAll('[data-testid="hizofs-workbench-instance-entry"]')).toHaveLength(4);
    expect(wrapper.text()).toContain('Persisted structure · Authority copies');
    expect(wrapper.text()).toContain('physical persisted records · backend connection pending');
    expect(wrapper.text()).toContain('Reference destination');
    expect(wrapper.text()).toContain('Exact decoded representation');
    const previewRecordText = wrapper.get('[data-testid="hizofs-workbench-preview-record-column"]').text();
    expect(previewRecordText.indexOf('Overview')).toBeLessThan(previewRecordText.indexOf('Persisted references'));
    expect(previewRecordText.indexOf('Persisted references')).toBeLessThan(previewRecordText.indexOf('Exact decoded representation'));
    expect(previewRecordText.indexOf('Exact decoded representation')).toBeLessThan(previewRecordText.indexOf('Authenticated plaintext preview'));
    expect(previewRecordText.indexOf('Authenticated plaintext preview')).toBeLessThan(previewRecordText.indexOf('Binary representation'));
    expect(wrapper.get('[data-testid="hizofs-workbench-companion-explorer"]').text()).toContain('temporary filesystem not created');
    expect(wrapper.get('[data-testid="hizofs-workbench-companion-explorer"]').text()).toContain('Create first');
    expect(wrapper.find('[data-testid="hizofs-physical-inspector-passphrase"]').exists()).toBe(false);

    await wrapper.get('[data-source-kind="standalone_container"]').trigger('click');
    expect(wrapper.get('[data-testid="hizofs-workbench-breadcrumbs"]').text()).toContain('Persisted structure');

    await wrapper.get('[data-source-kind="active_encrypted_store"]').trigger('click');
    expect(wrapper.find('[data-testid="hizofs-physical-inspector-passphrase"]').exists()).toBe(true);
  });

  it('keeps Physical Inspector and Benchmark as switchable Workbench views without a nested portable modal', async () => {
    const wrapper = mount(HizoFSWorkbenchModal, {
      props: { physicalInspector: createInspector() },
    });
    await flushPromises();

    expect(wrapper.text()).toContain('HizoFS Workbench');
    expect(wrapper.text()).toContain('Physical Inspector');
    expect(wrapper.text()).toContain('Benchmark');
    expect(wrapper.text()).not.toContain('Portable HizoFS Inspector');
    expect(wrapper.find('[data-testid="hizofs-physical-inspector-passphrase"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="hizofs-workbench-column-scroll"]').exists()).toBe(true);
    expect(wrapper.get('[data-testid="hizofs-physical-inspector-column-scroll"]').attributes('data-embedded-columns')).toBe('true');
    expect(wrapper.find('[data-testid="hizofs-benchmark-panel"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="hizofs-physical-inspector-close"]').exists()).toBe(false);

    await wrapper.get('[data-testid="benchmark-tab"]').trigger('click');
    expect(wrapper.find('[data-testid="hizofs-benchmark-panel"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="hizofs-physical-inspector-passphrase"]').exists()).toBe(false);

    await wrapper.get('[data-testid="physical-tab"]').trigger('click');
    expect(wrapper.find('[data-testid="hizofs-physical-inspector-passphrase"]').exists()).toBe(true);

    await wrapper.get('button[aria-label="Close HizoFS Workbench"]').trigger('click');
    expect(mocks.close).toHaveBeenCalledOnce();
  });
});
