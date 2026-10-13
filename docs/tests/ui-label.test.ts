import { describe, expect, it } from 'vitest';
import { createSSRApp, h } from 'vue';
import { renderToString } from '@vue/server-renderer';
import UiText from '../site/UiText.vue';
import OllamaGuide from '../pages/models/ollama.vue';
import { strings as en } from '../strings/models/ollama/en';
import { strings as ja } from '../strings/models/ollama/ja';
import { parsePage } from './site.test-support';
import type { CommonMessages } from '../site/messages';

describe('inline UI names in guide prose', () => {
  it('renders only explicit full-width annotations as inert text in SSR', async () => {
    const source = 'Open ［Model Selection］ at /docs/a[b] with [array] and <script>alert(1)</script>.';
    const html = await renderToString(createSSRApp({ render: () => h('p', h(UiText, { text: source })) }));
    using page = parsePage({ html });
    const label = page.document.querySelector('.ui-label');
    expect(label?.textContent).toBe('Model Selection');
    expect(label?.closest('button, a, kbd')).toBeNull();
    expect(page.document.querySelector('script')).toBeNull();
    expect(page.document.querySelector('p')?.textContent).toBe('Open Model Selection at /docs/a[b] with [array] and <script>alert(1)</script>.');
  });

  it.each([{ locale: 'ja', strings: ja, expected: 'モデル選択' }, { locale: 'en', strings: en, expected: 'Model Selection' }] as const)(
    'renders localized control names in the $locale Ollama guide without source brackets',
    async ({ locale, strings, expected }) => {
      const html = await renderToString(createSSRApp({ render: () => h(OllamaGuide, { s: strings, locale, common: {} as CommonMessages }) }));
      using page = parsePage({ html });
      const article = page.document.querySelector('[data-testid="docs-models-ollama"]');
      expect([...article?.querySelectorAll('.ui-label') ?? []].some(node => node.textContent === expected)).toBe(true);
      expect(article?.textContent).not.toContain('［');
      expect(article?.textContent).not.toContain('］');
      expect(article?.querySelector('h2')?.textContent).not.toContain('［');
      expect(article?.textContent).toContain('http://localhost:11434');
    },
  );
});
