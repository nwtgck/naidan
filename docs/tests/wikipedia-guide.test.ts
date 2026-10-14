import { describe, expect, it } from 'vitest';
import { createSSRApp, h } from 'vue';
import { renderToString } from '@vue/server-renderer';
import WikipediaGuide from '../pages/work/wikipedia.vue';
import { strings as en } from '../strings/work/wikipedia/en';
import { strings as ja } from '../strings/work/wikipedia/ja';
import { strings as commonEn } from '../strings/common/en';
import { strings as commonJa } from '../strings/common/ja';
import { parsePage } from './site.test-support';

describe('Wikipedia chat guide', () => {
  it.each(['en', 'ja'] as const)('renders the complete consent path and privacy scope in %s', async locale => {
    const s = locale === 'en' ? en : ja;
    const common = locale === 'en' ? commonEn : commonJa;
    const html = await renderToString(createSSRApp({ render: () => h(WikipediaGuide, { s, locale, common }) }));
    using page = parsePage({ html });
    const article = page.document.querySelector('[data-testid="docs-wikipedia"]');
    expect(article?.querySelector('h1')?.textContent).toBe(s.title);
    expect(article?.querySelector('[data-docs-app-entry-path]')?.getAttribute('data-docs-app-entry-path')).toBe('/#/');

    const steps = [...(article?.querySelectorAll('.walkthrough-step') ?? [])];
    expect(steps.map(step => step.querySelector('[data-docs-animation]')?.getAttribute('data-docs-animation'))).toEqual([
      'wikipedia-settings-open',
      'wikipedia-settings-enabled',
      'wikipedia-chat-search',
      'wikipedia-chat-page',
    ]);
    expect(steps[1]?.textContent).toContain('/sys/fs/naidan');
    expect(steps[1]?.textContent).toContain(s.demo.currentChat);
    expect(steps[1]?.textContent).toContain(s.demo.shell);
    expect(steps[1]?.querySelector('a')?.getAttribute('href')).toBe(`/docs/${locale}/work/wesh-sysfs/`);
    expect(steps[2]?.querySelector('.approval-preview')?.textContent).toContain(s.demo.searchTerm);
    expect(steps[3]?.querySelector('.approval-preview')?.textContent).toContain(s.demo.pageId);
    expect(steps[3]?.querySelector('.user-message')?.textContent).toBe(s.demo.prompt);
    expect(steps[2]?.querySelector('.approval-panel')?.textContent).toContain(s.demo.once);
    expect(steps[2]?.textContent).toContain(s.demo.chat);
    expect(steps[2]?.textContent).toContain(s.demo.global);
    expect(steps[2]?.querySelector('p')?.textContent).toContain(s.privacy.editions);
    expect(steps[2]?.querySelector('a')?.getAttribute('href')).toBe(`/docs/${locale}/work/local-only/`);
    expect(steps[3]?.querySelector('.approval-panel')?.textContent).toContain(s.demo.once);
    expect(article?.querySelector('[data-testid="wikipedia-chat-result"] .assistant-message')?.textContent).toBe(s.demo.sampleAnswer);

    const privacy = article?.querySelector('.privacy-section');
    expect(privacy?.textContent).toContain('Origin');
    expect(privacy?.textContent).toContain('IP');
  });
});
