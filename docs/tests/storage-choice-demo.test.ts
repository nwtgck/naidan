import { describe, expect, it } from 'vitest';
import { createSSRApp, h } from 'vue';
import { renderToString } from '@vue/server-renderer';
import StorageChoiceDemo from '../site/demos/StorageChoiceDemo.vue';
import { storageChoiceDemoEn } from '../pages/index/strings/storage-demo/en';
import { storageChoiceDemoJa } from '../pages/index/strings/storage-demo/ja';
import { parsePage } from './site.test-support';

describe('storage choice replica', () => {
  it.each([
    { locale: 'en', copy: storageChoiceDemoEn },
    { locale: 'ja', copy: storageChoiceDemoJa },
  ])('renders every $locale storage choice in static HTML', async ({ copy }) => {
    const html = await renderToString(createSSRApp({ render: () => h(StorageChoiceDemo, { copy }) }));
    using page = parsePage({ html });
    const demo = page.document.querySelector('[data-testid="storage-choice-demo"]');

    expect(demo?.getAttribute('data-docs-animation')).toBe('storage-choice');
    expect(demo?.textContent).toContain(copy.sectionTitle);
    expect(demo?.textContent).toContain(copy.fieldLabel);

    for (const provider of ['opfs', 'local', 'memory'] as const) {
      const option = demo?.querySelector(`[data-testid="storage-choice-${provider}"]`);
      expect(option?.textContent).toContain(copy.options[provider].title);
      expect(option?.textContent).toContain(copy.options[provider].description);
    }

    expect(demo?.querySelector('button, input, a, script')).toBeNull();
  });
});
