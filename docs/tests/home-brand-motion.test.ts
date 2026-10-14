import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import { homeBrandTransform } from '../client/home-brand-geometry';
import { startHomeBrandMotion } from '../client/home-brand-motion';
import { docsHref } from '../site/routes';
import { createSiteFixture, parsePage, startSiteDev } from './site.test-support';

const guidePages = [
  'models/llama-cpp-browser',
  'images/create',
  'audio/speech',
  'chat/branching',
  'work/browser-shell',
  'chat/groups',
  'work/wikipedia',
  'run/offline',
] as const;

const guideTitles = {
  en: [
    'Chat with a GGUF model in your browser',
    'Create images on your device',
    'Make speech from text on your device',
    'Branch and edit a conversation',
    'Let AI work with selected files',
    'Keep chats organized by purpose',
    'Look up Wikipedia during a chat',
    'Use Naidan offline as a PWA',
  ],
  ja: [
    'GGUFモデルでチャットする',
    '端末内で画像を作る',
    '端末内で音声を作る',
    '会話を分岐・編集する',
    'AIにファイル操作を任せる',
    '用途別にチャットをまとめる',
    'チャットでWikipediaを調べる',
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
    },
    {
      locale: 'ja',
      headline: '安全性を徹底追求した、簡単に使えるAI環境。',
      appDescription: '端末のどこにアクセスでき、得た情報をどう送れるかを比べます。',
      standaloneDescription: 'ZIPの取得から起動、モデル選びまでの手順を確認できます。',
      localOnlyLink: 'ローカルのみ版の通信先と制限を詳しく見る',
    },
  ] as const)('ships a complete static $locale hero and a home-only client', async ({ locale, headline, appDescription, standaloneDescription, localOnlyLink }) => {
    await using fixture = await createSiteFixture();
    await using dev = await startSiteDev({ root: fixture.root });
    const homeResponse = await dev.request({ url: docsHref({ locale, page: 'index' }) });
    using home = parsePage({ html: await homeResponse.text() });
    expect(home.document.querySelector('[data-docs-hero-brand]')?.textContent?.trim()).toBe('Naidan');
    expect(home.document.querySelector('[data-docs-hero-brand] img')?.getAttribute('src')).toBeTruthy();
    expect(home.document.querySelector('h1')?.textContent).toBe(headline);
    expect(home.document.querySelectorAll('[data-docs-brand-link]')).toHaveLength(1);
    expect(home.document.querySelector('[data-docs-brand-link]')?.getAttribute('href')).toBe(docsHref({ locale, page: 'index' }));
    expect(home.document.querySelector('[data-docs-brand-slot] .brand-docs')?.closest('a')).toBeNull();
    const guideCards = Array.from(home.document.querySelectorAll<HTMLAnchorElement>('[data-testid="docs-home-guide-card"]'));
    expect(guideCards.map(card => card.getAttribute('href'))).toEqual(guidePages.map(page => docsHref({ locale, page })));
    expect(guideCards.map(card => card.querySelector('h3')?.textContent)).toEqual(guideTitles[locale]);
    const appGuide = home.document.querySelector('[data-testid="docs-app-permissions-guide"]');
    expect(appGuide?.getAttribute('href')).toBe(docsHref({ locale, page: 'work/app-permissions' }));
    expect(appGuide?.textContent).toContain(appDescription);
    const standaloneGuide = home.document.querySelector('[data-testid="docs-standalone-guide"]');
    expect(standaloneGuide?.getAttribute('href')).toBe(docsHref({ locale, page: 'run/standalone' }));
    expect(standaloneGuide?.textContent).toContain(standaloneDescription);
    const localOnlyGuide = home.document.querySelector('[data-testid="docs-local-only-guide"]');
    expect(localOnlyGuide?.getAttribute('href')).toBe(docsHref({ locale, page: 'work/local-only' }));
    expect(localOnlyGuide?.textContent).toBe(localOnlyLink);
    expect(home.document.querySelector('script[src="/docs/client/home-brand.ts"]')).not.toBeNull();

    using guide = parsePage({ html: await (await dev.request({ url: docsHref({ locale, page: 'work/boundary' }) })).text() });
    expect(guide.document.querySelector('[data-docs-hero-brand]')).toBeNull();
    expect(guide.document.querySelector('script[src="/docs/client/home-brand.ts"]')).toBeNull();
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
    }
  });

  it('reaches the header without changing layout coordinates and reverses with scroll', () => {
    const geometry = { sourceLeft: 100, sourceTop: 180, sourceWidth: 360, targetLeft: 24, targetTop: 20, targetWidth: 120 };
    expect(homeBrandTransform({ geometry, scrollY: 0 })).toEqual({ x: 76, y: 160, scale: 3, progress: 0 });
    expect(homeBrandTransform({ geometry, scrollY: 80 })).toEqual({ x: 38, y: 80, scale: 2, progress: .5 });
    expect(homeBrandTransform({ geometry, scrollY: 160 })).toEqual({ x: 0, y: 0, scale: 1, progress: 1 });
    expect(homeBrandTransform({ geometry, scrollY: 1000 })).toEqual({ x: 0, y: 0, scale: 1, progress: 1 });
    expect(homeBrandTransform({ geometry, scrollY: 40 }).progress).toBe(.25);
  });

  it('shows the static hero and header when paused, reduced, or narrow', () => {
    const dom = new JSDOM('<!doctype html><html><body><div data-docs-brand-slot><a data-docs-brand-link></a></div><input id="docs-pause-motion" type="checkbox"><div data-docs-hero-brand>Naidan</div></body></html>');
    using _page = { [Symbol.dispose]: () => dom.window.close() };
    const { document } = dom.window;
    const slot = document.querySelector<HTMLElement>('[data-docs-brand-slot]');
    const link = document.querySelector<HTMLAnchorElement>('[data-docs-brand-link]');
    const hero = document.querySelector<HTMLElement>('[data-docs-hero-brand]');
    const pause = document.querySelector<HTMLInputElement>('#docs-pause-motion');
    if (!slot || !link || !hero || !pause) throw new Error('Missing brand fixture');
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
    Object.defineProperty(link, 'offsetWidth', { value: 120 });
    Object.defineProperty(link, 'offsetHeight', { value: 38 });
    let sourceLeft = 100;
    let sourceTop = 180;
    Object.defineProperty(hero, 'getBoundingClientRect', { value: () => ({ left: sourceLeft, top: sourceTop, width: 360, height: 114 }) });
    Object.defineProperty(slot, 'getBoundingClientRect', { value: () => ({ left: 24, top: 20, width: 120, height: 38 }) });
    const flush = () => {
      while (queued.length) queued.shift()?.(0);
    };

    startHomeBrandMotion({ document, window: dom.window as unknown as Window });
    expect(document.documentElement.hasAttribute('data-docs-home-brand-motion')).toBe(true);
    expect(link.style.transform).toContain('scale(3)');

    Object.defineProperty(dom.window, 'scrollY', { value: 80, writable: true });
    sourceTop = 100;
    dom.window.dispatchEvent(new dom.window.Event('scroll'));
    flush();
    expect(link.style.transform).toBe('translate3d(38px, 80px, 0) scale(2)');

    sourceLeft = 90;
    dom.window.dispatchEvent(new dom.window.Event('resize'));
    flush();
    expect(link.style.transform).toBe('translate3d(33px, 80px, 0) scale(2)');

    pause.checked = true;
    pause.dispatchEvent(new dom.window.Event('change'));
    flush();
    expect(document.documentElement.hasAttribute('data-docs-home-brand-motion')).toBe(false);
    expect(link.style.transform).toBe('');

    pause.checked = false;
    media.get('(prefers-reduced-motion: reduce)')!.matches = true;
    pause.dispatchEvent(new dom.window.Event('change'));
    flush();
    expect(link.style.transform).toBe('');

    media.get('(prefers-reduced-motion: reduce)')!.matches = false;
    media.get('(max-width: 480px)')!.matches = true;
    pause.dispatchEvent(new dom.window.Event('change'));
    flush();
    expect(link.style.transform).toBe('');
  });
});
