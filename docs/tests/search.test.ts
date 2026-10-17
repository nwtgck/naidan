import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Script } from 'node:vm';
import { MessageChannel } from 'node:worker_threads';
import * as Comlink from 'comlink';
import { JSDOM } from 'jsdom';
import { build } from 'vite';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { docsBuildConfig } from '../build/production';
import { messages as enSearchMessages } from '../messages/search-ui/en';
import { messages as jaSearchMessages } from '../messages/search-ui/ja';
import { messages as homeEn } from '../pages/index/messages/en';
import { messages as homeJa } from '../pages/index/messages/ja';
import { DOCS_PAGES, docsHref } from '../navigation/routes';
import type { DocsLocale } from '../navigation/routes';
import { parseSearchIndex, purposeDocs, searchDocs } from '../search/search';
import type { SearchIndex } from '../search/search';
import { PURPOSE_PAGES } from '../search/search-purpose';
import { parseSearchPayload } from '../islands/search/contracts';
import { parseWorkerRequest, parseWorkerResponse } from '../islands/search/worker-contracts';
import type { SearchWorkerApi, SearchWorkerRequest, SearchWorkerResponse } from '../islands/search/worker-contracts';
import { createSiteFixture, parsePage, startSiteDev } from './site.test-support';

describe('Docs search', () => {
  it('renders complete English and Japanese result counts and previous-query labels', () => {
    expect(enSearchMessages.search_ui_result_count({ count: 1 })).toBe('1 result');
    expect(enSearchMessages.search_ui_result_count({ count: 2 })).toBe('2 results');
    expect(jaSearchMessages.search_ui_result_count({ count: 1 })).toBe('1件');
    expect(jaSearchMessages.search_ui_result_count({ count: 2 })).toBe('2件');
    expect(enSearchMessages.search_ui_previous_results({ query: 'backup' })).toBe('Showing previous results for “backup”');
    expect(jaSearchMessages.search_ui_previous_results({ query: 'バックアップ' })).toBe('「バックアップ」の前の検索結果を表示中');
  });

  it('matches Japanese substrings and multiple terms while preferring titles and headings', () => {
    const index: SearchIndex = {
      locale: 'ja',
      entries: [
        { href: '/docs/ja/file-access/', title: 'ファイルを選ぶ', description: '読む範囲を選ぶ', headings: ['読み取り権限'], paragraphs: ['ファイルを読み取る範囲を選択します。'] },
        { href: '/docs/ja/data-storage/', title: '保存先', description: '場所を選ぶ', headings: ['ファイルを選ぶ'], paragraphs: ['保存する場所を選択します。'] },
        { href: '/docs/ja/chat-groups/', title: 'チャット', description: '会話を整理する', headings: ['会話'], paragraphs: ['ファイルを選ぶと会話に添付できます。'] },
      ],
    };
    expect(searchDocs({ index, query: 'ファイル 選ぶ' }).map(item => item.href)).toEqual(index.entries.map(item => item.href));
    expect(searchDocs({ index, query: 'ＦＡＩＬ' })).toEqual([]);
    expect(searchDocs({ index, query: '読み取り ファイル' }).map(item => item.href)).toEqual(['/docs/ja/file-access/']);
    expect(searchDocs({ index, query: '　' })).toEqual([]);
    expect(searchDocs({ index, query: '保存' })[0]?.snippet).toContain('保存');
    const english: SearchIndex = { locale: 'en', entries: [{ href: '/docs/en/data-backup/', title: 'Back up ZIP files', description: 'Save a ZIP', headings: ['Restore a backup'], paragraphs: ['Restore your conversations from a ZIP.'] }] };
    expect(searchDocs({ index: english, query: 'BACKUP zip' })).toHaveLength(1);
    expect(searchDocs({ index: english, query: 'BACKUP unicorn' })).toEqual([]);
    const broad: SearchIndex = { locale: 'ja', entries: Array.from({ length: 8 }, (_, number) => ({ href: `/docs/ja/example-${number}/`, title: `保存先 ${number}`, description: '', headings: [], paragraphs: [] })) };
    expect(searchDocs({ index: broad, query: '保存先を変えたい' })).toHaveLength(5);
    expect(parseWorkerResponse({ value: { kind: 'results', requestId: 1, results: [{ href: '/docs/ja/', title: 'Home', snippet: '' }] }, locale: 'ja' })).toEqual({ kind: 'results', requestId: 1, results: [{ href: '/docs/ja/', title: 'Home', snippet: '' }] });
    expect(() => parseWorkerResponse({ value: { kind: 'results', requestId: 1, results: [{ href: '/docs/en/data-backup/', title: 'Wrong locale', snippet: '' }] }, locale: 'ja' })).toThrow();
    for (const href of ['/docs/ja/../../', '/docs/ja/unregistered/', '/docs/ja/file-access/?q=1']) {
      expect(() => parseWorkerResponse({ value: { kind: 'results', requestId: 1, results: [{ href, title: 'Unregistered', snippet: '' }] }, locale: 'ja' })).toThrow();
    }
  });

  describe('published article indexes', () => {
    let published: { indexes: Record<DocsLocale, string>; standalone: Record<DocsLocale, string>; worker: string };

    beforeAll(async () => {
      await using fixture = await createSiteFixture();
      await build({ ...docsBuildConfig({ root: fixture.docs }), configFile: false, logLevel: 'silent' });
      const dist = path.join(fixture.docs, 'dist');
      const workerAsset = (await readdir(path.join(dist, 'assets'))).find(file => /^worker-.+\.js$/u.test(file));
      if (!workerAsset) {
        throw new Error('Missing generated Docs search worker');
      }
      // These checks read one real production build. Hydration tests retain
      // independent fixtures so their browser module instances stay isolated.
      published = {
        indexes: { en: await readFile(path.join(dist, 'search-en.json'), 'utf8'), ja: await readFile(path.join(dist, 'search-ja.json'), 'utf8') },
        standalone: { en: await readFile(path.join(dist, 'en/standalone/index.html'), 'utf8'), ja: await readFile(path.join(dist, 'ja/standalone/index.html'), 'utf8') },
        worker: await readFile(path.join(dist, 'assets', workerAsset), 'utf8'),
      };
    });

    it('publishes locale-specific article indexes and serves the same content in development', async () => {
      await using fixture = await createSiteFixture();
      await using dev = await startSiteDev({ root: fixture.root });
      for (const locale of ['en', 'ja'] as const) {
        const file = published.indexes[locale];
        const production = parseSearchIndex({ value: JSON.parse(file) as unknown, locale });
        const response = await dev.request({ url: `/docs/search-${locale}.json` });
        expect(response.status).toBe(200);
        expect(response.headers.get('content-type')).toContain('application/json');
        const development = parseSearchIndex({ value: await response.json() as unknown, locale });
        expect(development).toEqual(production);
        expect(production.entries.map(item => item.href)).toEqual(DOCS_PAGES.map(page => docsHref({ locale, page: page.id })));
        const homeMessages = locale === 'en' ? homeEn : homeJa;
        const homeEntry = production.entries.find(entry => entry.href === docsHref({ locale, page: 'index' }));
        for (const heading of [homeMessages.gguf_answer_in_browser_heading, homeMessages.cat_image_in_browser_heading, homeMessages.speech_in_browser_heading]) {
          expect(homeEntry?.headings).toContain(heading);
        }
        for (const paragraph of [homeMessages.gguf_answer_in_browser_description, homeMessages.cat_image_in_browser_description, homeMessages.speech_in_browser_description]) {
          expect(homeEntry?.paragraphs).toContain(paragraph);
        }
        for (const diagramText of [homeMessages.chat_question, homeMessages.cat_image_prompt, homeMessages.speech_text]) {
          expect(homeEntry?.paragraphs).not.toContain(diagramText);
        }
        const purposes = purposeDocs({ index: production });
        expect(purposes.map(item => item.href)).toEqual(PURPOSE_PAGES.map(page => docsHref({ locale, page })));
        for (const hit of purposes) {
          expect(hit.snippet).toBe(production.entries.find(entry => entry.href === hit.href)?.description);
        }
        expect(file).not.toContain('Project notes');
        const guide = await dev.request({ url: docsHref({ locale, page: 'file-access' }) });
        expect(guide.status).toBe(200);
        using page = parsePage({ html: await guide.text() });
        expect(page.document.querySelector('[data-testid="docs-search-trigger"]')?.getAttribute('aria-label')).toBe(locale === 'ja' ? 'ドキュメントを検索' : 'Search docs');
        const searchHost = page.document.querySelector('[data-docs-island="search"]');
        if (!searchHost) {
          throw new Error('Missing Docs search island');
        }
        const serialized = searchHost.getAttribute('data-docs-props') ?? '';
        expect(Object.keys(JSON.parse(serialized) as object).sort()).toEqual(['currentPage', 'locale', 'purpose']);
        const payload = parseSearchPayload({ serialized });
        expect(payload.locale).toBe(locale);
        expect(payload.currentPage).toBe('file-access');
        expect(payload.purpose.map(item => item.href)).toEqual(PURPOSE_PAGES.map(purposePage => docsHref({ locale, page: purposePage })));
        expect(payload.purpose.every(item => item.title.trim() && item.snippet.trim())).toBe(true);
        expect(Array.from(searchHost.querySelectorAll<HTMLAnchorElement>('[data-testid="docs-search-results"] a'), link => link.getAttribute('href'))).toEqual(payload.purpose.map(item => item.href));
        expect(() => parseSearchPayload({ serialized: JSON.stringify({ ...payload, purpose: [{ ...payload.purpose[0], href: docsHref({ locale: locale === 'en' ? 'ja' : 'en', page: PURPOSE_PAGES[0] }) }, ...payload.purpose.slice(1)] }) })).toThrow();
        expect(() => parseSearchPayload({ serialized: JSON.stringify({ ...payload, currentPage: 'not-a-page' }) })).toThrow();
        expect(() => parseSearchPayload({ serialized: JSON.stringify({ ...payload, locale: 'fr' }) })).toThrow();
        using currentPurpose = parsePage({ html: published.standalone[locale] });
        const selfLink = currentPurpose.document.querySelector<HTMLAnchorElement>(`[data-docs-island="search"] [data-testid="docs-search-results"] a[href="${docsHref({ locale, page: 'standalone' })}"]`);
        expect(selfLink?.hasAttribute('data-docs-guide-prefetch')).toBe(false);
        const relatedLabel = page.document.querySelector('[data-docs-related-guide] .related-eyebrow')?.textContent?.trim();
        expect(relatedLabel).toBeTruthy();
        expect(production.entries.find(entry => entry.href === docsHref({ locale, page: 'file-access' }))?.paragraphs).not.toContain(relatedLabel);
        expect(page.document.querySelector('link[rel="canonical"]')?.getAttribute('href')).toContain(`/docs/${locale}/file-access/`);
      }
      const home = await dev.request({ url: '/docs/' });
      using neutral = parsePage({ html: await home.text() });
      for (const template of neutral.document.querySelectorAll<HTMLTemplateElement>('template[data-docs-locale]')) {
        const root = template.content.querySelector('[data-docs-island="search"]');
        if (!root) {
          throw new Error('Missing neutral-home search island');
        }
        const templateLocale = template.getAttribute('data-docs-locale');
        const serialized = root.getAttribute('data-docs-props') ?? '';
        expect(Object.keys(JSON.parse(serialized) as object).sort()).toEqual(['currentPage', 'locale', 'purpose']);
        const templatePayload = parseSearchPayload({ serialized });
        expect(templatePayload.locale).toBe(templateLocale);
        expect(templatePayload.currentPage).toBe('index');
        expect(Array.from(root.querySelectorAll<HTMLAnchorElement>('[data-testid="docs-search-results"] a'), link => link.getAttribute('href'))).toEqual(templatePayload.purpose.map(item => item.href));
      }
      expect(neutral.document.querySelector('script[src="/docs/@id/__x00__virtual:naidan-docs/island/search"]')).not.toBeNull();
      expect(neutral.document.querySelector('script[src="/docs/client/home-brand.ts"]')).not.toBeNull();
      expect(neutral.document.querySelector('script[src="/docs/client/app-entry.ts"]')).not.toBeNull();
    });

    it('searches published Japanese prose and rejects malformed article indexes', () => {
      const japanese = parseSearchIndex({ value: JSON.parse(published.indexes.ja) as unknown, locale: 'ja' });
      expect(searchDocs({ index: japanese, query: 'バックアップ ZIP' }).some(item => item.href === '/docs/ja/data-backup/')).toBe(true);
      expect(searchDocs({ index: japanese, query: '新しいチャット' }).some(item => item.href === '/docs/ja/')).toBe(false);
      for (const [query, expectedHref] of [
        ['バックアップしたい', '/docs/ja/data-backup/'],
        ['バックアップしたいです。', '/docs/ja/data-backup/'],
        ['保存先を変えたい', '/docs/ja/data-storage/'],
        ['ファイルを渡したい', '/docs/ja/file-access/'],
        ['音声を保存したい', '/docs/ja/audio-generation/'],
        ['シェルを有効にしたい', '/docs/ja/tool-browser-shell/'],
      ] as const) {
        const results = searchDocs({ index: japanese, query });
        expect(results[0]?.href).toBe(expectedHref);
        expect(results.length).toBeLessThanOrEqual(5);
      }
      expect(searchDocs({ index: japanese, query: 'GGUF' }).some(item => item.href === '/docs/ja/endpoint-type-llama-cpp-browser/')).toBe(true);
      expect(searchDocs({ index: japanese, query: '量子ユニコーンを飼いたい' })).toEqual([]);
      expect(searchDocs({ index: japanese, query: 'したい' })).toEqual([]);
      expect(searchDocs({ index: japanese, query: 'をしたい。' })).toEqual([]);
      expect(searchDocs({ index: japanese, query: '絵をしたい' })).toEqual([]);
      expect(searchDocs({ index: japanese, query: 'AIを使いたい' }).length).toBeLessThanOrEqual(5);
      expect(() => parseSearchIndex({ value: { locale: 'ja', entries: [{ href: 'https://elsewhere.example/', title: 'Wrong', headings: [], paragraphs: [] }] }, locale: 'ja' })).toThrow();
      expect(() => parseSearchIndex({ value: { ...japanese, locale: 'en' }, locale: 'ja' })).toThrow();
      expect(() => parseSearchIndex({ value: { ...japanese, entries: [{ ...japanese.entries[0], headings: [1] }, ...japanese.entries.slice(1)] }, locale: 'ja' })).toThrow();
      expect(() => parseSearchIndex({ value: { ...japanese, entries: japanese.entries.slice(1) }, locale: 'ja' })).toThrow();
      expect(() => parseSearchIndex({ value: { ...japanese, entries: [...japanese.entries.slice(1), japanese.entries[1]] }, locale: 'ja' })).toThrow();
    });

    it('shares locale index requests and retries failures in the generated search worker', async () => {
      const japanese = parseSearchIndex({ value: JSON.parse(published.indexes.ja) as unknown, locale: 'ja' });
      const channel = new MessageChannel();
      using _ports = {
        [Symbol.dispose]() {
          channel.port1.close();
          channel.port2.close();
        },
      };
      let englishFailures = 1;
      const fetchIndex = vi.fn(async (url: string) => {
        const language = url.endsWith('search-ja.json') ? 'ja' : 'en';
        if (language === 'en' && englishFailures > 0) {
          englishFailures -= 1;
          throw new Error('Temporary index failure');
        }
        return new Response(published.indexes[language]);
      });
      const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
      using _errors = { [Symbol.dispose]: () => errors.mockRestore() };
      new Script(published.worker).runInNewContext({
        addEventListener: channel.port2.addEventListener.bind(channel.port2),
        removeEventListener: channel.port2.removeEventListener.bind(channel.port2),
        postMessage: channel.port2.postMessage.bind(channel.port2),
        fetch: fetchIndex,
        console,
      });
      channel.port2.start();
      const remote = Comlink.wrap<SearchWorkerApi>(channel.port1 as unknown as Comlink.Endpoint);
      using _remote = { [Symbol.dispose]: () => remote[Comlink.releaseProxy]() };
      const workerMessages = await Promise.all([
        remote.search({ request: { requestId: 1, locale: 'ja', query: '' } }),
        remote.search({ request: { requestId: 2, locale: 'ja', query: 'バックアップ' } }),
        remote.search({ request: { requestId: 3, locale: 'ja', query: '保存先' } }),
      ]);
      expect(fetchIndex).toHaveBeenCalledTimes(1);
      const purposeMessage = workerMessages.find(message => message.requestId === 1);
      expect(purposeMessage?.kind).toBe('results');
      if (purposeMessage?.kind !== 'results') {
        throw new Error('Missing Docs worker purpose guides');
      }
      expect(purposeMessage.results).toEqual(purposeDocs({ index: japanese }));
      const firstMessage = workerMessages.find(message => message.requestId === 2);
      expect(firstMessage?.kind).toBe('results');
      if (firstMessage?.kind !== 'results') {
        throw new Error('Missing Docs worker search results');
      }
      expect(firstMessage.results.some(hit => hit.href === '/docs/ja/data-backup/')).toBe(true);
      expect(await remote.search({ request: { requestId: 4, locale: 'en', query: 'backup' } })).toEqual({ kind: 'error', requestId: 4 });
      expect((await remote.search({ request: { requestId: 5, locale: 'en', query: 'backup' } })).kind).toBe('results');
      expect(fetchIndex).toHaveBeenCalledTimes(3);
      await expect(remote.search({ request: { requestId: 6, locale: 'fr', query: '' } as unknown as SearchWorkerRequest })).rejects.toThrow();
      expect(fetchIndex).toHaveBeenCalledTimes(3);
      const natural = await remote.search({ request: { requestId: 7, locale: 'ja', query: '保存先を変えたい' } });
      expect(natural.kind).toBe('results');
      if (natural.kind !== 'results') {
        throw new Error('Missing Docs natural-language search results');
      }
      expect(natural.results[0]?.href).toBe('/docs/ja/data-storage/');
      expect(fetchIndex).toHaveBeenCalledTimes(3);
    });
  });

  it('hydrates the header palette and ignores stale worker results', async () => {
    await using fixture = await createSiteFixture();
    await build({ ...docsBuildConfig({ root: fixture.docs }), configFile: false, logLevel: 'silent' });
    const dist = path.join(fixture.docs, 'dist');
    using page = parsePage({ html: await readFile(path.join(dist, 'ja/file-access/index.html'), 'utf8') });
    const source = page.document.querySelector<HTMLScriptElement>('script[src*="island-search"]')?.getAttribute('src');
    const root = page.document.querySelector<HTMLElement>('[data-docs-island="search"]');
    if (!source || !root) {
      throw new Error('Missing production Docs search island');
    }
    const index = parseSearchIndex({ value: JSON.parse(await readFile(path.join(dist, 'search-ja.json'), 'utf8')) as unknown, locale: 'ja' });
    const dom = page.document.defaultView;
    if (!dom) {
      throw new Error('Missing page window');
    }
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
    const channel = new MessageChannel();
    using _ports = {
      [Symbol.dispose]() {
        channel.port1.close();
        channel.port2.close();
      },
    };
    const requests: SearchWorkerRequest[] = [];
    const pending = new Map<number, { resolve: (response: unknown) => void; reject: (error: unknown) => void }>();
    const mockApi: SearchWorkerApi = {
      search({ request }) {
        const parsed = parseWorkerRequest({ value: request });
        requests.push(parsed);
        return new Promise((resolve, reject) => pending.set(parsed.requestId, {
          resolve: response => resolve(response as SearchWorkerResponse),
          reject,
        }));
      },
    };
    Comlink.expose(mockApi, channel.port2 as unknown as Comlink.Endpoint);
    const worker = {
      onerror: null,
      addEventListener: channel.port1.addEventListener.bind(channel.port1),
      removeEventListener: channel.port1.removeEventListener.bind(channel.port1),
      postMessage: channel.port1.postMessage.bind(channel.port1),
      terminate: vi.fn(() => {
        channel.port1.close();
        channel.port2.close();
      }),
      start: channel.port1.start.bind(channel.port1),
      emit({ response }: { response: SearchWorkerResponse }) {
        this.deliver({ requestId: response.requestId, response });
      },
      deliver({ requestId, response }: { requestId: number; response: unknown }) {
        pending.get(requestId)?.resolve(response);
        pending.delete(requestId);
      },
      reject({ requestId, error }: { requestId: number; error: unknown }) {
        pending.get(requestId)?.reject(error);
        pending.delete(requestId);
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
    const purposeMatches = parseSearchPayload({ serialized: root.getAttribute('data-docs-props') ?? '' }).purpose;
    expect(root.querySelector('button')?.disabled).toBe(true);
    expect(Array.from(root.querySelectorAll<HTMLAnchorElement>('[data-testid="docs-search-results"] a'), link => link.getAttribute('href'))).toEqual(purposeMatches.map(item => item.href));
    const pathname = new URL(source, 'https://naidan.invalid').pathname;
    await import(pathToFileURL(path.join(dist, pathname.slice('/docs/'.length))).href);
    page.document.dispatchEvent(new dom.Event('DOMContentLoaded'));
    await vi.waitFor(() => expect(root.dataset.docsHydrated).toBe('ready'));
    const input = root.querySelector<HTMLInputElement>('[data-testid="docs-search-input"]');
    if (!input) {
      throw new Error('Missing search input');
    }
    const trigger = root.querySelector<HTMLButtonElement>('[data-testid="docs-search-trigger"]');
    expect(trigger?.disabled).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    trigger?.focus();
    trigger?.click();
    expect(root.querySelector('dialog')?.open).toBe(true);
    expect(page.document.body.style.overflow).toBe('hidden');
    await vi.waitFor(() => expect(root.querySelectorAll('[data-testid="docs-search-results"] a')).toHaveLength(5));
    expect(root.querySelector('.search-status')?.textContent).toContain('目的から探す');
    expect(root.querySelector<HTMLAnchorElement>('[data-testid="docs-search-results"] a')?.getAttribute('href')).toBe('/docs/ja/standalone/');
    expect(root.querySelector<HTMLAnchorElement>('[data-testid="docs-search-results"] a')?.hasAttribute('data-docs-guide-prefetch')).toBe(true);
    expect(workerConstructor).not.toHaveBeenCalled();
    expect(requests).toHaveLength(0);
    const stableList = root.querySelector('[data-testid="docs-search-results"]');
    const stableStatus = root.querySelector('.search-status');
    input.value = 'バックアップ';
    input.dispatchEvent(new dom.Event('input', { bubbles: true }));
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    expect(workerConstructor).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(root.querySelector('.search-status')?.textContent).toContain('検索しています… · 目的から探す'));
    expect(root.querySelector('[data-testid="docs-search-results"]')).toBe(stableList);
    expect(root.querySelector<HTMLAnchorElement>('[data-testid="docs-search-results"] a')?.getAttribute('href')).toBe('/docs/ja/standalone/');
    worker.emit({ response: { kind: 'error', requestId: requests[0]?.requestId ?? -1 } });
    await vi.waitFor(() => expect(root.querySelector('[role="alert"]')?.textContent).toContain('読み込めません'));
    root.querySelector<HTMLButtonElement>('.docs-search-retry')?.click();
    await vi.waitFor(() => expect(requests).toHaveLength(2));
    const matches = searchDocs({ index, query: 'バックアップ' }).map(({ href, title, snippet }) => ({ href, title, snippet }));
    worker.emit({ response: { kind: 'results', requestId: requests[1]?.requestId ?? -1, results: matches } });
    await vi.waitFor(() => expect(root.querySelector<HTMLAnchorElement>('[data-testid="docs-search-results"] a')?.getAttribute('href')).toBe('/docs/ja/data-backup/'));
    const first = root.querySelector<HTMLAnchorElement>('[data-testid="docs-search-results"] a');
    expect(first?.getAttribute('href')).toBe('/docs/ja/data-backup/');
    input.focus();
    input.dispatchEvent(new dom.KeyboardEvent('keydown', { key: 'ArrowDown', isComposing: true, bubbles: true }));
    expect(page.document.activeElement).toBe(input);
    input.dispatchEvent(new dom.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    expect(page.document.activeElement).toBe(first);
    const content = root.querySelector<HTMLElement>('.docs-search-content');
    if (!content) {
      throw new Error('Missing Docs search result scroller');
    }
    content.scrollTop = 50;
    input.value = '保存先';
    input.dispatchEvent(new dom.Event('input', { bubbles: true }));
    await vi.waitFor(() => expect(requests).toHaveLength(3));
    await vi.waitFor(() => expect(root.querySelector('.search-status')?.textContent).toContain('「バックアップ」の前の検索結果を表示中'));
    expect(root.querySelector('[data-testid="docs-search-results"]')?.getAttribute('aria-label')).toBe('「バックアップ」の前の検索結果を表示中');
    expect(root.querySelector('[data-testid="docs-search-results"]')).toBe(stableList);
    expect(root.querySelector('.search-status')).toBe(stableStatus);
    expect(content.scrollTop).toBe(50);
    expect(root.querySelector<HTMLAnchorElement>('[data-testid="docs-search-results"] a')?.getAttribute('href')).toBe('/docs/ja/data-backup/');
    expect(root.querySelector('.search-status')?.textContent).toContain('検索しています');
    const storageMatches = searchDocs({ index, query: '保存先' }).map(({ href, title, snippet }) => ({ href, title, snippet }));
    worker.emit({ response: { kind: 'results', requestId: requests[2]?.requestId ?? -1, results: storageMatches } });
    await vi.waitFor(() => expect(root.querySelector<HTMLAnchorElement>('[data-testid="docs-search-results"] a')?.getAttribute('href')).toBe('/docs/ja/data-storage/'));
    expect(root.querySelector('.search-status')?.textContent).toBe(`${storageMatches.length}件`);
    expect(root.querySelector('[data-testid="docs-search-results"]')).toBe(stableList);
    expect(root.querySelector('.search-status')).toBe(stableStatus);
    expect(root.querySelector('.search-status')?.textContent).not.toContain('前の検索結果');
    input.value = 'stale';
    input.dispatchEvent(new dom.Event('input', { bubbles: true }));
    await vi.waitFor(() => expect(requests).toHaveLength(4));
    input.value = '';
    input.dispatchEvent(new dom.Event('input', { bubbles: true }));
    await vi.waitFor(() => expect(root.querySelector<HTMLAnchorElement>('[data-testid="docs-search-results"] a')?.getAttribute('href')).toBe('/docs/ja/standalone/'));
    expect(requests).toHaveLength(4);
    expect(root.querySelector('.search-status')?.textContent).toContain('目的から探す');
    worker.deliver({ requestId: requests[3]?.requestId ?? -1, response: { kind: 'results', requestId: requests[3]?.requestId ?? -1, results: [{ href: 7, title: 'Malformed', snippet: '' }] } });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(root.querySelector<HTMLAnchorElement>('[data-testid="docs-search-results"] a')?.getAttribute('href')).toBe('/docs/ja/standalone/');
    expect(root.querySelector('[role="alert"]')).toBeNull();
    expect(worker.terminate).not.toHaveBeenCalled();
    expect(root.querySelector('[data-testid="docs-search-results"]')).toBe(stableList);
    input.focus();
    input.dispatchEvent(new dom.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    expect(page.document.activeElement).toBe(root.querySelector('[data-testid="docs-search-results"] a'));
    input.value = '保存先';
    input.dispatchEvent(new dom.Event('input', { bubbles: true }));
    await vi.waitFor(() => expect(requests).toHaveLength(5));
    expect(workerConstructor).toHaveBeenCalledOnce();
    worker.emit({ response: { kind: 'results', requestId: requests[4]?.requestId ?? -1, results: storageMatches } });
    await vi.waitFor(() => expect(root.querySelector<HTMLAnchorElement>('[data-testid="docs-search-results"] a')?.getAttribute('href')).toBe('/docs/ja/data-storage/'));
    input.value = 'pending';
    input.dispatchEvent(new dom.Event('input', { bubbles: true }));
    await vi.waitFor(() => expect(requests).toHaveLength(6));
    const cancel = new dom.Event('cancel', { cancelable: true });
    root.querySelector('dialog')?.dispatchEvent(cancel);
    expect(root.querySelector('dialog')?.open).toBe(false);
    expect(page.document.activeElement).toBe(trigger);
    expect(page.document.body.style.overflow).toBe('');
    input.value = '';
    input.dispatchEvent(new dom.Event('input', { bubbles: true }));
    page.document.dispatchEvent(new dom.KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true, cancelable: true }));
    expect(root.querySelector('dialog')?.open).toBe(true);
    await vi.waitFor(() => expect(root.querySelectorAll('[data-testid="docs-search-results"] a')).toHaveLength(5));
    expect(requests).toHaveLength(6);
    worker.reject({ requestId: requests[5]?.requestId ?? -1, error: new Error('Stale request failed') });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(root.querySelectorAll('[data-testid="docs-search-results"] a')).toHaveLength(5);
    expect(root.querySelector('[role="alert"]')).toBeNull();
    expect(worker.terminate).not.toHaveBeenCalled();
    page.document.dispatchEvent(new dom.KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true, cancelable: true }));
    expect(root.querySelector('dialog')?.open).toBe(false);
    expect(workerConstructor).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    trigger?.click();
    await vi.waitFor(() => expect(root.querySelectorAll('[data-testid="docs-search-results"] a')).toHaveLength(5));
    expect(requests).toHaveLength(6);
    const onerror = worker.onerror as ((event: ErrorEvent) => void) | null;
    onerror?.(new dom.Event('error') as ErrorEvent);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(root.querySelectorAll('[data-testid="docs-search-results"] a')).toHaveLength(5);
    expect(root.querySelector('[role="alert"]')).toBeNull();
    expect(worker.terminate).toHaveBeenCalledOnce();
    const app = (root as HTMLElement & { __vue_app__?: { unmount: () => void } }).__vue_app__;
    if (!app) {
      throw new Error('Missing hydrated Docs search app');
    }
    app.unmount();
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it('activates search only after the language-neutral home mounts its chosen locale', async () => {
    await using fixture = await createSiteFixture();
    await build({ ...docsBuildConfig({ root: fixture.docs }), configFile: false, logLevel: 'silent' });
    const dist = path.join(fixture.docs, 'dist');
    const dom = new JSDOM(await readFile(path.join(dist, 'index.html'), 'utf8'), { url: 'https://naidan.invalid/docs/', runScripts: 'outside-only' });
    using _browser = { [Symbol.dispose]: () => dom.window.close() };
    const document = dom.window.document;
    let readyState: DocumentReadyState = 'loading';
    Object.defineProperty(document, 'readyState', { configurable: true, get: () => readyState });
    Object.defineProperty(dom.window.navigator, 'languages', { configurable: true, value: ['ja'] });
    for (const template of document.querySelectorAll<HTMLTemplateElement>('template[data-docs-locale]')) {
      const searchRoot = template.content.querySelector('[data-docs-island="search"]');
      if (!searchRoot) {
        throw new Error('Missing neutral-home search template');
      }
      const payload = parseSearchPayload({ serialized: searchRoot.getAttribute('data-docs-props') ?? '' });
      expect(payload.locale).toBe(template.getAttribute('data-docs-locale'));
      expect(searchRoot.querySelectorAll('[data-testid="docs-search-results"] a')).toHaveLength(PURPOSE_PAGES.length);
    }
    const bootstrap = document.querySelector<HTMLScriptElement>('script:not([type])[src]')?.getAttribute('src');
    const search = document.querySelector<HTMLScriptElement>('script[type="module"][src]')?.getAttribute('src');
    if (!bootstrap || !search) {
      throw new Error('Missing neutral-home scripts');
    }
    new Script(await readFile(path.join(dist, bootstrap.slice('/docs/'.length)), 'utf8')).runInContext(dom.getInternalVMContext());
    for (const name of ['window', 'document', 'navigator', 'Node', 'Element', 'HTMLElement', 'HTMLInputElement', 'HTMLDialogElement', 'SVGElement', 'Event', 'MutationObserver'] as const) {
      vi.stubGlobal(name, name === 'window' ? dom.window : name === 'document' ? document : dom.window[name]);
    }
    Object.defineProperty(dom.window.HTMLDialogElement.prototype, 'showModal', {
      configurable: true,
      value(this: HTMLDialogElement) {
        this.setAttribute('open', '');
      },
    });
    const workerConstructor = vi.fn(() => {
      throw new Error('Empty search must not start a Worker');
    });
    vi.stubGlobal('Worker', workerConstructor);
    using _cleanup = { [Symbol.dispose]: () => vi.unstubAllGlobals() };
    readyState = 'interactive';
    await import(pathToFileURL(path.join(dist, search.slice('/docs/'.length))).href);
    expect(document.querySelector('[data-docs-island="search"]')).toBeNull();
    expect(document.querySelector('[data-docs-language-fallback]')).not.toBeNull();
    document.dispatchEvent(new dom.window.Event('DOMContentLoaded'));
    await vi.waitFor(() => expect(document.querySelector('[data-docs-island="search"]')?.getAttribute('data-docs-hydrated')).toBe('ready'));
    expect(document.documentElement.lang).toBe('ja');
    expect(document.querySelectorAll('[data-docs-island="search"]')).toHaveLength(1);
    expect(document.querySelector('[data-testid="docs-search-trigger"]')?.getAttribute('aria-label')).toBe('ドキュメントを検索');
    expect(document.querySelectorAll('template[data-docs-locale]')).toHaveLength(0);
    const root = document.querySelector<HTMLElement>('[data-docs-island="search"]');
    if (!root) {
      throw new Error('Missing chosen-locale search island');
    }
    const payload = parseSearchPayload({ serialized: root.getAttribute('data-docs-props') ?? '' });
    expect(payload.locale).toBe('ja');
    root.querySelector<HTMLButtonElement>('[data-testid="docs-search-trigger"]')?.click();
    await vi.waitFor(() => expect(root.querySelectorAll('[data-testid="docs-search-results"] a')).toHaveLength(PURPOSE_PAGES.length));
    expect(root.querySelector('[data-testid="docs-search-results"] a')?.getAttribute('href')).toBe('/docs/ja/standalone/');
    expect(workerConstructor).not.toHaveBeenCalled();
  });
});
