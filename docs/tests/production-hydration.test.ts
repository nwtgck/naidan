import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'vite';
import { describe, expect, it, vi } from 'vitest';
import { docsBuildConfig } from '../build/production';
import { parseBranchingPayload } from '../islands/branching/contracts';
import { prepareBranchingMessages, readBranchingMessages } from '../islands/branching/messages';
import { createSiteFixture, parsePage } from './site.test-support';

// JSDOM does not fetch stylesheets. The Node-imported bundle gives Vite's CSS
// preload a file:///docs/assets URL instead of the browser's /docs/assets URL.
// Verify the emitted public asset before signaling load; existing HTML links stay untouched.
function serveEmittedStylesheetEvents({ document, dist }: { document: Document; dist: string }) {
  const dom = document.defaultView;
  if (!dom) {
    throw new Error('Missing page window');
  }
  const loaded: string[] = [];
  const observer = new dom.MutationObserver(records => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (!(node instanceof dom.HTMLLinkElement) || node.rel !== 'stylesheet') {
          continue;
        }
        const asset = new URL(node.href).pathname;
        if (!/^\/docs\/assets\/[A-Za-z0-9_-]+\.css$/u.test(asset)) {
          node.dispatchEvent(new dom.Event('error'));
          continue;
        }
        void access(path.join(dist, asset.slice('/docs/'.length))).then(() => {
          loaded.push(asset);
          node.dispatchEvent(new dom.Event('load'));
        }, () => node.dispatchEvent(new dom.Event('error')));
      }
    }
  });
  observer.observe(document.head, { childList: true });
  return { loaded, [Symbol.dispose]: () => observer.disconnect() };
}

