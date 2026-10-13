import { createSSRApp, h } from 'vue';
import { renderToString } from 'vue/server-renderer';
import { describe, expect, it } from 'vitest';
import LocalOnlyPage from '../pages/work/local-only.vue';
import { strings as english } from '../strings/work/local-only/en';
import { strings as japanese } from '../strings/work/local-only/ja';
import { strings as commonEnglish } from '../strings/common/en';
import { strings as commonJapanese } from '../strings/common/ja';
import { parsePage } from './site.test-support';

describe('Local-only connection guide', () => {
  it.each([
    { locale: 'en', s: english, common: commonEnglish },
    { locale: 'ja', s: japanese, common: commonJapanese },
  ] as const)('offers the three actual hosted versions and a checkable local policy in $locale HTML', async ({ locale, s, common }) => {
    const html = await renderToString(createSSRApp({ render: () => h(LocalOnlyPage, { locale, s, common }) }));
    using page = parsePage({ html });
    const article = page.document.querySelector('[data-testid="docs-local-only"]');
    expect(article?.querySelector('h1')?.textContent).toBe(s.title);
    expect([...article?.querySelectorAll('h2') ?? []].map(heading => heading.textContent)).toEqual([
      s.versionsTitle,
      s.localTitle,
      s.scopeTitle,
      s.checkTitle,
    ]);

    const hostedLinks = [...article?.querySelectorAll<HTMLAnchorElement>('.version-card a[data-docs-external]') ?? []];
    expect(hostedLinks.map(link => link.getAttribute('href'))).toEqual([
      'https://naidan-local-only.pages.dev',
      'https://naidan-curated.pages.dev',
      'https://naidan.pages.dev',
    ]);
    for (const link of hostedLinks) expect(link.querySelector('[data-docs-external-icon]')).not.toBeNull();
    expect(article?.querySelector('.switching-note a')?.getAttribute('href')).toBe(`/docs/${locale}/data/backup/`);
    expect(article?.querySelectorAll('.allowed-destinations > div')).toHaveLength(3);
    expect([...article?.querySelectorAll('.allowed-destinations code') ?? []].map(element => element.textContent)).toEqual([
      "'self'", 'http://localhost:*', 'http://127.0.0.1:*',
    ]);
    expect(article?.querySelectorAll('.guide-steps > li')).toHaveLength(3);
    expect(article?.textContent).toContain('Content-Security-Policy');
    expect(article?.textContent).toContain('connect-src');
    expect(article?.querySelector('[data-docs-related-guide] a')?.getAttribute('href')).toBe(`/docs/${locale}/models/local-engines/`);
  });
});
