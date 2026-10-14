import { describe, expect, it } from 'vitest';
import { createSSRApp, h } from 'vue';
import { renderToString } from '@vue/server-renderer';
import UiLabel from '../components/UiLabel.vue';
import OllamaGuide from '../pages/endpoint-type-ollama/index.vue';
import { messages as en } from '../pages/endpoint-type-ollama/messages/en';
import { messages as ja } from '../pages/endpoint-type-ollama/messages/ja';
import { messages as commonEn } from '../messages/common/en';
import { messages as commonJa } from '../messages/common/ja';
import { parsePage } from './site.test-support';

describe('inline UI names in guide prose', () => {
  it('renders only explicit UI labels as inert text in SSR', async () => {
    const html = await renderToString(createSSRApp({
      render: () => h('p', [
        'Open ［literal brackets］ and ',
        h(UiLabel, { text: 'Model Selection' }),
        ' at /docs/a[b] with [array] and <script>alert(1)</script>.',
      ]),
    }));
    using page = parsePage({ html });
    const label = page.document.querySelector('.ui-label');
    expect(label?.textContent).toBe('Model Selection');
    expect(label?.closest('button, a, kbd')).toBeNull();
    expect(page.document.querySelector('script')).toBeNull();
    expect(page.document.querySelector('p')?.textContent).toBe('Open ［literal brackets］ and Model Selection at /docs/a[b] with [array] and <script>alert(1)</script>.');
  });

  it('escapes the label itself instead of interpreting it as markup', async () => {
    const html = await renderToString(createSSRApp({ render: () => h(UiLabel, { text: '<script>alert(1)</script>' }) }));
    using page = parsePage({ html });
    expect(page.document.querySelector('script')).toBeNull();
    expect(page.document.querySelector('.ui-label')?.textContent).toBe('<script>alert(1)</script>');
  });

  it.each([{ locale: 'ja', strings: ja, common: commonJa, expected: 'モデル選択' }, { locale: 'en', strings: en, common: commonEn, expected: 'Model Selection' }] as const)(
    'renders localized control names in the $locale Ollama guide without source brackets',
    async ({ locale, strings, common, expected }) => {
      const html = await renderToString(createSSRApp({ render: () => h(OllamaGuide, { s: strings, locale, common }) }));
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
