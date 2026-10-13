import { parse as parseCss } from 'postcss';
import { createDocsDevBridge } from '../../build/docs-dev-bridge';
import { readFile, readdir, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { build } from 'vite';
import { describe, expect, it, vi } from 'vitest';
import { docsBuildConfig } from '../build/production';
import { DOCS_LOCALES, DOCS_PAGES, docsHref } from '../site/routes';
import { createSiteFixture, parsePage, startSiteDev } from './site.test-support';

describe('Docs development and static output', () => {
  it('renders the same localized Vue body and scoped styles in development and production', async () => {
    await using fixture = await createSiteFixture();
    await using dev = await startSiteDev({ root: fixture.root });
    const app = await dev.request({ url: '/' });
    expect(await app.text()).toContain('APP-ONLY');
    expect(await readdir(path.join(fixture.docs, '.cache')).catch(() => [])).toEqual([]);
    await build({ ...docsBuildConfig({ root: fixture.docs }), configFile: false, logLevel: 'error' });
    for (const locale of DOCS_LOCALES) {
      for (const page of DOCS_PAGES) {
        const href = docsHref({ locale, page: page.id });
        const response = await dev.request({ url: href });
        expect(response.status, href).toBe(200);
        using development = parsePage({ html: await response.text() });
        const relative = `${locale}/${page.id === 'index' ? '' : `${page.id}/`}index.html`;
        using production = parsePage({ html: await readFile(path.join(fixture.docs, 'dist', relative), 'utf8') });
        const normalize = ({ document }: { document: Document }) => {
          const body = document.body.cloneNode(true) as HTMLElement;
          for (const element of body.querySelectorAll('[src]')) {
            // Vite owns hashed asset paths. Compare the rendered content independently.
            element.setAttribute('src', 'BUILD-ASSET');
          }
          return body.innerHTML;
        };
        expect(normalize({ document: development.document }), href).toBe(normalize({ document: production.document }));
        expect(production.document.documentElement.lang).toBe(locale);
        const scripts = production.document.querySelectorAll('script');
        const islands = new Set(Array.from(production.document.querySelectorAll('[data-docs-island]'), element => element.getAttribute('data-docs-island')));
        const appEntryClient = production.document.querySelector('[data-docs-app-entry-path]') ? 1 : 0;
        expect(scripts.length).toBe(islands.size + appEntryClient);
        for (const element of development.document.querySelectorAll('link[rel="stylesheet"]')) {
          const asset = element.getAttribute('href');
          const css = await dev.request({ url: asset ?? '' });
          expect(css.status, asset ?? '').toBe(200);
          expect(css.headers.get('content-type'), asset ?? '').toContain('text/css');
        }
        expect(development.document.querySelectorAll('link[rel="stylesheet"]').length).toBeGreaterThan(0);
        for (const element of production.document.querySelectorAll('link[rel="stylesheet"], script[src], img[src]')) {
          const href = element.getAttribute('href') ?? element.getAttribute('src') ?? '';
          expect(href.startsWith('/docs/assets/'), href).toBe(true);
          const content = await readFile(path.join(fixture.docs, 'dist', href.slice('/docs/'.length)), 'utf8');
          expect(content.length, href).toBeGreaterThan(20);
          if (href.endsWith('.svg')) expect(content).toContain('<svg');
        }
      }
    }
  });
});

describe('Docs adversarial lifecycle behavior', () => {
  it('handles redirects, HEAD, missing routes and unsupported methods without the app fallback', async () => {
    await using fixture = await createSiteFixture();
    await using dev = await startSiteDev({ root: fixture.root });
    for (const [pathname, status] of [
      ['/docs?query=1', 308], ['/docs/ja', 308], ['/docs/ja/index.html', 308],
      ['/docs/fr/', 404], ['/docs/en/missing/', 404], ['/docs/%ZZ', 400],
      ['/docs/assets/missing.svg', 404],
    ] as const) {
      const response = await dev.request({ url: pathname });
      expect(response.status, pathname).toBe(status);
      expect(await response.text()).not.toContain('APP-ONLY');
      if (status === 308) expect(response.headers.get('location')).toMatch(/^\/docs\//);
    }
    const head = await dev.request({ url: '/docs/ja/', method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe('');
    const post = await dev.request({ url: '/docs/ja/', method: 'POST' });
    expect(post.status).toBe(405);
    expect(post.headers.get('allow')).toBe('GET, HEAD');
  });

  it('isolates concurrent languages and updates strings without a server restart', async () => {
    await using fixture = await createSiteFixture();
    await using dev = await startSiteDev({ root: fixture.root });
    await Promise.all(Array.from({ length: 40 }, async (_, index) => {
      const locale = index % 2 === 0 ? 'en' : 'ja';
      const response = await dev.request({ url: `/docs/${locale}/` });
      expect(response.status).toBe(200);
      using parsed = parsePage({ html: await response.text() });
      expect(parsed.document.documentElement.lang).toBe(locale);
      const heading = parsed.document.querySelector('h1')?.textContent;
      if (locale === 'ja') expect(heading).toBe('安全性を徹底追求した、簡単に使えるAI環境。');
      else expect(heading).toBe('An easy-to-use AI environment, built around privacy.');
    }));
    const file = path.join(fixture.docs, 'strings/index/ja.ts');
    const source = await readFile(file, 'utf8');
    await writeFile(file, source.replace('知りたい機能から探す', 'Updated Japanese guide heading'));
    await vi.waitFor(async () => {
      const response = await dev.request({ url: '/docs/ja/' });
      expect(await response.text()).toContain('Updated Japanese guide heading');
    }, { timeout: 8000, interval: 100 });
    expect(await (await dev.request({ url: '/docs/en/' })).text()).not.toContain('Updated Japanese guide heading');
  });

  it('uses fresh render modules, removes obsolete output and keeps server dictionaries out of client assets', async () => {
    await using fixture = await createSiteFixture();
    const config = { ...docsBuildConfig({ root: fixture.docs }), configFile: false as const, logLevel: 'error' as const };
    await build(config);
    await writeFile(path.join(fixture.docs, 'dist', 'stale.html'), 'previous route');
    const file = path.join(fixture.docs, 'strings/index/en.ts');
    await writeFile(file, (await readFile(file, 'utf8')).replace('Find what you want to do.', 'Updated production heading'));
    await build(config);
    const html = await readFile(path.join(fixture.docs, 'dist/en/index.html'), 'utf8');
    expect(html).toContain('Updated production heading');
    expect(await readdir(path.join(fixture.docs, 'dist'))).not.toContain('stale.html');
    expect(await readdir(path.join(fixture.docs, '.cache'))).not.toContain(expect.stringMatching(/^render-/));
    expect(await readdir(path.join(fixture.docs, 'dist'))).not.toContain('.vite');
    for (const file of await readdir(path.join(fixture.docs, 'dist/assets'))) {
      if (!file.endsWith('.js')) continue;
      const code = await readFile(path.join(fixture.docs, 'dist/assets', file), 'utf8');
      expect(code).not.toContain('Updated production heading');
      expect(code).not.toContain('安全性を徹底追求した');
    }
  });

  it('fails Docs builds on invalid dictionaries while leaving the normal app build independent', async () => {
    await using fixture = await createSiteFixture();
    const file = path.join(fixture.docs, 'strings/index/ja.ts');
    await writeFile(file, 'export const strings = { title: "Incomplete" };');
    await expect(build({ ...docsBuildConfig({ root: fixture.docs }), configFile: false, logLevel: 'silent' })).rejects.toThrow();
    expect(await readdir(path.join(fixture.docs, 'dist')).catch(() => [])).not.toContain('index.html');
    await build({ root: fixture.root, configFile: false, plugins: [createDocsDevBridge()], logLevel: 'silent' });
    expect(await readFile(path.join(fixture.root, 'dist/index.html'), 'utf8')).toContain('APP-ONLY');
    expect(await readdir(path.join(fixture.root, 'dist'))).not.toContain('docs');
    expect(await readdir(path.join(fixture.docs, '.cache'))).toEqual([]);
  });

  it.each(['static', 'async'])('collects %s nested scoped CSS, CSS imports and url assets through native Vite transforms', async kind => {
    await using fixture = await createSiteFixture();
    const child = `\
<template><div class="nested-native" data-testid="nested-native">Native nested component</div></template>
<style scoped>@import './nested.css'; .nested-native { background-image: url('../assets/naidan.svg'); }</style>`;
    await writeFile(path.join(fixture.docs, 'site/NestedNative.vue'), child);
    await writeFile(path.join(fixture.docs, 'site/nested.css'), '.nested-native { --native-css-probe: 617px; }');
    const page = path.join(fixture.docs, 'pages/files/privacy.vue');
    const declaration = kind === 'static'
      ? 'import NestedNative from "../../site/NestedNative.vue";'
      : `\
import { defineAsyncComponent } from 'vue';
const NestedNative = defineAsyncComponent(() => import('../../site/NestedNative.vue'));`;
    await writeFile(page, (await readFile(page, 'utf8')).replace('<script setup lang="ts">', `\
<script setup lang="ts">
${declaration}`).replace('<template>', '<template><NestedNative />'));
    await build({ ...docsBuildConfig({ root: fixture.docs }), configFile: false, logLevel: 'silent' });
    await using dev = await startSiteDev({ root: fixture.root });
    using development = parsePage({ html: await (await dev.request({ url: '/docs/en/files/privacy/' })).text() });
    using production = parsePage({ html: await readFile(path.join(fixture.docs, 'dist/en/files/privacy/index.html'), 'utf8') });
    expect(development.document.querySelector('[data-testid="nested-native"]')?.outerHTML).toBe(production.document.querySelector('[data-testid="nested-native"]')?.outerHTML);
    let productionCss = '', developmentCss = '';
    for (const link of production.document.querySelectorAll('link[rel="stylesheet"]')) {
      productionCss += await readFile(path.join(fixture.docs, 'dist', new URL(link.getAttribute('href') ?? '', 'https://example.test').pathname.slice('/docs/'.length)), 'utf8');
    }
    for (const link of development.document.querySelectorAll('link[rel="stylesheet"]')) {
      developmentCss += await (await dev.request({ url: link.getAttribute('href') ?? '' })).text();
    }
    for (const css of [productionCss, developmentCss]) {
      const values: string[] = [];
      parseCss(css).walkDecls('--native-css-probe', declaration => {
        values.push(declaration.value);
      });
      expect(values).toContain('617px');
    }
    expect(productionCss).toContain('/docs/assets/naidan-');
    expect(developmentCss).toContain('/docs/assets/naidan.svg');
  });

  it('rejects interactions hidden inside an imported static child', async () => {
    await using fixture = await createSiteFixture();
    await writeFile(path.join(fixture.docs, 'site/HiddenEvent.vue'), '<template><button @focus="() => {}">Hidden event</button></template>');
    const file = path.join(fixture.docs, 'pages/index.vue');
    await writeFile(file, (await readFile(file, 'utf8')).replace('<script setup lang="ts">', `\
<script setup lang="ts">
import HiddenEvent from "../site/HiddenEvent.vue";`).replace('<template>', '<template><HiddenEvent />'));
    await expect(build({ ...docsBuildConfig({ root: fixture.docs }), configFile: false, logLevel: 'silent' })).rejects.toThrow('Interactive binding');
  });
});

describe('Docs authoring boundaries', () => {
  it('rejects a translation registry import from a client entry', async () => {
    await using fixture = await createSiteFixture();
    const file = path.join(fixture.docs, 'islands/branching/client.ts');
    await writeFile(file, `\
import { pages } from 'virtual:naidan-docs/registry';
console.log(pages);
`);
    await expect(build({ ...docsBuildConfig({ root: fixture.docs }), configFile: false, logLevel: 'silent' })).rejects.toThrow('server-only');
  });

  it('isolates accidental component mutations from subsequent and concurrent renders', async () => {
    await using fixture = await createSiteFixture();
    const file = path.join(fixture.docs, 'pages/index.vue');
    const original = await readFile(file, 'utf8');
    const mutated = original.replace(
      'defineProps<{ s: HomeMessages; locale: DocsLocale; common: CommonMessages }>();',
      `\
const props = defineProps<{ s: HomeMessages; locale: DocsLocale; common: CommonMessages }>();
props.s.intro[0] += ' One isolated render.';`,
    );
    expect(mutated).not.toBe(original);
    await writeFile(file, mutated);
    await using dev = await startSiteDev({ root: fixture.root });
    const assertCopy = async ({ locale }: { locale: 'en' | 'ja' }) => {
      const response = await dev.request({ url: `/docs/${locale}/` });
      expect(response.status).toBe(200);
      using page = parsePage({ html: await response.text() });
      expect(page.document.querySelector('[data-testid="docs-hero"]')?.textContent?.split('One isolated render.')).toHaveLength(2);
    };
    await assertCopy({ locale: 'ja' });
    await assertCopy({ locale: 'ja' });
    await Promise.all(Array.from({ length: 12 }, (_, index) => assertCopy({ locale: index % 2 ? 'en' : 'ja' })));
  });
});

describe('Docs missing-page document', () => {
  it('emits a scoped 404 with the same manual language choices as development', async () => {
    await using fixture = await createSiteFixture();
    await build({ ...docsBuildConfig({ root: fixture.docs }), configFile: false, logLevel: 'silent' });
    await using dev = await startSiteDev({ root: fixture.root });
    const response = await dev.request({ url: '/docs/ja/missing/' });
    expect(response.status).toBe(404);
    using development = parsePage({ html: await response.text() });
    using production = parsePage({ html: await readFile(path.join(fixture.docs, 'dist/404.html'), 'utf8') });
    expect(development.document.body.innerHTML).toBe(production.document.body.innerHTML);
    expect(production.document.title).toBe('404 | Naidan Docs');
    expect(production.document.querySelector('script')).toBeNull();
    expect(production.document.querySelector('a[lang="ja"]')?.getAttribute('href')).toBe('/docs/ja/');
    expect(production.document.querySelector('a[lang="en"]')?.getAttribute('href')).toBe('/docs/en/');
    expect(production.document.body.textContent).toContain('ページが見つかりません');
  });
});

describe('Docs filesystem identifiers', () => {
  it('preserves spaces and percent signs instead of parsing file IDs as request URLs', async () => {
    await using fixture = await createSiteFixture();
    const root = path.join(fixture.root, 'docs with 100% literal paths');
    await rename(fixture.docs, root);
    await build({ ...docsBuildConfig({ root }), configFile: false, logLevel: 'silent' });
    using page = parsePage({ html: await readFile(path.join(root, 'dist/en/index.html'), 'utf8') });
    expect(page.document.querySelector('h1')?.textContent).toBe('An easy-to-use AI environment, built around privacy.');
  });
});
