import { describe, expect, it } from 'vitest';
import { createSSRApp, h } from 'vue';
import { renderToString } from '@vue/server-renderer';
import StorageChoiceDemo from '../components/demos/StorageChoiceDemo.vue';
import { messages as homeEn } from '../pages/index/messages/en';
import { messages as homeJa } from '../pages/index/messages/ja';
import { parsePage } from './site.test-support';

describe('storage choice replica', () => {
  it.each([
    { locale: 'en', s: homeEn },
    { locale: 'ja', s: homeJa },
  ])('renders every $locale storage choice in static HTML', async ({ s }) => {
    const html = await renderToString(createSSRApp({ render: () => h(StorageChoiceDemo, { messages: s }) }));
    using page = parsePage({ html });
    const demo = page.document.querySelector('[data-testid="storage-choice-demo"]');

    expect(demo?.getAttribute('data-docs-animation')).toBe('storage-choice');
    expect(demo?.textContent).toContain(s.storage_management);
    expect(demo?.textContent).toContain(s.active_storage_provider);

    for (const provider of ['opfs', 'local', 'memory'] as const) {
      const option = demo?.querySelector(`[data-testid="storage-choice-${provider}"]`);
      const expected = {
        opfs: [s.origin_private_file_system, s.origin_private_file_system_description],
        local: [s.local_storage, s.local_storage_description],
        memory: [s.ephemeral_storage, s.ephemeral_storage_description],
      }[provider];
      for (const text of expected) {
        expect(option?.textContent).toContain(text);
      }
    }

    expect(demo?.querySelector('button, input, a, script')).toBeNull();
  });
});
