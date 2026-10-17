// @vitest-environment jsdom
import { createSSRApp, defineComponent, h } from 'vue';
import { renderToString } from 'vue/server-renderer';
import { describe, expect, it, vi } from 'vitest';
import DocsIsland from '../components/DocsIsland.vue';
import { defineDocsIsland, hydrateDocsIsland } from '../islands/core';
import { defineDocsIslandSpec } from '../islands/spec';
import { createDocsLocaleMessagesLoader } from '../messages/loader';

type TextPayload = { text: string };

function textIsland({ prepare, onSetup }: {
  prepare: ({ payload }: { payload: TextPayload }) => Promise<void>;
  onSetup: () => void;
}) {
  const spec = defineDocsIslandSpec<TextPayload>({
    id: 'text-probe',
    start: 'interactive',
    parse: ({ serialized }) => {
      const value: unknown = JSON.parse(serialized);
      if (typeof value !== 'object' || value === null || !('text' in value) || typeof value.text !== 'string') {
        throw new Error('Invalid text');
      }
      return { text: value.text };
    },
  });
  const component = defineComponent({
    props: { text: { type: String, required: true } },
    setup(props) {
      onSetup();
      return () => h('span', { 'data-testid': 'text-probe' }, props.text);
    },
  });
  return defineDocsIsland({ spec, component, prepare });
}

function appendStaticRoot({ text }: { text: string }): HTMLElement {
  const root = document.createElement('div');
  root.dataset.docsIsland = 'text-probe';
  root.setAttribute('data-docs-props', JSON.stringify({ text }));
  root.innerHTML = `<span data-testid="text-probe">${text}</span>`;
  document.body.append(root);
  return root;
}

describe('Docs island async preparation', () => {
  it('loads only the selected locale, shares pending work, and retries after failure', async () => {
    const en = vi.fn(async () => ({ label: 'English' }));
    let attempts = 0;
    const ja = vi.fn(async () => {
      attempts++;
      if (attempts === 1) {
        throw new Error('Temporary load failure');
      }
      return { label: '日本語' };
    });
    const loader = createDocsLocaleMessagesLoader<{ label: string }>({ loaders: { en, ja } });
    expect(() => loader.read({ locale: 'ja' })).toThrow('read before loading');
    const first = loader.load({ locale: 'ja' });
    expect(loader.load({ locale: 'ja' })).toBe(first);
    await expect(first).rejects.toThrow('Temporary load failure');
    expect(() => loader.read({ locale: 'ja' })).toThrow('read before loading');
    expect(await loader.load({ locale: 'ja' })).toEqual({ label: '日本語' });
    expect(loader.read({ locale: 'ja' }).label).toBe('日本語');
    expect(ja).toHaveBeenCalledTimes(2);
    expect(en).not.toHaveBeenCalled();
  });

  it('awaits preparation before SSR child setup and fails closed on rejection', async () => {
    let release: (() => void) | undefined;
    const waiting = new Promise<void>(resolve => {
      release = resolve;
    });
    const setup = vi.fn();
    const factory = textIsland({ prepare: async () => waiting, onSetup: setup });
    const rendering = renderToString(createSSRApp({ render: () => h(DocsIsland, { entry: factory({ text: 'ready' }) }) }));
    await Promise.resolve();
    expect(setup).not.toHaveBeenCalled();
    release?.();
    expect(await rendering).toContain('data-testid="text-probe">ready</span>');
    expect(setup).toHaveBeenCalledOnce();

    const failedSetup = vi.fn();
    const failed = textIsland({
      prepare: async () => {
        await Promise.reject(undefined);
      },
      onSetup: failedSetup,
    });
    await expect(renderToString(createSSRApp({ render: () => h(DocsIsland, { entry: failed({ text: 'unavailable' }) }) })))
      .rejects.toThrow('Docs island preparation failed');
    expect(failedSetup).not.toHaveBeenCalled();
  });

  it('keeps static content during a pending load and skips a changed root', async () => {
    let release: (() => void) | undefined;
    const waiting = new Promise<void>(resolve => {
      release = resolve;
    });
    const factory = textIsland({ prepare: async () => waiting, onSetup: () => {} });
    const root = appendStaticRoot({ text: 'original' });
    using _cleanup = {
      [Symbol.dispose]() {
        document.body.replaceChildren();
      },
    };
    const staticHtml = root.innerHTML;
    const first = hydrateDocsIsland({ factory, document });
    expect(await hydrateDocsIsland({ factory, document })).toEqual([]);
    expect(root.innerHTML).toBe(staticHtml);
    root.setAttribute('data-docs-props', JSON.stringify({ text: 'changed' }));
    release?.();
    expect(await first).toEqual([]);
    expect(root.innerHTML).toBe(staticHtml);
    expect(root.dataset.docsHydrated).toBeUndefined();
  });

  it('preserves a failed root and starts another root', async () => {
    const factory = textIsland({
      prepare: async ({ payload }) => {
        if (payload.text === 'unavailable') {
          throw new Error('No messages');
        }
      },
      onSetup: () => {},
    });
    const failed = appendStaticRoot({ text: 'unavailable' });
    const valid = appendStaticRoot({ text: 'working' });
    const staticHtml = failed.innerHTML;
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    using _cleanup = {
      [Symbol.dispose]() {
        document.body.replaceChildren();
        error.mockRestore();
      },
    };
    const apps = await hydrateDocsIsland({ factory, document });
    using _apps = {
      [Symbol.dispose]() {
        apps.forEach(app => app.unmount());
      },
    };
    expect(apps).toHaveLength(1);
    expect(failed.innerHTML).toBe(staticHtml);
    expect(failed.dataset.docsHydrated).toBeUndefined();
    expect(valid.dataset.docsHydrated).toBe('ready');
    expect(error).toHaveBeenCalledOnce();
  });
});
