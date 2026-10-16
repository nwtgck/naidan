import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import { homeBrandFrame } from '../client/home-brand-geometry';
import { startHomeBrandMotion } from '../client/home-brand-motion';
import { docsHref } from '../navigation/routes';
import { createSiteFixture, parsePage, startSiteDev } from './site.test-support';

const guidePages = [
  'endpoint-type-llama-cpp-browser',
  'image-generation',
  'audio-generation',
  'chat-branching',
  'tool-browser-shell',
  'chat-groups',
  'tool-wikipedia',
  'pwa',
] as const;

const guideTitles = {
  en: [
    'Chat with a GGUF model in your browser',
    'Create images on your device',
    'Make speech from text on your device',
    'Branch and edit a conversation',
    'Let AI work with selected files',
    'Keep chats organized by purpose',
    'Use Wikipedia to inform local AI answers',
    'Use Naidan offline as a PWA',
  ],
  ja: [
    'GGUFモデルでチャットする',
    '端末内で画像を作る',
    '端末内で音声を作る',
    '会話を分岐・編集する',
    'AIにファイル操作を任せる',
    '用途別にチャットをまとめる',
    'Wikipediaの情報でローカルAIの回答を補う',
    'NaidanをPWAとしてオフラインで使う',
  ],
} as const;

