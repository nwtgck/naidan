// @vitest-environment jsdom
import { createSSRApp, h, nextTick } from 'vue';
import { renderToString } from 'vue/server-renderer';
import { describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import BranchingDemo from '../islands/branching/BranchingDemo.vue';
import { hydrateBranchingDemos } from '../islands/branching/client';
import { strings as english } from '../strings/chat/branching/en';
import { strings as japanese } from '../strings/chat/branching/ja';
import type { BranchingCopy } from '../site/messages';

async function appendDemo({ copy }: { copy: BranchingCopy }): Promise<HTMLElement> {
  const root = document.createElement('div');
  root.dataset.docsIsland = 'branching';
  root.setAttribute('data-docs-props', JSON.stringify({ copy }));
  const html = await renderToString(createSSRApp({ render: () => h(BranchingDemo, { copy }) }));
  root.append(document.importNode(JSDOM.fragment(html), true));
  document.body.append(root);
  return root;
}

describe('compiled branching island hydration', () => {
  it.each([english.demo, japanese.demo])('retains the static reply, enables real branching and supports reset in both locales', async copy => {
    const root = await appendDemo({ copy });
    const getButton = ({ id }: { id: string }) => {
      const element = root.querySelector(`[data-testid="${id}"]`);
      if (!(element instanceof HTMLButtonElement)) throw new Error(`Missing button: ${id}`);
      return element;
    };
    expect(getButton({ id: 'branch-original' }).disabled).toBe(true);
    expect(root.querySelector('[data-testid="branch-reply"]')?.textContent).toBe(copy.replies[0]);
    const warning = vi.spyOn(console, 'warn');
    const apps = hydrateBranchingDemos({ document });
    using _cleanup = {
      [Symbol.dispose]() {
        apps.forEach(app => app.unmount()); document.body.replaceChildren(); warning.mockRestore();
      },
    };
    await nextTick();
    expect(getButton({ id: 'branch-alternative' }).disabled).toBe(false);
    getButton({ id: 'branch-alternative' }).click();
    await nextTick();
    expect(root.querySelector('[data-testid="branch-reply"]')?.textContent).toBe(copy.replies[1]);
    expect(getButton({ id: 'branch-alternative' }).getAttribute('aria-pressed')).toBe('true');
    getButton({ id: 'branch-reset' }).click();
    await nextTick();
    expect(root.querySelector('[data-testid="branch-reply"]')?.textContent).toBe(copy.replies[0]);
    expect(hydrateBranchingDemos({ document })).toEqual([]);
    expect(warning).not.toHaveBeenCalled();
  });

  it('keeps instances independent and treats HTML-like copy as text', async () => {
    const copy = { ...english.demo, replies: ['</p><script>bad()</script>', 'A & B <img src=x onerror=bad()>'] satisfies [string, string] };
    const first = await appendDemo({ copy });
    const second = await appendDemo({ copy: japanese.demo });
    const apps = hydrateBranchingDemos({ document });
    using _cleanup = {
      [Symbol.dispose]() {
        apps.forEach(app => app.unmount()); document.body.replaceChildren();
      },
    };
    await nextTick();
    (first.querySelector('[data-testid="branch-alternative"]') as HTMLButtonElement).click();
    await nextTick();
    expect(first.querySelector('[data-testid="branch-reply"]')?.textContent).toBe(copy.replies[1]);
    expect(first.querySelector('img, script')).toBeNull();
    expect(second.querySelector('[data-testid="branch-reply"]')?.textContent).toBe(japanese.demo.replies[0]);
  });

  it('leaves invalid payloads readable and still starts a following valid island', async () => {
    const invalid = await appendDemo({ copy: english.demo });
    invalid.setAttribute('data-docs-props', '{"copy":{"label":"missing fields"}}');
    const valid = await appendDemo({ copy: japanese.demo });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const apps = hydrateBranchingDemos({ document });
    using _cleanup = {
      [Symbol.dispose]() {
        apps.forEach(app => app.unmount()); document.body.replaceChildren(); error.mockRestore();
      },
    };
    await nextTick();
    expect(apps).toHaveLength(1);
    expect(invalid.querySelector('[data-testid="branch-reply"]')?.textContent).toBe(english.demo.replies[0]);
    expect((invalid.querySelector('button') as HTMLButtonElement).disabled).toBe(true);
    expect(valid.dataset.docsHydrated).toBe('ready');
    expect(error).toHaveBeenCalledTimes(1);
  });
});
