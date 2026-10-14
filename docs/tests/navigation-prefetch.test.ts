import { describe, expect, it } from 'vitest';
import { renderDocument, renderProductionDocument, renderProductionLocaleRoot } from '../build/html';
import { isDocsArticleHref } from '../site/navigation-prefetch';
import { parsePage } from './site.test-support';

const assets = { styles: [], scripts: [], favicon: '/docs/assets/favicon.svg' };
const body = `\
<h1>Guide</h1>
<a href="/docs/en/chat-branching/">This article</a>
<a href="/docs/en/in-browser-models/">Another article</a>
<a href="/docs/ja/browser-boundaries/">Other language article</a>
<a href="/docs/en/in-browser-models/?model=hf.co/example">Query</a>
<a href="/docs/en/">Home</a>
<a href="/">App</a>
<a href="https://github.com/nwtgck/naidan">Source</a>`;

describe('article navigation prefetch', () => {
  it('marks only registered, distinct article links in production HTML', () => {
    const page = { body, title: 'Guide', description: 'Description', locale: 'en', page: 'chat-branching' } as const;
    using production = parsePage({ html: renderProductionDocument({ page, assets, bootstrap: undefined }) });
    const marked = [...production.document.querySelectorAll<HTMLAnchorElement>('a[data-docs-guide-prefetch]')];
    expect(marked.map(anchor => anchor.getAttribute('href'))).toEqual(['/docs/en/in-browser-models/', '/docs/ja/browser-boundaries/']);
    const rule = production.document.querySelector('script[type="speculationrules"]');
    expect(JSON.parse(rule?.textContent ?? '')).toEqual({ prefetch: [{ where: { selector_matches: 'a[data-docs-guide-prefetch]' }, eagerness: 'moderate' }] });

    using development = parsePage({ html: renderDocument({ page, assets, bootstrap: undefined }) });
    expect(development.document.querySelector('script[type="speculationrules"]')).toBeNull();
    expect(development.document.querySelectorAll('a[data-docs-guide-prefetch]')).toHaveLength(2);

    expect(() => renderProductionDocument({
      page: { ...page, body: '<h1>Guide</h1><a href="/" data-docs-guide-prefetch>App</a>' },
      assets,
      bootstrap: undefined,
    })).toThrow('Invalid Docs article prefetch target');
  });

  it('keeps the allowlist exact and marks locale templates for later insertion', () => {
    expect(isDocsArticleHref({ href: '/docs/en/in-browser-models/' })).toBe(true);
    for (const href of ['/docs/en/', '/docs/en/in-browser-models/?q=1', '/docs/en/in-browser-models/#part', 'https://naidan.nwtgck.org/docs/en/in-browser-models/', '/docs/en/not-published/']) {
      expect(isDocsArticleHref({ href })).toBe(false);
    }
    const pages = {
      en: { body: '<h1>English</h1><a href="/docs/en/in-browser-models/">Article</a>', title: 'English', description: 'Home', locale: 'en', page: 'index' },
      ja: { body: '<h1>日本語</h1><a href="/docs/ja/in-browser-models/">記事</a>', title: '日本語', description: 'ホーム', locale: 'ja', page: 'index' },
    } as const;
    using parsed = parsePage({ html: renderProductionLocaleRoot({ assets, pages, bootstrap: '/docs/__locale.js' }) });
    expect(parsed.document.querySelectorAll('script[type="speculationrules"]')).toHaveLength(1);
    for (const template of parsed.document.querySelectorAll<HTMLTemplateElement>('template[data-docs-locale]')) {
      expect(template.content.querySelector('a[data-docs-guide-prefetch]')).not.toBeNull();
    }
  });
});
