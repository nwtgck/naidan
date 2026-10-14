import { createSSRApp } from 'vue';
import { renderToString } from 'vue/server-renderer';
import { describe, expect, it } from 'vitest';
import OfflinePage from '../pages/pwa/index.vue';
import { strings as english } from '../pages/pwa/strings/en';
import { strings as japanese } from '../pages/pwa/strings/ja';
import { strings as commonEnglish } from '../strings/common/en';
import { strings as commonJapanese } from '../strings/common/ja';
import { parsePage } from './site.test-support';

describe('offline browser AI guide', () => {
  it.each([
    { locale: 'en', s: english, common: commonEnglish },
    { locale: 'ja', s: japanese, common: commonJapanese },
  ] as const)('renders the online preparation and offline verification journey in $locale', async ({ locale, s, common }) => {
    const html = await renderToString(createSSRApp(OfflinePage, { locale, s, common }));
    using page = parsePage({ html });
    const article = page.document.querySelector('[data-testid="docs-run-offline"]');
    expect(article?.querySelector('h1')?.textContent).toBe(s.title);
    expect(article?.querySelector('.app-entry-intro a[data-docs-app-entry-path]')?.textContent).toBe('Naidan');
    expect([...article?.querySelectorAll('section.walkthrough-step h2') ?? []].map(heading => heading.textContent)).toEqual([
      s.prepare.title, s.model.title, s.verify.title, s.update.title,
    ]);
    expect([...article?.querySelectorAll('section.walkthrough-step [data-docs-animation]') ?? []].map(scene => scene.getAttribute('data-testid'))).toEqual([
      'offline-step-prepare', 'offline-step-model', 'offline-step-verify', 'offline-step-update',
    ]);
    expect(article?.querySelector('[data-testid="offline-step-model"]')?.textContent).toContain(s.demo.modelFile);
    expect(article?.querySelector('[data-testid="offline-step-verify"]')?.textContent).toContain(s.demo.offline);
    const update = article?.querySelector('[data-testid="offline-step-update"]');
    expect(update?.textContent).toContain(s.demo.readyUpdate);
    expect(update?.querySelector('.update-warning')?.textContent).toBe(s.demo.updateWarning);
    expect(article?.textContent).toContain(s.verify.limitation);
    expect(article?.querySelectorAll('figure button, figure input, figure a')).toHaveLength(0);
    expect([...article?.querySelectorAll('[data-docs-related-guide] a') ?? []].map(link => link.getAttribute('href'))).toEqual([
      `/docs/${locale}/endpoint-type-llama-cpp-browser/`,
      `/docs/${locale}/in-browser-models/`,
      `/docs/${locale}/standalone/`,
      `/docs/${locale}/hosted/`,
    ]);
  });
});
