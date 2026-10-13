import { createSSRApp, h } from 'vue';
import { renderToString } from 'vue/server-renderer';
import { describe, expect, it } from 'vitest';
import DocLayout from '../site/DocLayout.vue';
import { DOCS_NAV_PAGES } from '../site/navigation';
import { DOCS_LOCALES, DOCS_PAGES, docsHref } from '../site/routes';
import type { DocsLocale, DocsPageId } from '../site/routes';
import { strings as english } from '../strings/common/en';
import { strings as japanese } from '../strings/common/ja';
import { parsePage } from './site.test-support';

const copy = { en: english, ja: japanese };

async function renderLayout({ locale, page }: { locale: DocsLocale; page: DocsPageId }) {
  const body = await renderToString(createSSRApp({
    render: () => h(DocLayout, { locale, page, s: copy[locale] }, { default: () => h('article', { class: 'prose' }, [h('h1', 'Guide content')]) }),
  }));
  return parsePage({ html: body });
}

describe('all-page Docs navigation', () => {
  it.each(DOCS_LOCALES)('lists every %s route once as a normal link, with one current page', async locale => {
    for (const route of DOCS_PAGES) {
      using rendered = await renderLayout({ locale, page: route.id });
      const header = rendered.document.querySelector('[data-testid="docs-header"]');
      expect(header?.classList.contains('docs-article-page')).toBe(route.id !== 'index');
      const menu = rendered.document.querySelector('[data-testid="docs-guide-menu"]');
      expect(menu?.tagName).toBe('DETAILS');
      expect(menu?.querySelector('summary')?.textContent?.trim()).toContain(copy[locale].navigation.title);
      const links = [...(menu?.querySelectorAll<HTMLAnchorElement>('[data-testid="docs-guide-link"]') ?? [])];
      const hrefs = links.map(link => link.getAttribute('href'));
      expect(hrefs).toHaveLength(DOCS_PAGES.length);
      expect(new Set(hrefs).size).toBe(DOCS_PAGES.length);
      expect(new Set(hrefs)).toEqual(new Set(DOCS_PAGES.map(entry => docsHref({ locale, page: entry.id }))));
      const current = links.filter(link => link.getAttribute('aria-current') === 'page');
      expect(current).toHaveLength(1);
      expect(current[0]?.getAttribute('href')).toBe(docsHref({ locale, page: route.id }));
      expect(current[0]?.textContent?.trim()).toBe(copy[locale].navigation.pages[route.id]);
      expect(rendered.document.querySelector('[data-testid="docs-breadcrumb"]')).toBeNull();
      if (route.id === 'index') {
        expect(rendered.document.querySelector('[data-testid="docs-article-sidebar"]')).toBeNull();
        expect(rendered.document.querySelector('[data-testid="docs-article-inline-nav"]')).toBeNull();
      } else {
        const sidebar = rendered.document.querySelector('[data-testid="docs-article-sidebar"]');
        expect(sidebar?.tagName).toBe('ASIDE');
        expect(sidebar?.getAttribute('aria-label')).toBe(copy[locale].navigation.sidebarTitle);
        expect(sidebar?.firstElementChild?.getAttribute('data-testid')).toBe('docs-guide-tree');
        expect(rendered.document.querySelector('[data-testid="docs-article-inline-nav"]')).toBeNull();
        expect(rendered.document.querySelector('.docs-article-body > article.prose')).not.toBeNull();
        const sidebarLinks = [...(sidebar?.querySelectorAll<HTMLAnchorElement>('[data-testid="docs-guide-link"]') ?? [])];
        expect(sidebarLinks).toHaveLength(DOCS_PAGES.length);
        expect(new Set(sidebarLinks.map(link => link.getAttribute('href')))).toEqual(new Set(hrefs));
        expect(sidebarLinks.filter(link => link.getAttribute('aria-current') === 'page').map(link => link.getAttribute('href')))
          .toEqual([docsHref({ locale, page: route.id })]);
        const groups = sidebar?.querySelectorAll<HTMLDetailsElement>('.docs-guide-group');
        expect(groups?.length).toBeGreaterThan(0);
        for (const group of groups ?? []) {
          expect(group.querySelector('summary')).not.toBeNull();
          expect(group.open).toBe(group.getAttribute('data-group') === DOCS_NAV_PAGES[route.id].group);
        }
        const groupIds = [...rendered.document.querySelectorAll('[id^="docs-guide-group-"]')].map(element => element.id);
        expect(new Set(groupIds).size).toBe(groupIds.length);
      }
      const other = locale === 'en' ? 'ja' : 'en';
      expect(rendered.document.querySelector('[data-testid="docs-language-switch"]')?.getAttribute('href'))
        .toBe(docsHref({ locale: other, page: route.id }));
    }
  });

  it('places child guides below their parent in both article navigation and the header menu', async () => {
    for (const route of DOCS_PAGES) {
      const placement = DOCS_NAV_PAGES[route.id];
      if (placement.parent === undefined) continue;
      const parent = DOCS_NAV_PAGES[placement.parent];
      expect(parent.parent).toBeUndefined();
      expect(parent.group).toBe(placement.group);
      using rendered = await renderLayout({ locale: 'en', page: route.id });
      for (const nav of rendered.document.querySelectorAll('[data-testid="docs-guide-tree"]')) {
        const child = nav.querySelector<HTMLAnchorElement>(`[data-testid="docs-guide-link"][href="${docsHref({ locale: 'en', page: route.id })}"]`);
        const parentLink = child?.closest('.docs-guide-children')?.previousElementSibling;
        expect(parentLink?.getAttribute('href')).toBe(docsHref({ locale: 'en', page: placement.parent }));
      }
    }
  });
});
