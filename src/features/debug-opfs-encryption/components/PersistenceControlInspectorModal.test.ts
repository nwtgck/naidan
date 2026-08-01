import { flushPromises, mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { parsePortableFileSystemId } from '@/00-storage/service/hizofs/compatibility';
import type { NaidanPersistenceControlV1 } from '@/00-storage/service/naidan-persistence-control/00-format';
import type { PersistenceControlInspection } from '@/00-storage/service/naidan-persistence-control/inspection/persistence-control-inspection-types';
import type { PersistenceControlInspectionSource } from '@/features/debug-opfs-encryption/logic/persistence-control-inspection-source';
import PersistenceControlInspectorModal from './PersistenceControlInspectorModal.vue';

const mocks = vi.hoisted(() => ({
  closeInspector: vi.fn(),
  openFileExplorer: vi.fn(),
  openHizoFSWorkbench: vi.fn(),
}));

vi.mock('@/features/debug-opfs-encryption/composables/usePersistenceControlInspector', () => ({
  usePersistenceControlInspector: () => ({
    closePersistenceControlInspector: mocks.closeInspector,
    persistenceControlInspectionSource: { value: undefined },
  }),
}));

vi.mock('@/features/debug-hizofs/composables/useDebugHizoFSWorkbench', () => ({
  useDebugHizoFSWorkbench: () => ({
    openDebugHizoFSWorkbench: mocks.openHizoFSWorkbench,
  }),
}));

vi.mock('@/features/file-explorer/composables/useFileExplorerModal', () => ({
  useFileExplorerModal: () => ({ openFileExplorer: mocks.openFileExplorer }),
}));

vi.mock('./PersistenceControlInspectionPanel.vue', () => ({
  default: {
    name: 'PersistenceControlInspectionPanel',
    props: ['inspection'],
    template: '<div data-testid="persistence-control-panel">inspection</div>',
  },
}));

const ACTIVE_FILE_SYSTEM_ID = parsePortableFileSystemId({ value: '0123456789_ABCDEFGHIJ' });

function inspected({ sequence = 1 }: { sequence?: number } = {}): PersistenceControlInspection {
  const control: NaidanPersistenceControlV1 = {
    copy: 0,
    format: 'naidan-persistence-control',
    formatVersion: 1,
    mode: { activeFileSystemId: ACTIVE_FILE_SYSTEM_ID, type: 'hizofs' },
    protection: {
      authenticationFileSystemId: ACTIVE_FILE_SYSTEM_ID,
      authenticatorTag: 'persisted-authenticator-tag',
      nonce: 'persisted-nonce',
      type: 'hizofs_aes_256_gcm',
    },
    retiredFileSystemIds: [],
    sequence,
  };
  return {
    copies: [
      {
        authenticationFileSystemId: ACTIVE_FILE_SYSTEM_ID,
        control,
        copy: 0,
        mode: { activeFileSystemId: ACTIVE_FILE_SYSTEM_ID, type: 'hizofs' },
        physicalPath: ['persistence-control', 'state-0.json'],
        protection: 'hizofs_aes_256_gcm',
        reason: undefined,
        retiredFileSystemIds: [],
        selected: true,
        sequence,
        state: 'proof_valid',
      },
      {
        authenticationFileSystemId: undefined,
        control: undefined,
        copy: 1,
        mode: undefined,
        physicalPath: ['hizofs', 'state-1.json'],
        protection: undefined,
        reason: 'missing',
        retiredFileSystemIds: [],
        selected: false,
        sequence: undefined,
        state: 'structurally_invalid',
      },
    ],
    observedSequences: [sequence, undefined],
    selection: { copy: 0, redundancy: 'degraded', sequence, state: 'selected' },
  };
}

describe('PersistenceControlInspectorModal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    document.body.innerHTML = '';
  });

  it('renders detached Persistence Control evidence from a one-shot source', async () => {
    const source: PersistenceControlInspectionSource = {
      inspectPersistenceControl: vi.fn(async () => inspected()),
    };
    const wrapper = mount(PersistenceControlInspectorModal, {
      attachTo: document.body,
      props: { persistenceControlInspectionSource: source },
    });
    await flushPromises();

    expect(source.inspectPersistenceControl).toHaveBeenCalledOnce();
    expect(document.body.querySelector('[data-testid="persistence-control-panel"]')).not.toBeNull();
    wrapper.unmount();
  });

  it('rejects a stale completion after the source changes', async () => {
    let completeFirst: ((inspection: PersistenceControlInspection) => void) | undefined;
    const first: PersistenceControlInspectionSource = {
      inspectPersistenceControl: vi.fn(async () => await new Promise<PersistenceControlInspection>(resolve => {
        completeFirst = resolve;
      })),
    };
    const secondInspection = inspected({ sequence: 2 });
    const second: PersistenceControlInspectionSource = {
      inspectPersistenceControl: vi.fn(async () => secondInspection),
    };
    const wrapper = mount(PersistenceControlInspectorModal, {
      attachTo: document.body,
      props: { persistenceControlInspectionSource: first },
    });
    await flushPromises();

    await wrapper.setProps({ persistenceControlInspectionSource: second });
    await flushPromises();
    completeFirst?.(inspected({ sequence: 99 }));
    await flushPromises();

    const rendered = wrapper.getComponent({ name: 'PersistenceControlInspectionPanel' }).props('inspection') as PersistenceControlInspection;
    expect(rendered.observedSequences).toEqual([2, undefined]);
    wrapper.unmount();
  });

  it('clears stale proof evidence when refresh fails', async () => {
    const inspect = vi.fn<() => Promise<PersistenceControlInspection>>()
      .mockResolvedValueOnce(inspected())
      .mockRejectedValueOnce(new Error('proof authority unavailable'));
    const wrapper = mount(PersistenceControlInspectorModal, {
      attachTo: document.body,
      props: { persistenceControlInspectionSource: { inspectPersistenceControl: inspect } },
    });
    await flushPromises();
    expect(document.body.querySelector('[data-testid="persistence-control-panel"]')).not.toBeNull();

    await wrapper.setProps({
      persistenceControlInspectionSource: { inspectPersistenceControl: inspect },
    });
    await flushPromises();

    expect(document.body.querySelector('[data-testid="persistence-control-panel"]')).toBeNull();
    expect(document.body.querySelector('[data-testid="persistence-control-inspection-error"]')?.textContent)
      .toContain('proof authority unavailable');
    wrapper.unmount();
  });

  it('does not invent a production source when none is connected', async () => {
    const wrapper = mount(PersistenceControlInspectorModal, { attachTo: document.body });
    await flushPromises();
    expect(document.body.querySelector('[data-testid="persistence-control-source-unavailable"]')).not.toBeNull();
    wrapper.unmount();
  });

  it('opens raw OPFS and the HizoFS Workbench through separate controls', async () => {
    const wrapper = mount(PersistenceControlInspectorModal, { attachTo: document.body });
    await flushPromises();

    document.body.querySelector<HTMLButtonElement>('[data-testid="persistence-control-open-raw"]')?.click();
    expect(mocks.openFileExplorer).toHaveBeenCalledWith({ options: { kind: 'opfs-root' } });

    document.body.querySelector<HTMLButtonElement>('[data-testid="persistence-control-open-hizofs"]')?.click();
    expect(mocks.openHizoFSWorkbench).toHaveBeenCalledOnce();
    expect(mocks.closeInspector).toHaveBeenCalledTimes(2);
    wrapper.unmount();
  });
});