describe('Docs home brand', () => {
  it.each([
    {
      locale: 'en',
      headline: 'An easy-to-use AI environment, built around privacy.',
      appDescription: 'See where each can reach on your device and what it can send afterward.',
      standaloneDescription: 'Follow the steps from downloading the ZIP to opening the app and choosing a model.',
      localOnlyLink: 'Learn about the Local-only edition’s connection limits',
      launchText: 'Use Naidan',
      sourceText: 'Source code on GitHub',
    },
    {
      locale: 'ja',
      headline: '安全性を徹底追求した、簡単に使えるAI環境。',
      appDescription: '端末のどこにアクセスでき、得た情報をどう送れるかを比べます。',
      standaloneDescription: 'ZIPの取得から起動、モデル選びまでの手順を確認できます。',
      localOnlyLink: 'ローカルのみ版の通信先と制限を詳しく見る',
      launchText: 'Naidanを使う',
      sourceText: 'GitHubのソースコード',
    },
  ] as const)('ships a complete static $locale hero and a home-only client', async ({ locale, headline, appDescription, standaloneDescription, localOnlyLink, launchText, sourceText }) => {
    await using fixture = await createSiteFixture();
    await using dev = await startSiteDev({ root: fixture.root });
    const homeResponse = await dev.request({ url: docsHref({ locale, page: 'index' }) });
    using home = parsePage({ html: await homeResponse.text() });
    expect(home.document.querySelector('[data-docs-hero-brand]')?.textContent?.trim()).toBe('Naidan');
    expect(home.document.querySelector('[data-docs-hero-brand] img')?.getAttribute('src')).toBeTruthy();
    expect(home.document.querySelector('h1')?.textContent).toBe(headline);
    const launch = home.document.querySelector<HTMLAnchorElement>('[data-testid="docs-hero-launch"]');
    expect(launch?.textContent).toContain(launchText);
    expect(launch?.getAttribute('href')).toBe('https://naidan.nwtgck.org/#/');
    expect(launch?.getAttribute('data-docs-app-entry-path')).toBe('/#/');
    expect(launch?.hasAttribute('target')).toBe(false);
    expect(launch?.querySelector('[data-docs-external-icon]')).toBeNull();
    const source = home.document.querySelector<HTMLAnchorElement>('[data-testid="docs-hero-source"]');
    expect(source?.textContent).toContain(sourceText);
    expect(source?.getAttribute('href')).toBe('https://github.com/nwtgck/naidan');
    expect(source?.getAttribute('target')).toBe('_blank');
    expect(source?.getAttribute('rel')).toBe('noopener noreferrer');
    expect(source?.getAttribute('referrerpolicy')).toBe('no-referrer');
    expect(source?.querySelector('svg.lucide-github')).not.toBeNull();
    expect(source?.querySelector('[data-docs-external-icon]')).not.toBeNull();
    expect(home.document.querySelectorAll('[data-docs-brand-link]')).toHaveLength(1);
    expect(home.document.querySelector('[data-docs-brand-link]')?.getAttribute('href')).toBe(docsHref({ locale, page: 'index' }));
    expect(home.document.querySelector('[data-docs-brand-link]')?.getAttribute('aria-label')).toBeTruthy();
    expect(home.document.querySelector('[data-docs-hero-brand]')?.getAttribute('aria-hidden')).toBe('true');
    expect(home.document.querySelector('[data-docs-brand-spacer]')?.getAttribute('aria-hidden')).toBe('true');
    expect(home.document.querySelector('[data-docs-brand-slot] .brand-docs')?.closest('a')).toBeNull();
    const homeMenu = home.document.querySelector('[data-testid="docs-header"] [data-testid="docs-guide-menu"]');
    expect(homeMenu?.querySelector('summary')?.textContent?.trim()).toBeTruthy();
    expect(homeMenu?.nextElementSibling?.querySelector('[data-testid="docs-search-trigger"]')).not.toBeNull();
    const guideCards = Array.from(home.document.querySelectorAll<HTMLAnchorElement>('[data-testid="docs-home-guide-card"]'));
    expect(guideCards.map(card => card.getAttribute('href'))).toEqual(guidePages.map(page => docsHref({ locale, page })));
    expect(guideCards.map(card => card.querySelector('h3')?.textContent)).toEqual(guideTitles[locale]);
    const appGuide = home.document.querySelector('[data-testid="docs-app-permissions-guide"]');
    expect(appGuide?.getAttribute('href')).toBe(docsHref({ locale, page: 'web-and-native-app-permissions' }));
    expect(appGuide?.textContent).toContain(appDescription);
    const standaloneGuide = home.document.querySelector('[data-testid="docs-standalone-guide"]');
    expect(standaloneGuide?.getAttribute('href')).toBe(docsHref({ locale, page: 'standalone' }));
    expect(standaloneGuide?.textContent).toContain(standaloneDescription);
    const localOnlyGuide = home.document.querySelector('[data-testid="docs-local-only-guide"]');
    expect(localOnlyGuide?.getAttribute('href')).toBe(docsHref({ locale, page: 'csp-editions' }));
    expect(localOnlyGuide?.textContent).toBe(localOnlyLink);
    expect(home.document.querySelector('script[src="/docs/client/home-brand.ts"]')).not.toBeNull();
    expect(home.document.querySelector('script[src="/docs/client/app-entry.ts"]')).not.toBeNull();

    using guide = parsePage({ html: await (await dev.request({ url: docsHref({ locale, page: 'browser-boundaries' }) })).text() });
    expect(guide.document.querySelector('[data-docs-hero-brand]')).toBeNull();
    expect(guide.document.querySelector('script[src="/docs/client/home-brand.ts"]')).toBeNull();
    expect(guide.document.querySelector('[data-testid="docs-header"] [data-testid="docs-guide-menu"]')).not.toBeNull();
    expect(guide.document.querySelector('[data-testid="docs-header"] [data-testid="docs-search-trigger"]')).not.toBeNull();
  });

  it('loads the brand client at the language-neutral entrance after its localized templates', async () => {
    await using fixture = await createSiteFixture();
    await using dev = await startSiteDev({ root: fixture.root });
    using root = parsePage({ html: await (await dev.request({ url: '/docs/' })).text() });
    expect(root.document.querySelector('[data-docs-language-fallback] a')).not.toBeNull();
    expect(root.document.querySelectorAll('script[src="/docs/client/home-brand.ts"]')).toHaveLength(1);
    for (const locale of ['en', 'ja'] as const) {
      const template = root.document.querySelector<HTMLTemplateElement>(`template[data-docs-locale="${locale}"]`);
      expect(template?.content.querySelector('[data-docs-hero-brand]')?.textContent?.trim()).toBe('Naidan');
      expect(template?.content.querySelector('h1')).not.toBeNull();
      expect(template?.content.querySelector('[data-testid="docs-header"] [data-testid="docs-guide-menu"]')).not.toBeNull();
      expect(template?.content.querySelector('[data-testid="docs-header"] [data-testid="docs-search-trigger"]')).not.toBeNull();
    }
  });

  it('interpolates rendered sizes and position between the hero and header in both scroll directions', () => {
    const geometry = {
      sourceLeft: 100,
      sourceTop: 180,
      sourceMarkWidth: 130,
      sourceMarkHeight: 130,
      sourceFontSize: 75,
      sourceGap: 14,
      targetLeft: 24,
      targetTop: 20,
      targetWidth: 120,
      targetHeight: 38,
      targetMarkWidth: 38,
      targetMarkHeight: 38,
      targetFontSize: 22,
      targetGap: 4,
    };
    const start = { x: 76, y: 160, markWidth: 130, markHeight: 130, fontSize: 75, gap: 14, progress: 0 };
    const middle = { x: 38, y: 80, markWidth: 84, markHeight: 84, fontSize: 48.5, gap: 9, progress: .5 };
    const end = { x: 0, y: 0, markWidth: 38, markHeight: 38, fontSize: 22, gap: 4, progress: 1 };
    expect(homeBrandFrame({ geometry, scrollY: 0 })).toEqual(start);
    expect(homeBrandFrame({ geometry, scrollY: 80 })).toEqual(middle);
    expect(homeBrandFrame({ geometry, scrollY: 160 })).toEqual(end);
    expect(homeBrandFrame({ geometry, scrollY: 1000 })).toEqual(end);
    expect(homeBrandFrame({ geometry, scrollY: 80 })).toEqual(middle);
    expect(homeBrandFrame({ geometry, scrollY: 0 })).toEqual(start);
  });

  it('uses actual SVG and font sizes for the Safari hero instead of scaling header pixels', () => {
    const headerOuterLeft = 24;
    let headerPadding = 31;
    const siteCss = readFileSync(new URL('../styles/site.css', import.meta.url), 'utf8');
    const dom = new JSDOM(`\
<!doctype html><html><head><style>${siteCss}</style><style>
.topbar-inner { padding-left: ${headerPadding}px; }
[data-docs-brand-link] { display: inline-flex; column-gap: 4px; }
[data-docs-brand-link] .brand-wordmark { font-size: 22px; }
[data-docs-hero-brand] { display: inline-flex; column-gap: 14px; }
[data-docs-hero-brand] .brand-wordmark { font-size: 75px; }
</style></head><body>
<header class="topbar" data-testid="docs-header"><div class="topbar-inner">
<div data-docs-brand-slot><a data-docs-brand-link href="/docs/en/" aria-label="Home"><img><span class="brand-wordmark">Naidan</span></a><span data-docs-brand-spacer aria-hidden="true"></span></div>
<details class="docs-guide-menu"><summary class="docs-guide-trigger">Guides</summary><div class="docs-guide-panel"><a href="/docs/en/in-browser-models/">Models</a></div></details>
<div class="docs-search"><button class="docs-search-trigger" type="button">Search</button></div>
</div></header>
<input id="docs-pause-motion" type="checkbox">
<div data-docs-hero-brand aria-hidden="true"><img><span class="brand-wordmark">Naidan</span></div>
</body></html>`);
    using _page = { [Symbol.dispose]: () => dom.window.close() };
    const { document } = dom.window;
    const slot = document.querySelector<HTMLElement>('[data-docs-brand-slot]');
    const header = document.querySelector<HTMLElement>('[data-testid="docs-header"]');
    const headerInner = document.querySelector<HTMLElement>('.topbar-inner');
    const guideTrigger = document.querySelector<HTMLElement>('.docs-guide-trigger');
    const link = document.querySelector<HTMLAnchorElement>('[data-docs-brand-link]');
    const spacer = document.querySelector<HTMLElement>('[data-docs-brand-spacer]');
    const hero = document.querySelector<HTMLElement>('[data-docs-hero-brand]');
    const heroWordmark = hero?.querySelector<HTMLElement>('.brand-wordmark');
    const mark = link?.querySelector<HTMLImageElement>('img');
    const wordmark = link?.querySelector<HTMLElement>('.brand-wordmark');
    const heroMark = hero?.querySelector<HTMLImageElement>('img');
    const pause = document.querySelector<HTMLInputElement>('#docs-pause-motion');
    if (!slot || !header || !headerInner || !guideTrigger || !link || !spacer || !hero || !heroWordmark || !mark || !wordmark || !heroMark || !pause) throw new Error('Missing brand fixture');
    const queued: FrameRequestCallback[] = [];
    const media = new Map<string, { matches: boolean; addEventListener: () => void }>([
      ['(prefers-reduced-motion: reduce)', { matches: false, addEventListener: () => undefined }],
      ['(max-width: 480px)', { matches: false, addEventListener: () => undefined }],
    ]);
    Object.defineProperty(dom.window, 'matchMedia', { value: (query: string) => media.get(query) });
    Object.defineProperty(dom.window, 'requestAnimationFrame', {
      value: (callback: FrameRequestCallback) => {
        queued.push(callback); return queued.length;
      },
    });
    Object.defineProperty(dom.window, 'scrollY', { value: 0, writable: true });
    let sourceLeft = 100;
    let sourceTop = 180;
    let targetWidth = 120;
    let targetMarkWidth = 38;
    let sourceMarkWidth = 130;
    Object.defineProperty(hero, 'getBoundingClientRect', { value: () => ({ left: sourceLeft, top: sourceTop, width: 360, height: 130 }) });
    Object.defineProperty(heroMark, 'getBoundingClientRect', { value: () => ({ width: sourceMarkWidth, height: sourceMarkWidth }) });
    Object.defineProperty(link, 'getBoundingClientRect', {
      value: () => ({
        left: 24,
        top: 20,
        width: wordmark.style.fontSize ? 360 : targetWidth,
        height: wordmark.style.fontSize ? 130 : 38,
      }),
    });
    Object.defineProperty(mark, 'getBoundingClientRect', {
      value: () => ({
        width: mark.style.width ? 130 : targetMarkWidth,
        height: mark.style.height ? 130 : targetMarkWidth,
      }),
    });
    Object.defineProperty(headerInner, 'getBoundingClientRect', { value: () => ({ left: headerOuterLeft }) });
    Object.defineProperty(guideTrigger, 'getBoundingClientRect', { value: () => ({ left: 48 + targetWidth }) });
    const flush = () => {
      while (queued.length) queued.shift()?.(0);
    };
    const leadingShift = () => Number.parseFloat(header.style.getPropertyValue('--docs-home-leading-shift'));
    const expectRestored = () => {
      expect(document.documentElement.hasAttribute('data-docs-home-brand-motion')).toBe(false);
      expect(document.documentElement.hasAttribute('data-docs-home-brand-resting')).toBe(false);
      expect(dom.window.getComputedStyle(hero).visibility).toBe('visible');
      expect(dom.window.getComputedStyle(mark).opacity).not.toBe('0');
      expect(dom.window.getComputedStyle(wordmark).opacity).not.toBe('0');
      expect(document.documentElement.dataset.docsHomeBrandStartup).toBe('ready');
      expect(link.style.left).toBe('');
      expect(link.style.top).toBe('');
      expect(link.style.gap).toBe('');
      expect(mark.style.width).toBe('');
      expect(mark.style.height).toBe('');
      expect(wordmark.style.fontSize).toBe('');
      expect(spacer.style.width).toBe('');
      expect(spacer.style.height).toBe('');
      expect(slot.style.getPropertyValue('--docs-brand-progress')).toBe('');
      expect(header.style.getPropertyValue('--docs-home-leading-shift')).toBe('');
      expect(link.getAttribute('href')).toBe('/docs/en/');
    };

    document.documentElement.dataset.docsHomeBrandStartup = 'pending';
    startHomeBrandMotion({ document, window: dom.window as unknown as Window });
    expect(document.documentElement.hasAttribute('data-docs-home-brand-motion')).toBe(true);
    expect(document.documentElement.hasAttribute('data-docs-home-brand-resting')).toBe(true);
    expect(dom.window.getComputedStyle(hero).visibility).toBe('visible');
    expect(dom.window.getComputedStyle(link).opacity).not.toBe('0');
    expect(dom.window.getComputedStyle(mark).opacity).toBe('0');
    expect(dom.window.getComputedStyle(wordmark).opacity).toBe('0');
    expect(document.documentElement.dataset.docsHomeBrandStartup).toBe('ready');
    expect(link.style.left).toBe('76px');
    expect(link.style.top).toBe('160px');
    expect(link.style.transform).toBe('');
    expect(mark.style.width).toBe('130px');
    expect(mark.style.height).toBe('130px');
    expect(wordmark.style.fontSize).toBe('75px');
    expect(link.style.gap).toBe('14px');
    expect(spacer.style.width).toBe('120px');
    expect(spacer.style.height).toBe('38px');
    expect(dom.window.getComputedStyle(headerInner).paddingLeft).toBe(`${headerPadding}px`);
    expect(48 + targetWidth + leadingShift()).toBe(headerOuterLeft + headerPadding);
    expect(link.getAttribute('href')).toBe('/docs/en/');
    expect(link.getAttribute('aria-label')).toBe('Home');
    expect(hero.getAttribute('aria-hidden')).toBe('true');
    expect(link.textContent?.trim()).toBe('Naidan');
    expect(document.querySelectorAll('[data-docs-brand-link]')).toHaveLength(1);

    link.focus();
    expect(document.activeElement).toBe(link);
    expect(dom.window.getComputedStyle(link).opacity).not.toBe('0');
    expect(dom.window.getComputedStyle(hero).visibility).toBe('visible');
    link.blur();
    expect(dom.window.getComputedStyle(hero).visibility).toBe('visible');
    expect(dom.window.getComputedStyle(mark).opacity).toBe('0');

    sourceMarkWidth = 107.5;
    heroWordmark.style.fontSize = '62.25px';
    hero.style.columnGap = '11.25px';
    sourceLeft = 101.5;
    dom.window.dispatchEvent(new dom.window.Event('resize'));
    flush();
    expect(link.style.left).toBe('77.5px');
    expect(mark.style.width).toBe('107.5px');
    expect(mark.style.height).toBe('107.5px');
    expect(wordmark.style.fontSize).toBe('62.25px');
    expect(link.style.gap).toBe('11.25px');
    expect(document.documentElement.hasAttribute('data-docs-home-brand-resting')).toBe(true);
    expect(dom.window.getComputedStyle(hero).visibility).toBe('visible');
    expect(dom.window.getComputedStyle(mark).opacity).toBe('0');
    expect(dom.window.getComputedStyle(wordmark).opacity).toBe('0');
    sourceMarkWidth = 130;
    heroWordmark.style.fontSize = '75px';
    hero.style.columnGap = '14px';
    sourceLeft = 100;
    dom.window.dispatchEvent(new dom.window.Event('resize'));
    flush();

    Object.defineProperty(dom.window, 'scrollY', { value: 0.01, writable: true });
    sourceTop = 179.99;
    dom.window.dispatchEvent(new dom.window.Event('scroll'));
    flush();
    expect(document.documentElement.hasAttribute('data-docs-home-brand-resting')).toBe(false);
    expect(dom.window.getComputedStyle(hero).visibility).toBe('hidden');
    expect(dom.window.getComputedStyle(mark).opacity).not.toBe('0');
    expect(Number.parseFloat(link.style.left)).toBeCloseTo(76, 1);
    expect(Number.parseFloat(link.style.top)).toBeCloseTo(160, 1);
    expect(Number.parseFloat(mark.style.width)).toBeCloseTo(130, 1);
    Object.defineProperty(dom.window, 'scrollY', { value: 0, writable: true });
    sourceTop = 180;
    dom.window.dispatchEvent(new dom.window.Event('scroll'));
    flush();
    expect(document.documentElement.hasAttribute('data-docs-home-brand-resting')).toBe(true);
    expect(dom.window.getComputedStyle(hero).visibility).toBe('visible');
    expect(dom.window.getComputedStyle(mark).opacity).toBe('0');

    Object.defineProperty(dom.window, 'scrollY', { value: 80, writable: true });
    sourceTop = 100;
    dom.window.dispatchEvent(new dom.window.Event('scroll'));
    dom.window.dispatchEvent(new dom.window.Event('scroll'));
    expect(queued).toHaveLength(1);
    flush();
    expect(link.style.left).toBe('38px');
    expect(document.documentElement.hasAttribute('data-docs-home-brand-resting')).toBe(false);
    expect(dom.window.getComputedStyle(hero).visibility).toBe('hidden');
    expect(dom.window.getComputedStyle(mark).opacity).not.toBe('0');
    expect(dom.window.getComputedStyle(wordmark).opacity).not.toBe('0');
    expect(link.style.top).toBe('80px');
    expect(link.style.transform).toBe('');
    expect(mark.style.width).toBe('84px');
    expect(mark.style.height).toBe('84px');
    expect(wordmark.style.fontSize).toBe('48.5px');
    expect(link.style.gap).toBe('9px');
    expect(spacer.style.width).toBe('120px');
    expect(spacer.style.height).toBe('38px');
    expect(leadingShift()).toBe((headerOuterLeft + headerPadding - (48 + targetWidth)) / 2);

    sourceLeft = 90;
    targetWidth = 130;
    targetMarkWidth = 40;
    headerPadding = 19;
    headerInner.style.paddingLeft = `${headerPadding}px`;
    dom.window.dispatchEvent(new dom.window.Event('resize'));
    flush();
    expect(link.style.left).toBe('33px');
    expect(mark.style.width).toBe('85px');
    expect(spacer.style.width).toBe('130px');
    expect(spacer.style.height).toBe('38px');
    expect(dom.window.getComputedStyle(headerInner).paddingLeft).toBe(`${headerPadding}px`);
    expect(leadingShift()).toBe((headerOuterLeft + headerPadding - (48 + targetWidth)) / 2);

    Object.defineProperty(dom.window, 'scrollY', { value: 160, writable: true });
    sourceTop = 20;
    dom.window.dispatchEvent(new dom.window.Event('scroll'));
    flush();
    expect(link.style.left).toBe('0px');
    expect(link.style.top).toBe('0px');
    expect(mark.style.width).toBe('40px');
    expect(mark.style.height).toBe('40px');
    expect(wordmark.style.fontSize).toBe('22px');
    expect(spacer.style.width).toBe('130px');
    expect(header.style.getPropertyValue('--docs-home-leading-shift')).toBe('0px');

    Object.defineProperty(dom.window, 'scrollY', { value: 0, writable: true });
    sourceTop = 180;
    dom.window.dispatchEvent(new dom.window.Event('scroll'));
    flush();
    expect(mark.style.width).toBe('130px');
    expect(document.documentElement.hasAttribute('data-docs-home-brand-resting')).toBe(true);
    expect(dom.window.getComputedStyle(hero).visibility).toBe('visible');
    expect(dom.window.getComputedStyle(mark).opacity).toBe('0');
    expect(dom.window.getComputedStyle(wordmark).opacity).toBe('0');
    expect(spacer.style.width).toBe('130px');
    expect(48 + targetWidth + leadingShift()).toBe(headerOuterLeft + headerPadding);

    Object.defineProperty(dom.window, 'scrollY', { value: 80, writable: true });
    sourceTop = 100;
    dom.window.dispatchEvent(new dom.window.Event('scroll'));
    flush();
    expect(link.style.left).toBe('33px');
    expect(mark.style.width).toBe('85px');
    expect(spacer.style.width).toBe('130px');

    pause.checked = true;
    pause.dispatchEvent(new dom.window.Event('change'));
    flush();
    expectRestored();

    pause.checked = false;
    pause.dispatchEvent(new dom.window.Event('change'));
    flush();
    expect(mark.style.width).toBe('85px');

    media.get('(prefers-reduced-motion: reduce)')!.matches = true;
    pause.dispatchEvent(new dom.window.Event('change'));
    flush();
    expectRestored();

    media.get('(prefers-reduced-motion: reduce)')!.matches = false;
    pause.dispatchEvent(new dom.window.Event('change'));
    flush();
    expect(mark.style.width).toBe('85px');

    media.get('(max-width: 480px)')!.matches = true;
    pause.dispatchEvent(new dom.window.Event('change'));
    flush();
    expectRestored();

    media.get('(max-width: 480px)')!.matches = false;
    pause.dispatchEvent(new dom.window.Event('change'));
    flush();
    expect(mark.style.width).toBe('85px');

    document.documentElement.dataset.docsHomeBrandStartup = 'pending';
    pause.checked = true;
    pause.dispatchEvent(new dom.window.Event('change'));
    flush();
    expectRestored();
  });

  it('hides only the visual startup brand while keeping its space, native link, and keyboard focus', () => {
    const css = readFileSync(new URL('../styles/site.css', import.meta.url), 'utf8');
    const dom = new JSDOM(`<!doctype html><html data-docs-home-brand-startup="pending"><head><style>${css}</style></head><body>
<header class="topbar"><div class="topbar-inner"><div class="brand-group"><a data-docs-brand-link href="/docs/en/">Naidan</a></div><details class="docs-guide-menu"><summary>Guides</summary></details><div class="docs-search"><button type="button">Search</button></div><div class="nav-controls"><a href="/">Use Naidan</a></div></div></header>
<div data-docs-hero-brand aria-hidden="true">Naidan</div><input id="docs-pause-motion" type="checkbox">
</body></html>`);
    using _page = { [Symbol.dispose]: () => dom.window.close() };
    const { document } = dom.window;
    const group = document.querySelector<HTMLElement>('.brand-group');
    const link = document.querySelector<HTMLAnchorElement>('[data-docs-brand-link]');
    const hero = document.querySelector<HTMLElement>('[data-docs-hero-brand]');
    const inner = document.querySelector<HTMLElement>('.topbar-inner');
    if (!group || !link || !hero || !inner) throw new Error('Missing startup brand fixture');
    const visualSequence = () => Array.from(inner.children)
      .map((element, index) => ({ element, index, order: Number(dom.window.getComputedStyle(element).order || 0) }))
      .sort((a, b) => a.order - b.order || a.index - b.index)
      .map(({ element }) => element.className);
    expect(visualSequence()).toEqual(['docs-guide-menu', 'docs-search', 'brand-group', 'nav-controls']);
    expect(dom.window.getComputedStyle(group).opacity).toBe('0');
    expect(dom.window.getComputedStyle(group).display).toBe('inline-flex');
    expect(dom.window.getComputedStyle(hero).visibility).toBe('visible');
    expect(link.getAttribute('href')).toBe('/docs/en/');
    link.focus();
    expect(document.activeElement).toBe(link);
    expect(group.matches(':focus-within')).toBe(true);
    document.documentElement.dataset.docsHomeBrandStartup = 'ready';
    expect(visualSequence()).toEqual(['brand-group', 'docs-guide-menu', 'docs-search', 'nav-controls']);
  });

  it.each([
    { state: 'a missing classic bootstrap', startup: '' },
    { state: 'a timed-out startup', startup: ' data-docs-home-brand-startup="aborted"' },
  ])('does not start brand motion after $state', ({ startup }) => {
    const dom = new JSDOM(`<!doctype html><html${startup}><body>
<header class="topbar"><div class="topbar-inner"><div data-docs-brand-slot><a data-docs-brand-link href="/docs/en/"><img><span class="brand-wordmark">Naidan</span></a><span data-docs-brand-spacer></span></div></div></header>
<input id="docs-pause-motion" type="checkbox"><div data-docs-hero-brand><img><span class="brand-wordmark">Naidan</span></div>
</body></html>`);
    using _page = { [Symbol.dispose]: () => dom.window.close() };
    Object.defineProperty(dom.window, 'matchMedia', {
      value: () => {
        throw new Error('Late motion must not inspect media');
      },
    });
    const { document } = dom.window;
    expect(() => startHomeBrandMotion({ document, window: dom.window as unknown as Window })).not.toThrow();
    expect(document.documentElement.hasAttribute('data-docs-home-brand-motion')).toBe(false);
    expect(document.querySelector('[data-docs-brand-link]')?.getAttribute('href')).toBe('/docs/en/');
  });

  it('keeps a ready static home responsive to a later motion preference change', () => {
    const dom = new JSDOM(`<!doctype html><html data-docs-home-brand-startup="ready"><head><style>
[data-docs-hero-brand] { column-gap:14px; } [data-docs-hero-brand] .brand-wordmark { font-size:75px; }
[data-docs-brand-link] { column-gap:4px; } [data-docs-brand-link] .brand-wordmark { font-size:22px; }
</style></head><body>
<header class="topbar"><div class="topbar-inner"><div data-docs-brand-slot><a data-docs-brand-link href="/docs/en/"><img><span class="brand-wordmark">Naidan</span></a><span data-docs-brand-spacer></span></div></div></header>
<input id="docs-pause-motion" type="checkbox" checked><div data-docs-hero-brand><img><span class="brand-wordmark">Naidan</span></div>
</body></html>`);
    using _page = { [Symbol.dispose]: () => dom.window.close() };
    const { document } = dom.window;
    const hero = document.querySelector<HTMLElement>('[data-docs-hero-brand]');
    const link = document.querySelector<HTMLElement>('[data-docs-brand-link]');
    const heroMark = hero?.querySelector('img');
    const mark = link?.querySelector('img');
    const pause = document.querySelector<HTMLInputElement>('#docs-pause-motion');
    if (!hero || !link || !heroMark || !mark || !pause) throw new Error('Missing ready brand fixture');
    Object.defineProperty(dom.window, 'matchMedia', { value: () => ({ matches: false, addEventListener: () => undefined }) });
    const frames: FrameRequestCallback[] = [];
    Object.defineProperty(dom.window, 'requestAnimationFrame', {
      value: (callback: FrameRequestCallback) => {
        frames.push(callback); return frames.length;
      },
    });
    Object.defineProperty(dom.window, 'scrollY', { value: 0 });
    Object.defineProperty(hero, 'getBoundingClientRect', { value: () => ({ left: 100, top: 180, width: 240, height: 130 }) });
    Object.defineProperty(link, 'getBoundingClientRect', { value: () => ({ left: 24, top: 20, width: 120, height: 38 }) });
    Object.defineProperty(heroMark, 'getBoundingClientRect', { value: () => ({ width: 130, height: 130 }) });
    Object.defineProperty(mark, 'getBoundingClientRect', { value: () => ({ width: 38, height: 38 }) });
    startHomeBrandMotion({ document, window: dom.window as unknown as Window });
    expect(document.documentElement.dataset.docsHomeBrandStartup).toBe('ready');
    expect(document.documentElement.hasAttribute('data-docs-home-brand-motion')).toBe(false);
    pause.checked = false;
    pause.dispatchEvent(new dom.window.Event('change'));
    expect(frames).toHaveLength(1);
    frames.shift()?.(0);
    expect(document.documentElement.hasAttribute('data-docs-home-brand-motion')).toBe(true);
    expect(document.documentElement.dataset.docsHomeBrandStartup).toBe('ready');
    expect(link.getAttribute('href')).toBe('/docs/en/');
  });

  it('keeps the paired leading controls aligned and raises an open native guide above the moving brand', () => {
    const css = readFileSync(new URL('../styles/site.css', import.meta.url), 'utf8');
    const dom = new JSDOM(`\
<!doctype html><html><head><style>${css}</style></head><body>
<header class="topbar"><div class="topbar-inner">
<div class="brand-group"><a data-docs-brand-link href="/docs/en/">Naidan</a></div>
<details class="docs-guide-menu" name="docs-header-menu"><summary class="docs-guide-trigger">Guides</summary><div class="docs-guide-panel"><a href="/docs/en/in-browser-models/">Models</a></div></details>
<button class="docs-search-trigger" type="button">Search</button>
<div class="nav-controls"><details class="locale-menu" name="docs-header-menu"><summary class="locale-trigger">EN</summary><nav class="locale-panel"><a href="/docs/en/">English</a><a href="/docs/ja/">日本語</a></nav></details></div>
</div></header></body></html>`);
    using _page = { [Symbol.dispose]: () => dom.window.close() };
    const { document } = dom.window;
    const header = document.querySelector<HTMLElement>('.topbar');
    const brand = document.querySelector<HTMLAnchorElement>('[data-docs-brand-link]');
    const menu = document.querySelector<HTMLDetailsElement>('.docs-guide-menu');
    const localeMenu = document.querySelector<HTMLDetailsElement>('.locale-menu');
    const controls = document.querySelector<HTMLElement>('.nav-controls');
    const inner = menu?.parentElement;
    const guideTrigger = document.querySelector<HTMLElement>('.docs-guide-trigger');
    const searchTrigger = document.querySelector<HTMLElement>('.docs-search-trigger');
    if (!header || !brand || !menu || !localeMenu || !controls || !inner || !guideTrigger || !searchTrigger) throw new Error('Missing header fixture');
    document.documentElement.setAttribute('data-docs-home-brand-motion', '');
    header.style.setProperty('--docs-home-leading-shift', '-144px');
    const guideStyle = dom.window.getComputedStyle(guideTrigger);
    const searchStyle = dom.window.getComputedStyle(searchTrigger);
    expect(guideStyle.position).toBe('relative');
    expect(searchStyle.position).toBe('relative');
    expect(guideStyle.left).toBe(searchStyle.left);
    expect(guideStyle.left).toContain('--docs-home-leading-shift');
    expect(dom.window.getComputedStyle(inner).display).toBe('flex');
    const closedZ = dom.window.getComputedStyle(menu).zIndex;
    menu.open = true;
    const openZ = dom.window.getComputedStyle(menu).zIndex;
    expect(Number(openZ)).toBeGreaterThan(Number(dom.window.getComputedStyle(brand).zIndex));
    expect(openZ).not.toBe(closedZ);
    expect(menu.querySelector('summary')).toBe(guideTrigger);
    expect(menu.querySelector('a')?.getAttribute('href')).toBe('/docs/en/in-browser-models/');
    menu.open = false;
    localeMenu.open = true;
    expect(Number(dom.window.getComputedStyle(controls).zIndex)).toBeGreaterThan(Number(dom.window.getComputedStyle(brand).zIndex));
    expect(localeMenu.querySelectorAll('a[href]')).toHaveLength(2);
    expect(brand.getAttribute('href')).toBe('/docs/en/');
  });
});
