// @vitest-environment jsdom
import { createSSRApp, defineComponent, h, nextTick, onMounted } from 'vue';
import { renderToString } from 'vue/server-renderer';
import { describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import DocsIsland from '../components/DocsIsland.vue';
import { branchingIsland } from '../islands/branching/definition';
import { parseBranchingPayload } from '../islands/branching/contracts';
import { prepareBranchingMessages, readBranchingMessages } from '../islands/branching/messages';
import { hydrateDocsIsland } from '../islands/core';
import { defineDocsIsland } from '../islands/core';
import { defineDocsIslandSpec } from '../islands/spec';
import type { DocsLocale } from '../navigation/routes';

async function appendDemo({ locale }: { locale: DocsLocale }): Promise<HTMLElement> {
  await prepareBranchingMessages({ locale });
  const html = await renderToString(createSSRApp({ render: () => h(DocsIsland, { entry: branchingIsland({ locale }) }) }));
  document.body.append(document.importNode(JSDOM.fragment(html), true));
  const root = document.body.querySelector<HTMLElement>('[data-docs-island="branching"]:last-of-type');
  if (!root) {
    throw new Error('Missing branching island root');
  }
  return root;
}

describe('compiled branching island hydration', () => {
  it.each(['en', 'ja'] as const)('retains static %s messages and enables source-derived branching controls', async locale => {
    const root = await appendDemo({ locale });
    const { messages } = readBranchingMessages({ locale });
    expect(parseBranchingPayload({ serialized: root.getAttribute('data-docs-props') ?? '' })).toEqual({ locale });
    expect(Object.keys(JSON.parse(root.getAttribute('data-docs-props') ?? '') as object)).toEqual(['locale']);
    const resend = root.querySelector<HTMLElement>('[data-testid="branch-method-resend"]');
    if (!resend) {
      throw new Error('Missing resend section');
    }
    const getButton = ({ id }: { id: string }) => {
      const element = resend.querySelector(`[data-testid="${id}"]`);
      if (!(element instanceof HTMLButtonElement)) {
        throw new Error(`Missing button: ${id}`);
      }
      return element;
    };
    expect(getButton({ id: 'branch-resend' }).disabled).toBe(true);
    expect(resend.querySelector('[data-testid="branch-user-versions"]')?.textContent).toBe('2 / 2');
    expect(resend.querySelector('[data-testid="branch-reply"]')?.textContent).toBe(messages.replies[1]);
    const warning = vi.spyOn(console, 'warn');
    const apps = await hydrateDocsIsland({ factory: branchingIsland, document });
    using _cleanup = {
      [Symbol.dispose]() {
        apps.forEach(app => app.unmount());
        document.body.replaceChildren();
        warning.mockRestore();
      },
    };
    await nextTick();
    expect(getButton({ id: 'branch-resend' }).disabled).toBe(false);
    expect(resend.querySelector('[data-testid="branch-reply"]')?.textContent).toBe(messages.replies[0]);
    getButton({ id: 'branch-resend' }).click();
    await nextTick();
    expect(resend.querySelector('[data-testid="branch-reply"]')?.textContent).toBe(messages.replies[1]);
    expect(resend.querySelector('[data-testid="branch-user-versions"]')?.textContent).toBe('2 / 2');
    getButton({ id: 'branch-original' }).click();
    await nextTick();
    expect(resend.querySelector('[data-testid="branch-reply"]')?.textContent).toBe(messages.replies[0]);
    getButton({ id: 'branch-alternative' }).click();
    await nextTick();
    expect(resend.querySelector('[data-testid="branch-reply"]')?.textContent).toBe(messages.replies[1]);
    getButton({ id: 'branch-reset' }).click();
    await nextTick();
    expect(resend.querySelector('[data-testid="branch-reply"]')?.textContent).toBe(messages.replies[0]);
    expect(await hydrateDocsIsland({ factory: branchingIsland, document })).toEqual([]);
    expect(warning).not.toHaveBeenCalled();
  });

  it('keeps locale instances independent and preserves rich caption labels', async () => {
    const first = await appendDemo({ locale: 'en' });
    const second = await appendDemo({ locale: 'ja' });
    const english = readBranchingMessages({ locale: 'en' }).messages;
    const japanese = readBranchingMessages({ locale: 'ja' }).messages;
    const firstResend = first.querySelector<HTMLElement>('[data-testid="branch-method-resend"]');
    const secondResend = second.querySelector<HTMLElement>('[data-testid="branch-method-resend"]');
    if (!firstResend || !secondResend) {
      throw new Error('Missing resend section');
    }
    expect(first.querySelector('.branch-note .ui-label')?.textContent).toBe('Replay this method');
    expect(second.querySelector('.branch-note .ui-label')?.textContent).toBe('この方法を再生');
    expect(firstResend.querySelector('[data-testid="branch-reply"]')?.textContent).toBe(english.replies[1]);
    expect(secondResend.querySelector('[data-testid="branch-reply"]')?.textContent).toBe(japanese.replies[1]);
    const apps = await hydrateDocsIsland({ factory: branchingIsland, document });
    using _cleanup = {
      [Symbol.dispose]() {
        apps.forEach(app => app.unmount());
        document.body.replaceChildren();
      },
    };
    await nextTick();
    (firstResend.querySelector('[data-testid="branch-resend"]') as HTMLButtonElement).click();
    await nextTick();
    expect(firstResend.querySelector('[data-testid="branch-reply"]')?.textContent).toBe(english.replies[1]);
    expect(secondResend.querySelector('[data-testid="branch-reply"]')?.textContent).toBe(japanese.replies[0]);
  });

  it('leaves invalid payloads readable and still starts a following valid island', async () => {
    const invalid = await appendDemo({ locale: 'en' });
    invalid.setAttribute('data-docs-props', JSON.stringify({ locale: 'fr' }));
    const valid = await appendDemo({ locale: 'ja' });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const apps = await hydrateDocsIsland({ factory: branchingIsland, document });
    using _cleanup = {
      [Symbol.dispose]() {
        apps.forEach(app => app.unmount());
        document.body.replaceChildren();
        error.mockRestore();
      },
    };
    await nextTick();
    expect(apps).toHaveLength(1);
    expect(invalid.querySelector('[data-testid="branch-method-edit"] [data-testid="branch-reply"]')?.textContent).toBe(readBranchingMessages({ locale: 'en' }).messages.editedReply);
    expect((invalid.querySelector('button') as HTMLButtonElement).disabled).toBe(true);
    expect(invalid.dataset.docsHydrated).toBeUndefined();
    expect(valid.dataset.docsHydrated).toBe('ready');
    expect(error).toHaveBeenCalledTimes(1);
  });

  it('restores static HTML after a mount error and starts the next root', async () => {
    const spec = defineDocsIslandSpec<{ text: string }>({
      id: 'failure-probe',
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
        onMounted(() => {
          if (props.text === 'broken') {
            throw new Error('Mount failed');
          }
        });
        return () => h('span', { 'data-testid': 'failure-probe-copy' }, props.text);
      },
    });
    const factory = defineDocsIsland({ spec, component, prepare: () => Promise.resolve() });
    for (const text of ['broken', 'working']) {
      const html = await renderToString(createSSRApp({ render: () => h(DocsIsland, { entry: factory({ text }) }) }));
      document.body.append(document.importNode(JSDOM.fragment(html), true));
    }
    const [broken, working] = document.body.querySelectorAll<HTMLElement>('[data-docs-island="failure-probe"]');
    if (!broken || !working) {
      throw new Error('Missing failure probe roots');
    }
    const staticHtml = broken.innerHTML;
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const apps = await hydrateDocsIsland({ factory, document });
    using _cleanup = {
      [Symbol.dispose]() {
        apps.forEach(app => app.unmount());
        document.body.replaceChildren();
        error.mockRestore();
      },
    };
    expect(apps).toHaveLength(1);
    expect(broken.innerHTML).toBe(staticHtml);
    expect(broken.dataset.docsHydrated).toBeUndefined();
    expect(working.dataset.docsHydrated).toBe('ready');
    expect(working.querySelector('[data-testid="failure-probe-copy"]')?.textContent).toBe('working');
  });
});
