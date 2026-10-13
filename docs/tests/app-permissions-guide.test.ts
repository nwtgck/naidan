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
      s.reach.title,
      s.send.title,
      s.noPrompt.title,
      s.choose.title,
    ]);

    expect([...article?.querySelectorAll('.access-example h3') ?? []].map(heading => heading.textContent)).toEqual(s.reach.cards.map(card => card.title));
    for (const mode of ['desktop', 'mobile', 'web', 'send', 'noPrompt'] as const) {
      const diagram = article?.querySelector(`[data-testid="app-permissions-${mode}-diagram"]`);
      expect(diagram?.getAttribute('aria-label')).toBe(s.visual[mode].caption);
      expect(diagram?.closest('figure')?.querySelector('figcaption')?.textContent).toBe(s.visual[mode].caption);
    }
    expect(article?.textContent?.indexOf(s.reach.cards[0]!.title)).toBeLessThan(article?.textContent?.indexOf(s.send.title) ?? 0);
    expect(article?.textContent?.indexOf(s.send.title)).toBeLessThan(article?.textContent?.indexOf(s.noPrompt.title) ?? 0);
    const consentDiagram = article?.querySelector('[data-testid="app-permissions-noPrompt-diagram"]');
    expect(consentDiagram?.textContent).toContain(s.visual.noPrompt.automatic);
    expect(consentDiagram?.textContent).toContain(s.visual.noPrompt.request);
    const sendDiagram = article?.querySelector('[data-testid="app-permissions-send-diagram"]');
    expect(sendDiagram?.textContent).toContain(s.visual.send.webApp);
    expect(sendDiagram?.textContent).toContain(s.visual.send.service);
    expect(sendDiagram?.textContent).toContain(s.visual.desktop.sample);
    expect(sendDiagram?.textContent).toContain(s.visual.mobile.sensorValue);
    expect(sendDiagram?.textContent).toContain(s.visual.web.fileName);
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
