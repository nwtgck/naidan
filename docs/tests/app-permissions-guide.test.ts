import { createSSRApp, h } from 'vue';
import { renderToString } from 'vue/server-renderer';
import { describe, expect, it } from 'vitest';
import AppPermissionsPage from '../pages/work/app-permissions.vue';
import { strings as english } from '../strings/work/app-permissions/en';
import { strings as japanese } from '../strings/work/app-permissions/ja';
import { strings as commonEnglish } from '../strings/common/en';
import { strings as commonJapanese } from '../strings/common/ja';
import { parsePage } from './site.test-support';

describe('app permissions comparison guide', () => {
  it.each([
    { locale: 'en', s: english, common: commonEnglish },
    { locale: 'ja', s: japanese, common: commonJapanese },
  ] as const)('shows access and outbound communication as separate decisions in $locale HTML', async ({ locale, s, common }) => {
    const html = await renderToString(createSSRApp({ render: () => h(AppPermissionsPage, { locale, s, common }) }));
    using page = parsePage({ html });
    const article = page.document.querySelector('[data-testid="docs-app-permissions"]');
    expect(article?.querySelector('h1')?.textContent).toBe(s.title);
    expect([...article?.querySelectorAll('h2') ?? []].map(heading => heading.textContent)).toEqual([
      s.noPrompt.title,
      s.reach.title,
      s.send.title,
      s.choose.title,
    ]);

    const comparison = article?.querySelector('[data-testid="app-reach-comparison"]');
    expect([...comparison?.querySelectorAll('.reach-card h3') ?? []].map(heading => heading.textContent)).toEqual(s.reach.cards.map(card => card.title));
    expect([...comparison?.querySelectorAll('.reach-card .scope') ?? []].map(scope => scope.textContent)).toEqual(s.reach.cards.map(card => card.scope));
    expect(article?.textContent).toContain('Android');
    expect(article?.textContent).toContain('TCP');
    expect(article?.textContent).toContain('UDP');

    const evidence = [...article?.querySelectorAll<HTMLAnchorElement>('a[href^="https://"]') ?? []];
    expect(evidence.length).toBeGreaterThanOrEqual(9);
    for (const link of evidence) expect(link.querySelector('[data-docs-external-icon]')).not.toBeNull();
    expect([...article?.querySelectorAll('[data-docs-related-guide] a') ?? []].map(link => link.getAttribute('href'))).toEqual([
      `/docs/${locale}/work/boundary/`,
      `/docs/${locale}/work/local-only/`,
      `/docs/${locale}/run/standalone/`,
    ]);
  });
});
