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

function createInspector(): HizoFSPhysicalInspectionWorker {
  return {
    inspectContainer: vi.fn(),
    inspectHomeRecord: vi.fn(),
    inspectNamespacePath: vi.fn(),
    inspectRecord: vi.fn(),
  } as unknown as HizoFSPhysicalInspectionWorker;
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
