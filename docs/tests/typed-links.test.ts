import { describe, expect, it } from 'vitest';
import { createSSRApp, h } from 'vue';
import { renderToString } from 'vue/server-renderer';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { validateStaticComponent } from '../build/source-policy';
import DocsLink from '../components/DocsLink.vue';
import LocalAnchorLink from '../components/LocalAnchorLink.vue';
import ExternalLink from '../components/ExternalLink.vue';
import AppEntryLink from '../components/AppEntryLink.vue';
import RenderText from '../components/RenderText';
import { messages as branchingEn } from '../pages/chat-branching/messages/en';
import { messages as branchingJa } from '../pages/chat-branching/messages/ja';
import { docsHref } from '../navigation/routes';
import { createSiteFixture, parsePage, startSiteDev } from './site.test-support';

describe('typed Docs links', () => {
  it.each([
    { locale: 'en' as const, strings: branchingEn, label: 'browser model setup' },
    { locale: 'ja' as const, strings: branchingJa, label: 'ブラウザ内でAIモデルを動かす手順' },
  ])('renders a normal JSX DocsLink child in $locale article prose', async ({ locale, strings, label }) => {
    const html = await renderToString(createSSRApp({ render: () => h(RenderText, { node: strings.in_browser_model_setup_guide({ locale }) }) }));
    using parsed = parsePage({ html });
    const anchor = parsed.document.querySelector<HTMLAnchorElement>('a');
    expect(anchor?.getAttribute('href')).toBe(docsHref({ locale, page: 'in-browser-models' }));
    expect(anchor?.textContent).toBe(label);
  });

  it.each(['en', 'ja'] as const)('renders a registered %s page as a native anchor with forwarded attributes', async locale => {
    const html = await renderToString(createSSRApp({
      render: () => h(DocsLink, {
        locale,
        page: 'in-browser-models',
        class: 'guide-link',
        'aria-label': 'Read the guide',
        'data-testid': 'registered-guide',
      }, () => 'Models'),
    }));
    using parsed = parsePage({ html });
    const anchor = parsed.document.querySelector<HTMLAnchorElement>('[data-testid="registered-guide"]');
    expect(anchor?.tagName).toBe('A');
    expect(anchor?.getAttribute('href')).toBe(docsHref({ locale, page: 'in-browser-models' }));
    expect(anchor?.classList.contains('guide-link')).toBe(true);
    expect(anchor?.getAttribute('aria-label')).toBe('Read the guide');
    expect(anchor?.textContent).toBe('Models');
  });

  it('rejects an unregistered page and ignores an injected href', async () => {
    // @ts-expect-error An unregistered page is rejected before the runtime guard.
    await expect(renderToString(createSSRApp({ render: () => h(DocsLink, { locale: 'en', page: 'missing-page' }, () => 'Missing') })))
      .rejects.toThrow('Unregistered Docs page');
    // @ts-expect-error Callers cannot supply href in place of the registered route.
    const html = await renderToString(createSSRApp({ render: () => h(DocsLink, { locale: 'ja', page: 'index', href: '/docs/ja/missing-page/' }, () => 'Home') }));
    using parsed = parsePage({ html });
    expect(parsed.document.querySelector('a')?.getAttribute('href')).toBe(docsHref({ locale: 'ja', page: 'index' }));
  });

  it('keeps the skip link on the current page even when href is injected', async () => {
    // @ts-expect-error The local fragment destination is fixed by the component.
    const html = await renderToString(createSSRApp({ render: () => h(LocalAnchorLink, { href: '/docs/en/#docs-main', class: 'skip-link' }, () => 'Skip') }));
    using parsed = parsePage({ html });
    expect(parsed.document.querySelector('a.skip-link')?.getAttribute('href')).toBe('#docs-main');
  });

  it('requires absolute HTTP(S) targets for external links', async () => {
    for (const href of ['/docs/en/missing-page/', '#docs-main', 'mailto:author@example.org', 'javascript:alert(1)']) {
      await expect(renderToString(createSSRApp({ render: () => h(ExternalLink, { href, locale: 'en' }, () => 'Outside') })))
        .rejects.toThrow('ExternalLink requires an absolute HTTP(S) URL');
    }
    const html = await renderToString(createSSRApp({ render: () => h(ExternalLink, { href: 'https://github.com/nwtgck/naidan', locale: 'en' }, () => 'Source') }));
    using parsed = parsePage({ html });
    const anchor = parsed.document.querySelector('a[data-docs-external]');
    expect(anchor?.getAttribute('href')).toBe('https://github.com/nwtgck/naidan');
    expect(anchor?.getAttribute('target')).toBe('_blank');
    expect(anchor?.querySelector('[data-docs-external-icon]')).not.toBeNull();
  });

  it('retains the app entry destination when a caller passes href', async () => {
    // @ts-expect-error App entry destinations cannot be replaced by an href.
    const html = await renderToString(createSSRApp({ render: () => h(AppEntryLink, { destination: { kind: 'screen', screen: 'home' }, locale: 'en', display: 'label', href: '/docs/en/missing-page/' }, () => 'Use app') }));
    using parsed = parsePage({ html });
    const anchor = parsed.document.querySelector('a[data-docs-app-entry-path]');
    expect(anchor?.getAttribute('href')).toBe('https://naidan.nwtgck.org/#/');
    expect(anchor?.getAttribute('data-docs-app-entry-path')).toBe('/#/');
    expect(anchor?.querySelector('[data-docs-external-icon]')).toBeNull();
  });
});

describe('native anchor authoring guard', () => {
  it.each(['pages/index/index.vue', 'components/DocsGuideTree.vue', 'islands/search/SearchIsland.vue', 'components/DocsLinkCopy.vue'])('rejects a raw anchor in %s', filename => {
    expect(() => validateStaticComponent({ source: '<template><a href="/docs/en/missing-page/">Missing</a></template>', filename, mode: filename.startsWith('islands/') ? 'island' : 'static' }))
      .toThrow('Use a typed Docs link component');
  });

  it.each(['components/DocsLink.vue', 'components/LocalAnchorLink.vue', 'components/ExternalLink.vue', 'components/AppEntryLink.vue'])('allows a native anchor inside %s', filename => {
    expect(() => validateStaticComponent({ source: '<template><a href="/">Link</a></template>', filename, mode: 'static' }))
      .not.toThrow();
  });

  it('ignores escaped examples and SVG references', () => {
    expect(() => validateStaticComponent({
      source: '<template><p>&lt;a href="/docs/en/missing-page/"&gt;example&lt;/a&gt;</p><svg><use href="#icon" /></svg></template>',
      filename: 'pages/index/index.vue',
      mode: 'static',
    })).not.toThrow();
  });

  it('rejects a new raw page anchor through the development compiler', async () => {
    await using fixture = await createSiteFixture();
    const filename = path.join(fixture.docs, 'pages/index/index.vue');
    const source = await readFile(filename, 'utf8');
    await writeFile(filename, source.replace('<template>', '<template><a href="/docs/en/missing-page/">Missing</a>'));
    await using dev = await startSiteDev({ root: fixture.root });
    const response = await dev.request({ url: '/docs/en/' });
    expect(response.status).toBe(500);
    expect((await dev.request({ url: '/docs/en/open-source/' })).status).toBe(200);
  });
});
