import { describe, expect, it } from 'vitest';
import { createSSRApp, h } from 'vue';
import { renderToString } from '@vue/server-renderer';
import BrowserMock from '../site/BrowserMock.vue';
import { strings as homeEn } from '../strings/index/en';
import { strings as homeJa } from '../strings/index/ja';
import { strings as commonEn } from '../strings/common/en';
import { strings as commonJa } from '../strings/common/ja';
import { parsePage } from './site.test-support';

describe('homepage chat replica', () => {
  it.each([
    { locale: 'en', home: homeEn, common: commonEn },
    { locale: 'ja', home: homeJa, common: commonJa },
  ])('renders the complete $locale conversation as static localized HTML', async ({ home, common }) => {
    const html = await renderToString(createSSRApp({ render: () => h(BrowserMock, { copy: home.demo, chrome: common.chrome }) }));
    using page = parsePage({ html });
    const scene = page.document.querySelector('[data-testid="docs-home-chat-scene"]');
    expect(scene).not.toBeNull();
    expect(scene?.querySelector('[data-testid="docs-home-prompt"]')?.textContent).toBe(home.demo.prompt);
    expect(scene?.querySelector('[data-testid="docs-home-response-intro"]')?.textContent).toBe(home.demo.answerIntro);
    expect(Array.from(scene?.querySelectorAll('[data-testid="docs-home-response-item"]') ?? [], item => item.textContent)).toEqual(home.demo.answerItems);
    expect(Array.from(scene?.querySelectorAll('[data-testid="docs-home-response-chunk"]') ?? [], chunk => Number(chunk.getAttribute('data-chunk-index')))).toEqual(Array.from({ length: 12 }, (_, index) => index));
    expect(scene?.querySelectorAll('.demo-message')).toHaveLength(2);
    expect(scene?.textContent).toContain(home.demo.placeholder);
    expect(scene?.textContent).toContain('Gemma');
    expect(scene?.textContent).not.toContain('notes.txt');
    expect(page.document.querySelector('script, [data-docs-island]')).toBeNull();
  });
});
