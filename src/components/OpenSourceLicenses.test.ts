import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ensureAllStringsForTest } from '@/strings/utils.test-support';
import type { NaidanLicenseCatalog } from '@/01-models/naidan-license';
import OpenSourceLicenses from './OpenSourceLicenses.vue';
import OpenSourceLicenseText from './OpenSourceLicenseText.vue';

const mocks = vi.hoisted(() => ({ createCatalog: vi.fn() }));
vi.mock('virtual:naidan-licenses', () => ({ default: mocks.createCatalog }));

const readLicenseText = vi.fn<NaidanLicenseCatalog['readLicenseText']>();

beforeEach(async () => {
  await ensureAllStringsForTest({ locale: 'en' });
  readLicenseText.mockReset().mockImplementation(({ index }) => {
    switch (index) {
    case 0: return 'First complete license';
    case 1: return 'Second complete license';
    case 2: return null;
    case 3: return '';
    default: throw new RangeError('Unknown fixture license');
    }
  });
  mocks.createCatalog.mockReset().mockImplementation((): NaidanLicenseCatalog => ({
    entries: [
      { name: 'shared-name', version: '1', license: 'MIT' },
      { id: 'native:shared', origin: 'native', name: 'shared-name', version: null, license: null },
      { name: 'missing', version: '1', license: null },
      { name: 'empty', version: '1', license: 'Custom' },
    ],
    readLicenseText,
  }));
});

function createView() {
  const wrapper = mount(OpenSourceLicenses);
  return {
    wrapper,
    async ready() {
      await flushPromises();
      await vi.dynamicImportSettled();
      await flushPromises();
    },
    async toggle({ index, open }: { index: number, open: boolean }) {
      const details = wrapper.findAll<HTMLDetailsElement>('[data-testid="oss-license-details"]')[index];
      if (details === undefined) {
        throw new Error('Missing details element');
      }
      details.element.open = open;
      await details.trigger('toggle');
    },
    [Symbol.dispose]() {
      wrapper.unmount();
    },
  };
}

function getBodyText({ body }: { body: Pick<VueWrapper<InstanceType<typeof OpenSourceLicenseText>>, 'vm'> }) {
  // Nested VTU wrappers use the internal proxy rather than the expose proxy.
  const exposed = body.vm.$.exposed as Pick<InstanceType<typeof OpenSourceLicenseText>, 'TEST_ONLY'> | null;
  if (exposed === null) {
    throw new Error('Expected body test state');
  }
  return exposed.TEST_ONLY.licenseText;
}

