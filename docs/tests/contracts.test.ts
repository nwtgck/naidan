import { describe, expect, it } from 'vitest';
import { resolveDocsRoute } from '../build/routes';
import { validateStaticComponent } from '../build/source-policy';
import { findIslands, renderDocument, renderLocaleRoot } from '../build/html';
import { manifestEntry, parseManifest, publicAssetHref } from '../build/assets';
import { selectDocsLocale } from '../site/locale';
import { strings as homeEn } from '../strings/index/en';
import { strings as homeJa } from '../strings/index/ja';
import { isDocsUrl } from '../../pwa/docs-routing';
import { parsePage } from './site.test-support';

const emptyAssets = { styles: [], scripts: [] };

describe('Docs URL routing', () => {
  it.each([
    ['/docs', { kind: 'redirect', location: '/docs/' }],
    ['/docs?next=https://evil.example', { kind: 'redirect', location: '/docs/?next=https://evil.example' }],
    ['/docs/', { kind: 'root' }],
    ['/docs/index.html?x=1', { kind: 'redirect', location: '/docs/?x=1' }],
    ['/docs/ja/', { kind: 'page', locale: 'ja', page: 'index' }],
    ['/docs/en/chat/branching/?q=%3F', { kind: 'page', locale: 'en', page: 'chat/branching' }],
    ['/docs/en/chat/branching/index.html?q=1', { kind: 'redirect', location: '/docs/en/chat/branching/?q=1' }],
    ['/docs/ja?x=1', { kind: 'redirect', location: '/docs/ja/?x=1' }],
    ['/docs/fr/', { kind: 'missing' }],
    ['/docs/ja/not-a-page/', { kind: 'missing' }],
    ['/docs/assets/a.css', { kind: 'asset' }],
    ['/docs/@vite/client', { kind: 'asset' }],
    ['/docs-other/', { kind: 'outside' }],
    ['/', { kind: 'outside' }],
  ])('routes %s using a fixed page registry', (requestUrl, expected) => {
    expect(resolveDocsRoute({ requestUrl })).toEqual(expected);
  });

  it.each(['//evil.example/docs/', 'https://evil.example/docs/', '/docs/ja/\\evil', '/docs/%GG', '/docs/%E0%A4%A', '/docs/\u0000'])('rejects malformed request target %s', requestUrl => {
    expect(resolveDocsRoute({ requestUrl })).toEqual({ kind: 'invalid' });
  });

  it.each(['en/', 'ja/?x=1', '', '?q=1', 'assets/app.js'])('excludes scope-relative Docs paths from the application worker: %s', suffix => {
    const scope = new URL('https://example.test/naidan/');
    const url = new URL(`docs/${suffix}`, scope);
    expect(isDocsUrl({ url, scope })).toBe(true);
    expect(isDocsUrl({ url: new URL('docs?query=1', scope), scope })).toBe(true);
    expect(isDocsUrl({ url: new URL('docs-other/', scope), scope })).toBe(false);
    expect(isDocsUrl({ url: new URL('https://other.test/naidan/docs/'), scope })).toBe(false);
  });
});

describe('static component authoring boundaries', () => {
  it.each([
    '<button @click="run">Run</button>',
    '<input v-model="value">',
    '<button v-on="handlers">Run</button>',
    '<button @[event]="run">Run</button>',
    '<div v-html="html" />',
    '<div :onclick="run" />',
    '<div onclick="run()" />',
    '<iframe src="https://example.test" />',
    '<div v-bind="attributes" />',
    '<div :[attribute]="value" />',
  ])('rejects unsupported static source through the Vue AST: %s', template => {
    expect(() => validateStaticComponent({ source: `<template>${template}</template>`, filename: '/docs/pages/test.vue', mode: 'static' })).toThrow();
  });

  it('accepts ordinary escaped text, scoped CSS and native HTML controls', () => {
    const source = `\
<template><main><p>Literal @click is documentation, not a directive.</p><p>{{ message }}</p><details><summary>More</summary>Text</details></main></template>
<style scoped>p { color: red; }</style>`;
    expect(() => validateStaticComponent({ source, filename: '/docs/pages/test.vue', mode: 'static' })).not.toThrow();
  });

  it('accepts event handlers in an island but keeps v-html forbidden', () => {
    expect(() => validateStaticComponent({ source: '<template><button @click="run">Run</button></template>', filename: 'Demo.vue', mode: 'island' })).not.toThrow();
    expect(() => validateStaticComponent({ source: '<template><div v-html="raw" /></template>', filename: 'Demo.vue', mode: 'island' })).toThrow();
  });

  it('rejects an external template rather than bypassing its validation', () => {
    expect(() => validateStaticComponent({ source: '<template src="./other.html" />', filename: 'Page.vue', mode: 'static' })).toThrow();
  });
});