// Import the emitted browser bundle into an actual DOM. Vue captures document
// when its runtime module loads, so globals must exist before that import.
describe('emitted production island', () => {
  it('keeps disabled static HTML when the locale payload is malformed', async () => {
    await using fixture = await createSiteFixture();
    await build({ ...docsBuildConfig({ root: fixture.docs }), configFile: false, logLevel: 'silent' });
    const dist = path.join(fixture.docs, 'dist');
    using page = parsePage({ html: await readFile(path.join(dist, 'en/chat-branching/index.html'), 'utf8') });
    const source = page.document.querySelector<HTMLScriptElement>('script[src*="island-branching"]')?.getAttribute('src');
    const root = page.document.querySelector<HTMLElement>('[data-docs-island="branching"]');
    if (!source || !root) {
      throw new Error('Missing production branching island');
    }
    expect(parseBranchingPayload({ serialized: root.getAttribute('data-docs-props') ?? '' })).toEqual({ locale: 'en' });
    root.setAttribute('data-docs-props', JSON.stringify({ locale: 'fr' }));
    const staticHtml = root.innerHTML;
    const dom = page.document.defaultView;
    if (!dom) {
      throw new Error('Missing page window');
    }
    for (const name of ['window', 'document', 'navigator', 'Node', 'Element', 'HTMLElement', 'HTMLButtonElement', 'SVGElement', 'Event', 'MutationObserver'] as const) {
      vi.stubGlobal(name, name === 'window' ? dom : name === 'document' ? page.document : dom[name]);
    }
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    using _cleanup = {
      [Symbol.dispose]() {
        vi.unstubAllGlobals();
        error.mockRestore();
      },
    };
    const pathname = new URL(source, 'https://naidan.invalid').pathname;
    await import(pathToFileURL(path.join(dist, pathname.slice('/docs/'.length))).href);
    page.document.dispatchEvent(new dom.Event('DOMContentLoaded'));
    await vi.waitFor(() => expect(error).toHaveBeenCalledTimes(1));
    expect(root.dataset.docsHydrated).toBeUndefined();
    expect(root.innerHTML).toBe(staticHtml);
    expect((root.querySelector('button') as HTMLButtonElement).disabled).toBe(true);
  });

  it.each(['en', 'ja'] as const)('hydrates %s HTML with the actual generated JavaScript', async locale => {
    await using fixture = await createSiteFixture();
    await build({ ...docsBuildConfig({ root: fixture.docs }), configFile: false, logLevel: 'silent' });
    const dist = path.join(fixture.docs, 'dist');
    using page = parsePage({ html: await readFile(path.join(dist, locale, 'chat-branching/index.html'), 'utf8') });
    const source = page.document.querySelector<HTMLScriptElement>('script[src*="island-branching"]')?.getAttribute('src');
    const staticRoot = page.document.querySelector<HTMLElement>('[data-docs-island="branching"]');
    if (!source || !staticRoot) {
      throw new Error('Missing production branching island');
    }
    expect(parseBranchingPayload({ serialized: staticRoot.getAttribute('data-docs-props') ?? '' })).toEqual({ locale });
    await prepareBranchingMessages({ locale });
    const { messages } = readBranchingMessages({ locale });
    const dom = page.document.defaultView;
    if (!dom) {
      throw new Error('Missing page window');
    }
    for (const name of ['window', 'document', 'navigator', 'Node', 'Element', 'HTMLElement', 'HTMLButtonElement', 'SVGElement', 'Event', 'MutationObserver'] as const) {
      vi.stubGlobal(name, name === 'window' ? dom : name === 'document' ? page.document : dom[name]);
    }
    const root = staticRoot;
    using stylesheetEvents = serveEmittedStylesheetEvents({ document: page.document, dist });
    const warn = vi.spyOn(console, 'warn');
    const error = vi.spyOn(console, 'error');
    using _cleanup = {
      [Symbol.dispose]() {
        vi.unstubAllGlobals();
        warn.mockRestore();
        error.mockRestore();
      },
    };
    const section = ({ id }: { id: string }): HTMLElement => {
      const element = root.querySelector<HTMLElement>(`[data-testid="branch-method-${id}"]`);
      if (!element) {
        throw new Error(`Missing method section: ${id}`);
      }
      return element;
    };
    const resend = section({ id: 'resend' });
    const button = ({ id }: { id: string }): HTMLButtonElement => {
      const element = resend.querySelector(`[data-testid="${id}"]`);
      if (!(element instanceof HTMLButtonElement)) {
        throw new Error(`Missing button: ${id}`);
      }
      return element;
    };
    const reply = () => resend.querySelector('[data-testid="branch-reply"]');
    expect(button({ id: 'branch-resend' }).disabled).toBe(true);
    expect(reply()?.textContent).toBe(messages.replies[1]);
    expect(section({ id: 'fork' }).querySelector('[data-testid="branch-reply"]')).toBeNull();
    const pathname = new URL(source, 'https://naidan.invalid').pathname;
    // Each fixture has a unique path, so its emitted entry and chunks are fresh.
    await import(pathToFileURL(path.join(dist, pathname.slice('/docs/'.length))).href);
    page.document.dispatchEvent(new dom.Event('DOMContentLoaded'));
    await vi.waitFor(() => {
      expect(error.mock.calls).toEqual([]);
      expect(root.dataset.docsHydrated).toBe('ready');
    });
    expect(stylesheetEvents.loaded).toContainEqual(expect.stringMatching(/^\/docs\/assets\/UiLabel-[^/]+\.css$/u));
    expect(button({ id: 'branch-resend' }).disabled).toBe(false);
    button({ id: 'branch-resend' }).click();
    await vi.waitFor(() => expect(reply()?.textContent).toBe(messages.replies[1]));
    expect(resend.querySelector('[data-testid="branch-user-versions"]')?.textContent).toBe('2 / 2');
    button({ id: 'branch-original' }).click();
    await vi.waitFor(() => expect(reply()?.textContent).toBe(messages.replies[0]));
    button({ id: 'branch-alternative' }).click();
    await vi.waitFor(() => expect(reply()?.textContent).toBe(messages.replies[1]));
    button({ id: 'branch-reset' }).click();
    await vi.waitFor(() => expect(reply()?.textContent).toBe(messages.replies[0]));
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });
});
