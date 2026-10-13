import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Script } from 'node:vm';
import { JSDOM } from 'jsdom';
import { build } from 'vite';
import { describe, expect, it, vi } from 'vitest';
import { docsBuildConfig } from '../build/production';
import { DOCS_PAGES, docsHref } from '../site/routes';
import { parseSearchIndex, purposeDocs, searchDocs } from '../site/search';
import type { SearchIndex } from '../site/search';
import { parseWorkerRequest } from '../islands/search/worker-contracts';
import type { SearchWorkerRequest, SearchWorkerResponse } from '../islands/search/worker-contracts';
import { createSiteFixture, parsePage, startSiteDev } from './site.test-support';

describe('Docs search', () => {
  it('matches Japanese substrings and multiple terms while preferring titles and headings', () => {
    const index: SearchIndex = {
      locale: 'ja',
      entries: [
        { href: '/docs/ja/files/privacy/', title: 'ファイルを選ぶ', description: '読む範囲を選ぶ', headings: ['読み取り権限'], paragraphs: ['ファイルを読み取る範囲を選択します。'] },
        { href: '/docs/ja/data/storage/', title: '保存先', description: '場所を選ぶ', headings: ['ファイルを選ぶ'], paragraphs: ['保存する場所を選択します。'] },
        { href: '/docs/ja/chat/groups/', title: 'チャット', description: '会話を整理する', headings: ['会話'], paragraphs: ['ファイルを選ぶと会話に添付できます。'] },
      ],
    };
    expect(searchDocs({ index, query: 'ファイル 選ぶ' }).map(item => item.href)).toEqual(index.entries.map(item => item.href));
    expect(searchDocs({ index, query: 'ＦＡＩＬ' })).toEqual([]);
    expect(searchDocs({ index, query: '読み取り ファイル' }).map(item => item.href)).toEqual(['/docs/ja/files/privacy/']);
    expect(searchDocs({ index, query: '　' })).toEqual([]);
    expect(searchDocs({ index, query: '保存' })[0]?.snippet).toContain('保存');
    const english: SearchIndex = { locale: 'en', entries: [{ href: '/docs/en/data/backup/', title: 'Back up ZIP files', description: 'Save a ZIP', headings: ['Restore a backup'], paragraphs: ['Restore your conversations from a ZIP.'] }] };
    expect(searchDocs({ index: english, query: 'BACKUP zip' })).toHaveLength(1);
  });

  it('publishes locale-specific article indexes and serves the same content in development', async () => {
    await using fixture = await createSiteFixture();
    await build({ ...docsBuildConfig({ root: fixture.docs }), configFile: false, logLevel: 'silent' });
    await using dev = await startSiteDev({ root: fixture.root });
    const expectedHrefs = (locale: 'en' | 'ja') => DOCS_PAGES.map(page => docsHref({ locale, page: page.id }));
    for (const locale of ['en', 'ja'] as const) {
      const file = await readFile(path.join(fixture.docs, 'dist', `search-${locale}.json`), 'utf8');
      const production = parseSearchIndex({ value: JSON.parse(file) as unknown, locale });
      const response = await dev.request({ url: `/docs/search-${locale}.json` });
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('application/json');
      const development = parseSearchIndex({ value: await response.json() as unknown, locale });
      expect(development).toEqual(production);
      expect(production.entries.map(item => item.href)).toEqual(expectedHrefs(locale));
      const purposes = purposeDocs({ index: production });
      expect(purposes.map(item => item.href)).toEqual(['run/standalone', 'models/ollama', 'chat/branching', 'images/create', 'data/backup'].map(page => `/docs/${locale}/${page}/`));
      for (const hit of purposes) expect(hit.snippet).toBe(production.entries.find(entry => entry.href === hit.href)?.description);
      expect(file).not.toContain('Project notes');
      const guide = await dev.request({ url: docsHref({ locale, page: 'files/privacy' }) });
      expect(guide.status).toBe(200);
      using page = parsePage({ html: await guide.text() });
      expect(page.document.querySelector('[data-testid="docs-search-trigger"]')?.getAttribute('aria-label')).toBe(locale === 'ja' ? 'ドキュメントを検索' : 'Search docs');
      expect(page.document.querySelector('[data-docs-island="search"]')).not.toBeNull();
      const relatedLabel = page.document.querySelector('[data-docs-related-guide] .related-eyebrow')?.textContent?.trim();
      expect(relatedLabel).toBeTruthy();
      expect(production.entries.find(entry => entry.href === docsHref({ locale, page: 'files/privacy' }))?.paragraphs).not.toContain(relatedLabel);
      expect(page.document.querySelector('link[rel="canonical"]')?.getAttribute('href')).toContain(`/docs/${locale}/files/privacy/`);
      const home = await dev.request({ url: '/docs/' });
      using neutral = parsePage({ html: await home.text() });
      for (const template of neutral.document.querySelectorAll<HTMLTemplateElement>('template[data-docs-locale]')) {
        expect(template.content.querySelectorAll('[data-docs-island="search"]')).toHaveLength(1);
      }
      expect(neutral.document.querySelectorAll('script[type="module"]')).toHaveLength(2);
    }
    const japanese = parseSearchIndex({ value: JSON.parse(await readFile(path.join(fixture.docs, 'dist/search-ja.json'), 'utf8')) as unknown, locale: 'ja' });
    expect(searchDocs({ index: japanese, query: 'バックアップ ZIP' }).some(item => item.href === '/docs/ja/data/backup/')).toBe(true);
    expect(searchDocs({ index: japanese, query: '新しいチャット' }).some(item => item.href === '/docs/ja/')).toBe(false);
    expect(() => parseSearchIndex({ value: { locale: 'ja', entries: [{ href: 'https://elsewhere.example/', title: 'Wrong', headings: [], paragraphs: [] }] }, locale: 'ja' })).toThrow();
    const workerAsset = (await readdir(path.join(fixture.docs, 'dist/assets'))).find(file => /^worker-.+\.js$/u.test(file));
    if (!workerAsset) throw new Error('Missing generated Docs search worker');
    const workerMessages: SearchWorkerResponse[] = [];
    let receive: ((event: { data: unknown }) => void) | undefined;
    const endpoint = {
      addEventListener: vi.fn((_type: string, listener: (event: { data: unknown }) => void) => {
        receive = listener;
      }),
      postMessage: vi.fn((message: SearchWorkerResponse) => workerMessages.push(message)),
    };
    let englishFailures = 1;
    const fetchIndex = vi.fn(async (url: string) => {
      const language = url.endsWith('search-ja.json') ? 'ja' : 'en';
      if (language === 'en' && englishFailures > 0) {
        englishFailures -= 1;
        throw new Error('Temporary index failure');
      }
      return new Response(await readFile(path.join(fixture.docs, 'dist', `search-${language}.json`), 'utf8'));
    });
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    using _errors = { [Symbol.dispose]: () => errors.mockRestore() };
    new Script(await readFile(path.join(fixture.docs, 'dist/assets', workerAsset), 'utf8')).runInNewContext({ self: endpoint, fetch: fetchIndex, console });
    if (!receive) throw new Error('Generated Docs worker did not register its request handler');
    receive({ data: { requestId: 1, locale: 'ja', query: '' } });
    receive({ data: { requestId: 2, locale: 'ja', query: 'バックアップ' } });
    receive({ data: { requestId: 3, locale: 'ja', query: '保存先' } });
    await vi.waitFor(() => expect(workerMessages).toHaveLength(3));
    expect(fetchIndex).toHaveBeenCalledTimes(1);
    const purposeMessage = workerMessages.find(message => message.requestId === 1);
    expect(purposeMessage?.kind).toBe('results');
    if (purposeMessage?.kind !== 'results') throw new Error('Missing Docs worker purpose guides');
    expect(purposeMessage.results).toEqual(purposeDocs({ index: japanese }));
    const firstMessage = workerMessages.find(message => message.requestId === 2);
    expect(firstMessage?.kind).toBe('results');
    if (firstMessage?.kind !== 'results') throw new Error('Missing Docs worker search results');
    expect(firstMessage.results.some(hit => hit.href === '/docs/ja/data/backup/')).toBe(true);
    receive({ data: { requestId: 4, locale: 'en', query: 'backup' } });
    await vi.waitFor(() => expect(workerMessages).toHaveLength(4));
    expect(workerMessages[3]).toEqual({ kind: 'error', requestId: 4 });
    receive({ data: { requestId: 5, locale: 'en', query: 'backup' } });
    await vi.waitFor(() => expect(workerMessages).toHaveLength(5));
    expect(fetchIndex).toHaveBeenCalledTimes(3);
    expect(workerMessages[4]?.kind).toBe('results');
  });

  it('hydrates the header palette and ignores stale worker results', async () => {
    await using fixture = await createSiteFixture();
    await build({ ...docsBuildConfig({ root: fixture.docs }), configFile: false, logLevel: 'silent' });
    const dist = path.join(fixture.docs, 'dist');
    using page = parsePage({ html: await readFile(path.join(dist, 'ja/files/privacy/index.html'), 'utf8') });
    const source = page.document.querySelector<HTMLScriptElement>('script[src*="island-search"]')?.getAttribute('src');
    const root = page.document.querySelector<HTMLElement>('[data-docs-island="search"]');
    if (!source || !root) throw new Error('Missing production Docs search island');
    const index = parseSearchIndex({ value: JSON.parse(await readFile(path.join(dist, 'search-ja.json'), 'utf8')) as unknown, locale: 'ja' });
    const dom = page.document.defaultView;
    if (!dom) throw new Error('Missing page window');
    for (const name of ['window', 'document', 'navigator', 'Node', 'Element', 'HTMLElement', 'HTMLInputElement', 'HTMLDialogElement', 'SVGElement', 'Event', 'MutationObserver'] as const) {
      vi.stubGlobal(name, name === 'window' ? dom : name === 'document' ? page.document : dom[name]);
    }
    Object.defineProperty(dom.HTMLDialogElement.prototype, 'showModal', {
      configurable: true,
      value(this: HTMLDialogElement) {
        this.setAttribute('open', '');
      },
    });
    Object.defineProperty(dom.HTMLDialogElement.prototype, 'close', {
      configurable: true,
      value(this: HTMLDialogElement) {
        this.removeAttribute('open');
      },
    });
    const listeners = new Set<(event: MessageEvent<unknown>) => void>();
    const requests: SearchWorkerRequest[] = [];
    const worker = {
      onerror: null,
      addEventListener: vi.fn((_name: string, listener: (event: MessageEvent<unknown>) => void) => listeners.add(listener)),
      removeEventListener: vi.fn((_name: string, listener: (event: MessageEvent<unknown>) => void) => listeners.delete(listener)),
      postMessage: vi.fn((value: unknown) => requests.push(parseWorkerRequest({ value }))),
      terminate: vi.fn(),
      emit({ response }: { response: SearchWorkerResponse }) {
        for (const listener of listeners) listener({ data: response } as MessageEvent<unknown>);
      },
    };
    const workerConstructor = vi.fn(function() {
      return worker;
    });
    vi.stubGlobal('Worker', workerConstructor);
    const fetchMock = vi.fn(() => {
      throw new Error('Main thread must not fetch the search index');
    });
    vi.stubGlobal('fetch', fetchMock);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    using _cleanup = {
      [Symbol.dispose]() {
        vi.unstubAllGlobals();
        error.mockRestore();
      },
    };
    expect(root.querySelector('button')?.disabled).toBe(true);
    const pathname = new URL(source, 'https://naidan.invalid').pathname;
    await import(pathToFileURL(path.join(dist, pathname.slice('/docs/'.length))).href);
    page.document.dispatchEvent(new dom.Event('DOMContentLoaded'));
    await vi.waitFor(() => expect(root.dataset.docsHydrated).toBe('ready'));
    const input = root.querySelector<HTMLInputElement>('[data-testid="docs-search-input"]');
    if (!input) throw new Error('Missing search input');
    const trigger = root.querySelector<HTMLButtonElement>('[data-testid="docs-search-trigger"]');
    expect(trigger?.disabled).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    trigger?.focus();
    trigger?.click();
    expect(root.querySelector('dialog')?.open).toBe(true);
    expect(page.document.body.style.overflow).toBe('hidden');
    expect(requests).toHaveLength(1);
    worker.emit({ response: { kind: 'error', requestId: requests[0]?.requestId ?? -1 } });
    await vi.waitFor(() => expect(root.querySelector('[role="alert"]')?.textContent).toContain('読み込めません'));
    root.querySelector<HTMLButtonElement>('.docs-search-retry')?.click();
    expect(requests).toHaveLength(2);
    const purposeMatches = purposeDocs({ index });
    worker.emit({ response: { kind: 'results', requestId: requests[1]?.requestId ?? -1, results: purposeMatches } });
    await vi.waitFor(() => expect(root.querySelectorAll('[data-testid="docs-search-results"] a')).toHaveLength(5));
    expect(root.querySelector('.search-status')?.textContent).toContain('目的から探す');
    expect(root.querySelector<HTMLAnchorElement>('[data-testid="docs-search-results"] a')?.getAttribute('href')).toBe('/docs/ja/run/standalone/');
    const stableList = root.querySelector('[data-testid="docs-search-results"]');
    const stableStatus = root.querySelector('.search-status');
    input.value = 'バックアップ';
    input.dispatchEvent(new dom.Event('input', { bubbles: true }));
    expect(requests).toHaveLength(3);
    await vi.waitFor(() => expect(root.querySelector('.search-status')?.textContent).toContain('検索しています… · 目的から探す'));
    expect(root.querySelector('[data-testid="docs-search-results"]')).toBe(stableList);
    expect(root.querySelector<HTMLAnchorElement>('[data-testid="docs-search-results"] a')?.getAttribute('href')).toBe('/docs/ja/run/standalone/');
    const matches = searchDocs({ index, query: 'バックアップ' }).map(({ href, title, snippet }) => ({ href, title, snippet }));
    worker.emit({ response: { kind: 'results', requestId: requests[2]?.requestId ?? -1, results: matches } });
    await vi.waitFor(() => expect(root.querySelectorAll('[data-testid="docs-search-results"] a').length).toBeGreaterThan(0));
    worker.emit({ response: { kind: 'results', requestId: requests[1]?.requestId ?? -1, results: [] } });
    const first = root.querySelector<HTMLAnchorElement>('[data-testid="docs-search-results"] a');
    expect(first?.getAttribute('href')).toBe('/docs/ja/data/backup/');
    input.focus();
    input.dispatchEvent(new dom.KeyboardEvent('keydown', { key: 'ArrowDown', isComposing: true, bubbles: true }));
    expect(page.document.activeElement).toBe(input);
    input.dispatchEvent(new dom.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    expect(page.document.activeElement).toBe(first);
    const content = root.querySelector<HTMLElement>('.docs-search-content');
    if (!content) throw new Error('Missing Docs search result scroller');
    content.scrollTop = 50;
    input.value = '保存先';
    input.dispatchEvent(new dom.Event('input', { bubbles: true }));
    expect(requests).toHaveLength(4);
    await vi.waitFor(() => expect(root.querySelector('.search-status')?.textContent).toContain('前の検索結果: “バックアップ”'));
    expect(root.querySelector('[data-testid="docs-search-results"]')).toBe(stableList);
    expect(root.querySelector('.search-status')).toBe(stableStatus);
    expect(content.scrollTop).toBe(50);
    expect(root.querySelector<HTMLAnchorElement>('[data-testid="docs-search-results"] a')?.getAttribute('href')).toBe('/docs/ja/data/backup/');
    expect(root.querySelector('.search-status')?.textContent).toContain('検索しています');
    worker.emit({ response: { kind: 'results', requestId: requests[2]?.requestId ?? -1, results: [] } });
    expect(root.querySelector<HTMLAnchorElement>('[data-testid="docs-search-results"] a')?.getAttribute('href')).toBe('/docs/ja/data/backup/');
    const storageMatches = searchDocs({ index, query: '保存先' }).map(({ href, title, snippet }) => ({ href, title, snippet }));
    worker.emit({ response: { kind: 'results', requestId: requests[3]?.requestId ?? -1, results: storageMatches } });
    await vi.waitFor(() => expect(root.querySelector<HTMLAnchorElement>('[data-testid="docs-search-results"] a')?.getAttribute('href')).toBe('/docs/ja/data/storage/'));
    expect(root.querySelector('[data-testid="docs-search-results"]')).toBe(stableList);
    expect(root.querySelector('.search-status')).toBe(stableStatus);
    expect(root.querySelector('.search-status')?.textContent).not.toContain('前の検索結果');
    input.value = '';
    input.dispatchEvent(new dom.Event('input', { bubbles: true }));
    expect(requests).toHaveLength(5);
    await vi.waitFor(() => expect(root.querySelector('.search-status')?.textContent).toContain('前の検索結果: “保存先”'));
    expect(root.querySelector<HTMLAnchorElement>('[data-testid="docs-search-results"] a')?.getAttribute('href')).toBe('/docs/ja/data/storage/');
    worker.emit({ response: { kind: 'results', requestId: requests[3]?.requestId ?? -1, results: [] } });
    expect(root.querySelector<HTMLAnchorElement>('[data-testid="docs-search-results"] a')?.getAttribute('href')).toBe('/docs/ja/data/storage/');
    worker.emit({ response: { kind: 'results', requestId: requests[4]?.requestId ?? -1, results: purposeMatches } });
    await vi.waitFor(() => expect(root.querySelectorAll('[data-testid="docs-search-results"] a')).toHaveLength(5));
    expect(root.querySelector<HTMLAnchorElement>('[data-testid="docs-search-results"] a')?.getAttribute('href')).toBe('/docs/ja/run/standalone/');
    expect(root.querySelector('.search-status')?.textContent).toContain('目的から探す');
    expect(root.querySelector('[data-testid="docs-search-results"]')).toBe(stableList);
    input.focus();
    input.dispatchEvent(new dom.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    expect(page.document.activeElement).toBe(root.querySelector('[data-testid="docs-search-results"] a'));
    const cancel = new dom.Event('cancel', { cancelable: true });
    root.querySelector('dialog')?.dispatchEvent(cancel);
    expect(root.querySelector('dialog')?.open).toBe(false);
    expect(page.document.activeElement).toBe(trigger);
    expect(page.document.body.style.overflow).toBe('');
    page.document.dispatchEvent(new dom.KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true, cancelable: true }));
    expect(root.querySelector('dialog')?.open).toBe(true);
    expect(requests).toHaveLength(6);
    await vi.waitFor(() => expect(root.querySelectorAll('[data-testid="docs-search-results"] a')).toHaveLength(0));
    worker.emit({ response: { kind: 'results', requestId: requests[4]?.requestId ?? -1, results: storageMatches } });
    expect(root.querySelectorAll('[data-testid="docs-search-results"] a')).toHaveLength(0);
    worker.emit({ response: { kind: 'results', requestId: requests[5]?.requestId ?? -1, results: purposeMatches } });
    await vi.waitFor(() => expect(root.querySelectorAll('[data-testid="docs-search-results"] a')).toHaveLength(5));
    page.document.dispatchEvent(new dom.KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true, cancelable: true }));
    expect(root.querySelector('dialog')?.open).toBe(false);
    expect(workerConstructor).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it('activates search only after the language-neutral home mounts its chosen locale', async () => {
    await using fixture = await createSiteFixture();
    await build({ ...docsBuildConfig({ root: fixture.docs }), configFile: false, logLevel: 'silent' });
    const dist = path.join(fixture.docs, 'dist');
    const dom = new JSDOM(await readFile(path.join(dist, 'index.html'), 'utf8'), { url: 'https://naidan.invalid/docs/', runScripts: 'outside-only' });
    using _browser = { [Symbol.dispose]: () => dom.window.close() };
    const document = dom.window.document;
    Object.defineProperty(document, 'readyState', { configurable: true, get: () => 'loading' });
    Object.defineProperty(dom.window.navigator, 'languages', { configurable: true, value: ['ja'] });
    const bootstrap = document.querySelector<HTMLScriptElement>('script:not([type])[src]')?.getAttribute('src');
    const search = document.querySelector<HTMLScriptElement>('script[type="module"][src]')?.getAttribute('src');
    if (!bootstrap || !search) throw new Error('Missing neutral-home scripts');
    new Script(await readFile(path.join(dist, bootstrap.slice('/docs/'.length)), 'utf8')).runInContext(dom.getInternalVMContext());
    for (const name of ['window', 'document', 'navigator', 'Node', 'Element', 'HTMLElement', 'HTMLDialogElement', 'SVGElement', 'Event', 'MutationObserver'] as const) {
      vi.stubGlobal(name, name === 'window' ? dom.window : name === 'document' ? document : dom.window[name]);
    }
    using _cleanup = { [Symbol.dispose]: () => vi.unstubAllGlobals() };
    await import(pathToFileURL(path.join(dist, search.slice('/docs/'.length))).href);
    document.dispatchEvent(new dom.window.Event('DOMContentLoaded'));
    await vi.waitFor(() => expect(document.querySelector('[data-docs-island="search"]')?.getAttribute('data-docs-hydrated')).toBe('ready'));
    expect(document.documentElement.lang).toBe('ja');
    expect(document.querySelectorAll('[data-docs-island="search"]')).toHaveLength(1);
    expect(document.querySelector('[data-testid="docs-search-trigger"]')?.getAttribute('aria-label')).toBe('ドキュメントを検索');
    expect(document.querySelectorAll('template[data-docs-locale]')).toHaveLength(0);
  });
});
