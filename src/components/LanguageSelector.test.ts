import { mount } from '@vue/test-utils';
import { afterEach, describe, expect, it } from 'vitest';

import type { UiLocale } from '@/01-models/ui-locale';
import { STANDALONE_PACKAGE_LOCALE_META_NAME } from '@/features/file-protocol-standalone/logic/package-locale';
import LanguageSelector from './LanguageSelector.vue';

function addPackageLocaleMeta({ locale }: {
  locale: UiLocale;
}): HTMLMetaElement {
  const meta = document.createElement('meta');
  meta.name = STANDALONE_PACKAGE_LOCALE_META_NAME;
  meta.content = locale;
  document.head.append(meta);
  return meta;
}

afterEach(() => {
  document.querySelectorAll(`meta[name=${JSON.stringify(STANDALONE_PACKAGE_LOCALE_META_NAME)}]`).forEach(meta => meta.remove());
});

describe('LanguageSelector', () => {
  it('renders in the universal package', () => {
    const wrapper = mount(LanguageSelector);
    expect(wrapper.find('[data-testid="language-selector"]').exists()).toBe(true);
  });

  it('is hidden when a standalone package locale constrains the runtime', () => {
    addPackageLocaleMeta({ locale: 'zh-Hans' });
    const wrapper = mount(LanguageSelector);
    expect(wrapper.find('[data-testid="language-selector"]').exists()).toBe(false);
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
