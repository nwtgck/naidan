import fs from 'node:fs';
import path from 'node:path';
import { flushPromises, mount } from '@vue/test-utils';
import { parse } from '@vue/compiler-sfc';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ensureAllStringsForTest } from '@/strings/utils.test-support';

import AboutTab from './AboutTab.vue';

beforeEach(async () => {
  await ensureAllStringsForTest({ locale: 'en' });
});

vi.mock('virtual:naidan-licenses', () => ({
  default: () => ({
    entries: [{
      name: 'shared-license-package',
      version: '1.2.3',
      license: 'MIT',
    }, {
      id: 'native:llama-cpp:shared',
      origin: 'llama.cpp',
      name: 'shared-license-package',
      version: null,
      license: null,
    }, {
      id: 'native:stable-diffusion-cpp:shared',
      origin: 'stable-diffusion.cpp',
      name: 'shared-license-package',
      version: null,
      license: null,
    }],
    readLicenseText: ({ index }: { index: number }) => ['Shared license text', 'Native shared notice', 'Image shared notice'][index] ?? null,
  }),
}));

async function mountAboutTab({ isStandalone }: { isStandalone: boolean }) {
  vi.stubGlobal('__BUILD_MODE_IS_STANDALONE__', isStandalone);
  vi.stubGlobal('__APP_VERSION__', 'test-version');
  const wrapper = mount(AboutTab, {
    props: { visibility: 'visible' },
    global: { stubs: { Logo: true } },
  });
  await flushPromises();
  await vi.dynamicImportSettled();
  await flushPromises();
  return wrapper;
}

describe('AboutTab licenses', () => {
  beforeEach(() => {
    vi.stubGlobal('__BUILD_MODE_IS_STANDALONE__', false);
    vi.stubGlobal('__APP_VERSION__', 'test-version');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each([
    { buildMode: 'hosted', isStandalone: false },
    { buildMode: 'standalone', isStandalone: true },
  ])('renders the same dynamically imported license list in $buildMode mode', async ({ isStandalone }) => {
    const wrapper = await mountAboutTab({ isStandalone });
    using _cleanup = {
      [Symbol.dispose]() {
        wrapper.unmount();
      },
    };
    const licenseList = wrapper.get('[data-testid="oss-license-list"]');
    expect(licenseList.text()).toContain('shared-license-package');
    expect(licenseList.text()).toContain('1.2.3');
    expect(licenseList.text()).toContain('MIT');
    expect(wrapper.findAll('[data-testid="oss-license-item"]')).toHaveLength(3);
    expect(licenseList.text()).toContain('llama.cpp');
    expect(licenseList.text()).toContain('stable-diffusion.cpp');
    expect(wrapper.findAll('[data-testid="oss-license-text"]')).toHaveLength(0);
    for (const details of wrapper.findAll<HTMLDetailsElement>('[data-testid="oss-license-details"]')) {
      details.element.open = true;
      await details.trigger('toggle');
    }
    expect(licenseList.text()).toContain('Native shared notice');
    expect(licenseList.text()).toContain('Image shared notice');
    expect(licenseList.text()).not.toContain('vnull');
    expect(wrapper.text()).not.toContain('THIRD_PARTY_LICENSES.txt');
    expect(wrapper.text()).not.toContain('Offline License Information');
  });

  it('keeps license data behind a dynamic generated license import', () => {
    const source = fs.readFileSync(path.resolve(process.cwd(), 'src/components/OpenSourceLicenses.vue'), 'utf8');
    const { descriptor } = parse(source, { filename: 'OpenSourceLicenses.vue' });
    const scriptSetup = descriptor.scriptSetup?.content;
    if (scriptSetup === undefined) {
      throw new Error('Expected OpenSourceLicenses.vue to use script setup.');
    }
    expect(scriptSetup).toMatch(/import type \{ NaidanLicenseCatalog \} from ['"]@\/01-models\/naidan-license['"]/u);
    expect(scriptSetup).not.toContain("import type { NaidanLicenseCatalog } from 'virtual:naidan-licenses'");
    expect(scriptSetup).toContain("await import('virtual:naidan-licenses')");
    expect(scriptSetup).not.toMatch(/^import(?! type).*virtual:naidan-licenses/m);
  });

  it('destroys only the license section while About is hidden and recreates it collapsed on return', async () => {
    const wrapper = await mountAboutTab({ isStandalone: false });
    using _cleanup = {
      [Symbol.dispose]() {
        wrapper.unmount();
      },
    };
    const details = wrapper.get<HTMLDetailsElement>('[data-testid="oss-license-details"]');
    details.element.open = true;
    await details.trigger('toggle');
    expect(wrapper.find('[data-testid="oss-license-text"]').exists()).toBe(true);
    await wrapper.setProps({ visibility: 'hidden' });
    expect(wrapper.find('[data-testid="about-section"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="oss-license-list"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="oss-license-text"]').exists()).toBe(false);
    await wrapper.setProps({ visibility: 'visible' });
    await flushPromises();
    await vi.dynamicImportSettled();
    await flushPromises();
    expect(wrapper.findAll('[data-testid="oss-license-item"]')).toHaveLength(3);
    expect(wrapper.find('[data-testid="oss-license-text"]').exists()).toBe(false);
    expect(wrapper.findAll<HTMLDetailsElement>('[data-testid="oss-license-details"]').every(item => !item.element.open)).toBe(true);
  });
});
