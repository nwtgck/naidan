import { createSSRApp } from 'vue';
import { renderToString } from 'vue/server-renderer';
import { describe, expect, it } from 'vitest';
import HostedPage from '../pages/run/hosted.vue';
import { strings as english } from '../strings/run/hosted/en';
import { strings as japanese } from '../strings/run/hosted/ja';
import { strings as commonEnglish } from '../strings/common/en';
import { strings as commonJapanese } from '../strings/common/ja';
import { parsePage } from './site.test-support';

describe('self-hosted ZIP guide', () => {
  it.each([
    { locale: 'en', s: english, common: commonEnglish },
    { locale: 'ja', s: japanese, common: commonJapanese },
  ] as const)('takes a $locale reader from the release to a running page and a model choice', async ({ locale, s, common }) => {
    const html = await renderToString(createSSRApp(HostedPage, { locale, s, common }));
    using page = parsePage({ html });
    const article = page.document.querySelector('[data-testid="docs-run-hosted"]');
    expect(article?.querySelector('h1')?.textContent).toBe(s.title);
    expect(article?.querySelector('a[href="https://github.com/nwtgck/naidan/releases/latest"]')?.textContent).toContain(s.releaseLink);
    expect([...article?.querySelectorAll('.guide-steps h3') ?? []].map(heading => heading.textContent)).toEqual([
      s.download.title, s.serve.title, s.open.title,
    ]);
    expect(article?.querySelector('[data-testid="hosted-python-command"]')?.textContent).toBe('python3 -m http.server 8000 --bind 127.0.0.1');
    expect(article?.textContent).toContain('http://127.0.0.1:8000/');
    expect(article?.textContent).toContain('naidan-hosted-v0.24.1.zip');
    expect(article?.textContent).toContain('naidan-hosted-0.24.1/');
    expect(article?.querySelector('[data-docs-animation="hosted-static-flow"] figcaption')?.textContent).toBe(s.flow.caption);
    expect(article?.querySelectorAll('figure button, figure input, figure a')).toHaveLength(0);
    expect([...article?.querySelectorAll('[data-docs-related-guide] a') ?? []].map(link => link.getAttribute('href'))).toEqual([
      `/docs/${locale}/run/offline/`,
      `/docs/${locale}/run/standalone/`,
      `/docs/${locale}/data/backup/`,
    ]);
    expect(article?.querySelector(`a[href="/docs/${locale}/models/in-browser/"]`)?.textContent).toBe(s.model.browserGuide);
    expect(article?.querySelector(`a[href="/docs/${locale}/models/llama-cpp-browser/"]`)?.textContent).toBe(s.model.ggufGuide);
    expect(article?.querySelector(`a[href="/docs/${locale}/models/local-engines/"]`)?.textContent).toBe(s.model.engineGuide);
  });
});