describe('OpenSourceLicenses', () => {
  it('loads only metadata and creates no body components while every details element is closed', async () => {
    using view = createView();
    expect(view.wrapper.find('[data-testid="oss-license-loading"]').exists()).toBe(true);
    await view.ready();
    expect(mocks.createCatalog).toHaveBeenCalledTimes(1);
    expect(view.wrapper.find('[data-testid="oss-license-loading"]').exists()).toBe(false);
    expect(view.wrapper.findAll('[data-testid="oss-license-item"]')).toHaveLength(4);
    expect(view.wrapper.findAllComponents(OpenSourceLicenseText)).toHaveLength(0);
    expect(view.wrapper.findAll('[data-testid="oss-license-text"]')).toHaveLength(0);
    expect(view.wrapper.text()).not.toContain('complete license');
    expect(readLicenseText).not.toHaveBeenCalled();
  });

  it('reads only the selected body, keeps simultaneous bodies independent, and does not reread on unrelated renders', async () => {
    using view = createView();
    await view.ready();
    await view.toggle({ index: 1, open: true });
    expect(readLicenseText.mock.calls).toEqual([[{ index: 1 }]]);
    expect(view.wrapper.get('[data-testid="oss-license-text"]').text()).toBe('Second complete license');
    const second = getBodyText({ body: view.wrapper.getComponent(OpenSourceLicenseText) });
    await view.toggle({ index: 0, open: true });
    expect(readLicenseText.mock.calls).toEqual([[{ index: 1 }], [{ index: 0 }]]);
    expect(view.wrapper.findAllComponents(OpenSourceLicenseText)).toHaveLength(2);
    // Repeated native toggle notifications do not rebuild the existing body.
    await view.toggle({ index: 1, open: true });
    expect(readLicenseText).toHaveBeenCalledTimes(2);
    await view.toggle({ index: 1, open: false });
    expect(second.value).toBeUndefined();
    expect(view.wrapper.findAllComponents(OpenSourceLicenseText)).toHaveLength(1);
    expect(view.wrapper.get('[data-testid="oss-license-text"]').text()).toBe('First complete license');
    expect(view.wrapper.text()).not.toContain('Second complete license');
    await view.toggle({ index: 1, open: true });
    expect(readLicenseText.mock.calls).toEqual([[{ index: 1 }], [{ index: 0 }], [{ index: 1 }]]);
  });

  it('explicitly clears body, catalog and expansion references when the entire section is destroyed', async () => {
    using view = createView();
    await view.ready();
    await view.toggle({ index: 0, open: true });
    await view.toggle({ index: 1, open: true });
    const state = view.wrapper.vm.TEST_ONLY;
    const bodies = view.wrapper.findAllComponents(OpenSourceLicenseText).map(body => getBodyText({ body }));
    expect(state.catalog.value).toBeDefined();
    expect(state.openIndexes.value.size).toBe(2);
    view.wrapper.unmount();
    expect(state.catalog.value).toBeUndefined();
    expect(state.openIndexes.value.size).toBe(0);
    expect(bodies.every(body => body.value === undefined)).toBe(true);
    expect(readLicenseText).toHaveBeenCalledTimes(2);
  });

  it('preserves null and empty bodies without treating either as a cache miss', async () => {
    using view = createView();
    await view.ready();
    await view.toggle({ index: 2, open: true });
    await view.toggle({ index: 3, open: true });
    const bodies = view.wrapper.findAllComponents(OpenSourceLicenseText).map(body => getBodyText({ body }));
    expect(bodies.map(body => body.value)).toEqual([null, '']);
    expect(view.wrapper.findAll('[data-testid="oss-license-text"]')).toHaveLength(2);
    await view.toggle({ index: 2, open: true });
    expect(readLicenseText).toHaveBeenCalledTimes(2);
    await view.toggle({ index: 2, open: false });
    expect(bodies[0]?.value).toBeUndefined();
  });

  it('uses the final native open state when toggle events are coalesced', async () => {
    using view = createView();
    await view.ready();
    const details = view.wrapper.get<HTMLDetailsElement>('[data-testid="oss-license-details"]');
    details.element.open = true;
    details.element.open = false;
    await details.trigger('toggle');
    expect(readLicenseText).not.toHaveBeenCalled();
    expect(view.wrapper.vm.TEST_ONLY.openIndexes.value.size).toBe(0);
  });

  it('does not re-evaluate a missing or empty catalog as a reason to load again', async () => {
    mocks.createCatalog.mockReturnValue({ entries: [], readLicenseText });
    using view = createView();
    await view.ready();
    expect(view.wrapper.find('[data-testid="oss-license-loading"]').exists()).toBe(false);
    expect(view.wrapper.findAll('[data-testid="oss-license-item"]')).toHaveLength(0);
    expect(mocks.createCatalog).toHaveBeenCalledTimes(1);
    expect(readLicenseText).not.toHaveBeenCalled();
  });

  it('handles factory failures without retaining a catalog and recovers on a new mount', async () => {
    using error = vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.createCatalog.mockImplementationOnce(() => {
      throw new Error('fixture failure');
    });
    using failed = createView();
    await failed.ready();
    expect(error).toHaveBeenCalledTimes(1);
    expect(failed.wrapper.vm.TEST_ONLY.catalog.value).toBeUndefined();
    expect(failed.wrapper.find('[data-testid="oss-license-loading"]').exists()).toBe(false);
    failed.wrapper.unmount();
    using reopened = createView();
    await reopened.ready();
    expect(reopened.wrapper.findAll('[data-testid="oss-license-item"]')).toHaveLength(4);
    expect(readLicenseText).not.toHaveBeenCalled();
  });
});
