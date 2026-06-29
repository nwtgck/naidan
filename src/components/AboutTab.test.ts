import fs from 'node:fs';
import path from 'node:path';
import { flushPromises, mount } from '@vue/test-utils';
import { parse } from '@vue/compiler-sfc';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import AboutTab from './AboutTab.vue';

vi.mock('virtual:naidan-licenses', () => ({
  default: [{
    name: 'shared-license-package',
    version: '1.2.3',
    license: 'MIT',
    licenseText: 'Shared license text',
  }],
}));

async function mountAboutTab({ isStandalone }: { isStandalone: boolean }) {
  vi.stubGlobal('__BUILD_MODE_IS_STANDALONE__', isStandalone);
  vi.stubGlobal('__APP_VERSION__', 'test-version');
  const wrapper = mount(AboutTab, {
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
    const licenseList = wrapper.get('[data-testid="oss-license-list"]');
    expect(licenseList.text()).toContain('shared-license-package');
    expect(licenseList.text()).toContain('1.2.3');
    expect(licenseList.text()).toContain('MIT');
    expect(wrapper.findAll('[data-testid="oss-license-item"]')).toHaveLength(1);
    expect(wrapper.text()).not.toContain('THIRD_PARTY_LICENSES.txt');
    expect(wrapper.text()).not.toContain('Offline License Information');
  });

  it('keeps license data behind a dynamic generated license import', () => {
    const source = fs.readFileSync(path.resolve(process.cwd(), 'src/components/AboutTab.vue'), 'utf8');
    const { descriptor } = parse(source, { filename: 'AboutTab.vue' });
    const scriptSetup = descriptor.scriptSetup?.content;
    if (scriptSetup === undefined) throw new Error('Expected AboutTab.vue to use script setup.');
    expect(scriptSetup).toMatch(/import type \{ NaidanLicense \} from ['"]@\/01-models\/naidan-license['"]/u);
    expect(scriptSetup).not.toContain("import type { NaidanLicense } from 'virtual:naidan-licenses'");
    expect(scriptSetup).toContain("await import('virtual:naidan-licenses')");
    expect(scriptSetup).not.toMatch(/^import(?! type).*virtual:naidan-licenses/m);
  });
});
