import { flushPromises, mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HizoFSPhysicalInspectionSource } from '@/features/debug-hizofs/logic/active-physical-inspection-source';
import type { HizoFSPhysicalInspectionWorker } from '@/features/debug-hizofs/worker/physical-inspection';
import HizoFSWorkbenchModal from './HizoFSWorkbenchModal.vue';

const mocks = vi.hoisted(() => ({
  close: vi.fn(),
}));

vi.mock('@/features/debug-hizofs/composables/useDebugHizoFSWorkbench', () => ({
  useDebugHizoFSWorkbench: () => ({
    closeDebugHizoFSWorkbench: mocks.close,
    physicalInspectionSource: { value: undefined },
  }),
}));

vi.mock('./HizoFSPhysicalInspectorPanel.vue', () => ({
  default: {
    name: 'HizoFSPhysicalInspectorPanel',
    props: ['inspector'],
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
  });

  it('uses an injected one-shot physical Inspector without opening another source', async () => {
    const physicalInspector = inspector();
    const source: HizoFSPhysicalInspectionSource = { open: vi.fn(async () => inspector()) };
    const wrapper = mount(HizoFSWorkbenchModal, {
      props: { physicalInspectionSource: source, physicalInspector },
    });
    await flushPromises();

    expect(wrapper.find('[data-testid="physical-inspector"]').exists()).toBe(true);
    expect(source.open).not.toHaveBeenCalled();
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
});
