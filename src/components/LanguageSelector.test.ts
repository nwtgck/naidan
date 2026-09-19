import { mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ensureAllStringsForTest } from '@/strings/test-utils';

import type { UiLocale } from '@/01-models/ui-locale';
import { STANDALONE_PACKAGE_LOCALE_META_NAME } from '@/features/file-protocol-standalone/logic/package-locale';
import LanguageSelector from './LanguageSelector.vue';

beforeEach(async () => {
  await ensureAllStringsForTest({ locale: 'en' });
});

const mocks = vi.hoisted(() => ({
  setLocale: vi.fn(async (_args: { locale: UiLocale }) => {}),
}));

vi.mock('@/composables/useSettings', () => ({
  useSettings: () => ({
    setLocale: mocks.setLocale,
  }),
}));

function addPackageLocaleMeta({ locale }: {
  locale: UiLocale;
}): HTMLMetaElement {
  const meta = document.createElement('meta');
  meta.name = STANDALONE_PACKAGE_LOCALE_META_NAME;
  meta.content = locale;
  document.head.append(meta);
  return meta;
}

beforeEach(() => {
  mocks.setLocale.mockClear();
});

afterEach(() => {
  document.querySelectorAll(`meta[name=${JSON.stringify(STANDALONE_PACKAGE_LOCALE_META_NAME)}]`).forEach(meta => meta.remove());
});

describe('LanguageSelector', () => {
  it('renders in the universal package', () => {
    const wrapper = mount(LanguageSelector);
    expect(wrapper.find('[data-testid="language-selector"]').exists()).toBe(true);
  });

  it('allows locale changes in the universal package', async () => {
    const wrapper = mount(LanguageSelector);
    await wrapper.get('[data-testid="language-selector-toggle"]').trigger('click');

    const englishOption = wrapper.findAll('[data-testid="language-selector-option"]')
      .find(option => option.text().includes('English'));
    expect(englishOption).toBeDefined();
    await englishOption!.trigger('click');

    expect(mocks.setLocale).toHaveBeenCalledWith({ locale: 'en' });
  });

  it('keeps the selector visible but disables locale changes when the package constrains the runtime', async () => {
    addPackageLocaleMeta({ locale: 'zh-Hans' });
    const wrapper = mount(LanguageSelector);

    expect(wrapper.find('[data-testid="language-selector"]').exists()).toBe(true);
    expect(wrapper.get('[data-testid="language-selector-toggle"]').text()).toContain('简体中文');

    await wrapper.get('[data-testid="language-selector-toggle"]').trigger('click');

    const options = wrapper.findAll('[data-testid="language-selector-option"]');
    expect(options).toHaveLength(7);
    expect(options.every(option => option.attributes('disabled') !== undefined)).toBe(true);

    await options[1]!.trigger('click');
    expect(mocks.setLocale).not.toHaveBeenCalled();

    const exposed = wrapper.vm as unknown as {
      TEST_ONLY: {
        changeLocale: ({ locale }: { locale: UiLocale }) => Promise<void>;
      };
    };
    await exposed.TEST_ONLY.changeLocale({ locale: 'en' });
    expect(mocks.setLocale).not.toHaveBeenCalled();
  });

  it('sorts languages by their displayed labels', async () => {
    const wrapper = mount(LanguageSelector);

    await wrapper.get('button').trigger('click');

    expect(wrapper.findAll('[role="menuitem"]').map(item => item.text())).toEqual([
      'Deutsch',
      'English',
      'Español',
      'Português (Brasil)',
      '日本語',
      '简体中文',
      '한국어',
    ]);
  });
});