describe('HTML composition and locale contracts', () => {
  it('escapes document metadata with DOM APIs and preserves the rendered body', () => {
    const title = '</title><script>alert("title")</script>';
    const html = renderDocument({ page: { title, description: '" onload=bad', body: '<h1>Readable &amp; safe</h1><p>&lt;script&gt;not executed&lt;/script&gt;</p>', locale: 'ja', page: 'index' }, assets: emptyAssets });
    using parsed = parsePage({ html });
    expect(parsed.document.title).toBe(`${title} | Naidan`);
    expect(parsed.document.querySelector('meta[name="description"]')?.getAttribute('content')).toBe('" onload=bad');
    expect(parsed.document.querySelector('script')).toBeNull();
    expect(parsed.document.querySelector('p')?.textContent).toBe('<script>not executed</script>');
    expect(parsed.document.querySelectorAll('link[rel="alternate"]')).toHaveLength(3);
    expect(parsed.document.querySelector('link[hreflang="x-default"]')?.getAttribute('href')).toBe('https://naidan.nwtgck.org/docs/');
  });

  it.each([
    '<h1>A</h1><h1>B</h1>', '<p>No heading</p>',
    '<h1>A</h1><script>bad()</script>', '<h1>A</h1><iframe></iframe>',
    '<h1 onclick="bad()">A</h1>', '<h1>A</h1><a href="javascript:bad()">link</a>',
    '<h1>A</h1><img src="https://external.example/track.png">',
    '<h1>A</h1><svg><use xlink:href="javascript:bad()"></use></svg>',
    '<h1>A</h1><img src="data:image/svg+xml,anything">',
  ])('rejects unsupported rendered markup using DOM parsing: %s', body => {
    expect(() => renderDocument({ page: { body, title: 'Test', description: 'Test', locale: 'en', page: 'index' }, assets: emptyAssets })).toThrow();
  });

  it('sets an explicit referrer policy on external links', () => {
    using parsed = parsePage({ html: renderDocument({ page: { body: '<h1>Title</h1><a href="https://example.test/">Outside</a>', title: 'Title', description: 'Test', locale: 'en', page: 'index' }, assets: emptyAssets }) });
    expect(parsed.document.querySelector('a')?.getAttribute('referrerpolicy')).toBe('no-referrer');
  });

  it('has manual language links without script execution', () => {
    using parsed = parsePage({ html: renderLocaleRoot({ assets: emptyAssets, bootstrap: '/docs/__locale.js', pages: { en: { body: '<h1>English</h1>', title: 'English', description: 'Home', locale: 'en', page: 'index' }, ja: { body: '<h1>日本語</h1>', title: '日本語', description: 'ホーム', locale: 'ja', page: 'index' } } }) });
    expect([...parsed.document.querySelectorAll('a')].map(a => a.getAttribute('href'))).toEqual(['/docs/en/', '/docs/ja/']);
    expect(parsed.document.querySelector('script')?.getAttribute('type')).toBeNull();
    expect(parsed.document.querySelectorAll('template[data-docs-locale]')).toHaveLength(2);
  });

  it('does not recognize fake island markers inside escaped prose', () => {
    expect(findIslands({ body: '<p>&lt;div data-docs-island="branching"&gt;</p>' })).toEqual([]);
    expect(() => findIslands({ body: '<div data-docs-island="unknown"></div>' })).toThrow();
    expect(() => findIslands({ body: '<div data-docs-island="branching" data-docs-props="{}"></div>' })).toThrow();
  });

  it.each([
    [[], 'en'], [['fr', 'ja-JP'], 'ja'], [['en-US', 'ja'], 'en'],
    [['ja-JP', 'en-US'], 'ja'], [['not_a_locale', 'en-GB'], 'en'], [['JA'], 'ja'],
  ] as const)('respects browser language order %s', (languages, expected) => {
    expect(selectDocsLocale({ languages })).toBe(expected);
  });

  it('preserves approved headlines', () => {
    expect(homeJa.headline.join('')).toBe('安全性を徹底追求した、簡単に使えるAI環境。');
    expect(homeEn.headline.join('')).toBe('An easy-to-use AI environment, built around privacy.');
  });
});

describe('native Vite manifest assets', () => {
  it('collects transitive styles once and handles shared chunks', () => {
    const manifest = parseManifest({ text: JSON.stringify({ entry: { file: 'assets/page.js', name: 'page', isEntry: true, imports: ['child'], css: ['assets/page.css'] }, child: { file: 'assets/child.js', imports: ['entry'], css: ['assets/base.css'] } }) });
    expect(manifestEntry({ manifest, name: 'page' })).toEqual({ script: '/docs/assets/page.js', styles: ['/docs/assets/base.css', '/docs/assets/page.css'] });
    expect(() => manifestEntry({ manifest, name: 'missing' })).toThrow();
  });

  it.each(['../app.js', '/app.js', 'https://other.test/a.js', 'assets/../../app.js', 'assets/a.js?script=1', 'assets/a.js#hash', 'assets\\a.js'])('rejects escaped asset path %s', file => {
    expect(() => publicAssetHref({ file })).toThrow();
  });

  it('fails closed on missing chunks and malformed manifests', () => {
    expect(() => parseManifest({ text: '{"entry":{"file":2}}' })).toThrow();
    expect(() => manifestEntry({ manifest: { entry: { file: 'assets/e.js', name: 'page', isEntry: true, imports: ['missing'] } }, name: 'page' })).toThrow();
  });
});
