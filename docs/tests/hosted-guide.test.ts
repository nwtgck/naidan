import { createSSRApp } from 'vue';
import { renderToString } from 'vue/server-renderer';
import { describe, expect, it } from 'vitest';
import HostedPage from '../pages/hosted/index.vue';
import { messages as english } from '../pages/hosted/messages/en';
import { messages as japanese } from '../pages/hosted/messages/ja';
import { messages as commonEnglish } from '../messages/common/en';
import { messages as commonJapanese } from '../messages/common/ja';
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
    expect(article?.querySelector('a[href="https://github.com/nwtgck/naidan/releases/latest"]')?.textContent).toContain(s.latest_release_link);
    expect([...article?.querySelectorAll('.guide-steps h3') ?? []].map(heading => heading.textContent)).toEqual([
      s.download_hosted_zip_title, s.serve_extracted_folder_title, s.open_local_address_title,
    ]);
    expect(article?.querySelector('[data-testid="hosted-python-command"]')?.textContent).toBe('python3 -m http.server 8000 --bind 127.0.0.1');
    expect(article?.textContent).toContain('http://127.0.0.1:8000/');
    expect(article?.textContent).toContain('naidan-hosted-v0.24.1.zip');
    expect(article?.textContent).toContain('naidan-hosted-0.24.1/');
    expect(article?.querySelector('[data-docs-animation="hosted-static-flow"] figcaption')?.textContent).toBe(s.hosted_file_flow_caption);
    expect(article?.querySelectorAll('figure button, figure input, figure a')).toHaveLength(0);
    expect([...article?.querySelectorAll('[data-docs-related-guide] a') ?? []].map(link => link.getAttribute('href'))).toEqual([
      `/docs/${locale}/pwa/`,
      `/docs/${locale}/standalone/`,
      `/docs/${locale}/data-backup/`,
    ]);
    for (const guide of ['in-browser-models', 'endpoint-type-llama-cpp-browser', 'local-ai-servers']) {
      expect(article?.querySelector(`a[href="/docs/${locale}/${guide}/"]`)?.textContent?.trim()).toBeTruthy();
    }
  });
});
