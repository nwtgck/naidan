// @vitest-environment jsdom
import { createSSRApp, h, nextTick } from 'vue';
import { renderToString } from 'vue/server-renderer';
import { describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import BranchingDemo from '../islands/branching/BranchingDemo.vue';
import { hydrateBranchingDemos } from '../islands/branching/client';
import { strings as english } from '../strings/chat/branching/en';
import { strings as japanese } from '../strings/chat/branching/ja';
import { strings as englishCommon } from '../strings/common/en';
import { strings as japaneseCommon } from '../strings/common/ja';
import type { BranchingCopy, ReplicaChromeCopy } from '../site/messages';

async function appendDemo({ copy, chrome }: { copy: BranchingCopy; chrome: ReplicaChromeCopy }): Promise<HTMLElement> {
  const root = document.createElement('div');
  root.dataset.docsIsland = 'branching';
  root.setAttribute('data-docs-props', JSON.stringify({ copy, chrome }));
  const html = await renderToString(createSSRApp({ render: () => h(BranchingDemo, { copy, chrome }) }));
  root.append(document.importNode(JSDOM.fragment(html), true));
  document.body.append(root);
  return root;
}

describe('compiled branching island hydration', () => {
  it.each([{ copy: english.demo, chrome: englishCommon.chrome }, { copy: japanese.demo, chrome: japaneseCommon.chrome }])('retains static messages and enables source-derived branching controls in both locales', async ({ copy, chrome }) => {
    const root = await appendDemo({ copy, chrome });
    const resend = root.querySelector<HTMLElement>('[data-testid="branch-method-resend"]');
    if (!resend) throw new Error('Missing resend section');
    const getButton = ({ id }: { id: string }) => {
      const element = resend.querySelector(`[data-testid="${id}"]`);
      if (!(element instanceof HTMLButtonElement)) throw new Error(`Missing button: ${id}`);
      return element;
    };
    expect(getButton({ id: 'branch-resend' }).disabled).toBe(true);
    expect(resend.querySelector('[data-testid="branch-user-versions"]')?.textContent).toBe('2 / 2');
    expect(resend.querySelector('[data-testid="branch-reply"]')?.textContent).toBe(copy.replies[1]);
    const warning = vi.spyOn(console, 'warn');
    const apps = hydrateBranchingDemos({ document });
    using _cleanup = {
      [Symbol.dispose]() {
        apps.forEach(app => app.unmount()); document.body.replaceChildren(); warning.mockRestore();
      },
    };
    await nextTick();
    expect(getButton({ id: 'branch-resend' }).disabled).toBe(false);
    expect(resend.querySelector('[data-testid="branch-reply"]')?.textContent).toBe(copy.replies[0]);
    getButton({ id: 'branch-resend' }).click();
    await nextTick();
    expect(resend.querySelector('[data-testid="branch-reply"]')?.textContent).toBe(copy.replies[1]);
    expect(resend.querySelector('[data-testid="branch-user-versions"]')?.textContent).toBe('2 / 2');
    getButton({ id: 'branch-original' }).click();
    await nextTick();
    expect(resend.querySelector('[data-testid="branch-reply"]')?.textContent).toBe(copy.replies[0]);
    getButton({ id: 'branch-alternative' }).click();
    await nextTick();
    expect(resend.querySelector('[data-testid="branch-reply"]')?.textContent).toBe(copy.replies[1]);
    getButton({ id: 'branch-reset' }).click();
    await nextTick();
    expect(resend.querySelector('[data-testid="branch-reply"]')?.textContent).toBe(copy.replies[0]);
    expect(hydrateBranchingDemos({ document })).toEqual([]);
    expect(warning).not.toHaveBeenCalled();
  });

  it('keeps instances independent and treats HTML-like copy as text', async () => {
    const copy = { ...english.demo, replies: ['</p><script>bad()</script>', 'A & B <img src=x onerror=bad()>'] satisfies [string, string] };
    const first = await appendDemo({ copy, chrome: englishCommon.chrome });
    const second = await appendDemo({ copy: japanese.demo, chrome: japaneseCommon.chrome });
    const firstResend = first.querySelector<HTMLElement>('[data-testid="branch-method-resend"]');
    const secondResend = second.querySelector<HTMLElement>('[data-testid="branch-method-resend"]');
    if (!firstResend || !secondResend) throw new Error('Missing resend section');
    const apps = hydrateBranchingDemos({ document });
    using _cleanup = {
      [Symbol.dispose]() {
        apps.forEach(app => app.unmount()); document.body.replaceChildren();
      },
    };
    await nextTick();
    (firstResend.querySelector('[data-testid="branch-resend"]') as HTMLButtonElement).click();
    await nextTick();
    expect(firstResend.querySelector('[data-testid="branch-reply"]')?.textContent).toBe(copy.replies[1]);
    expect(firstResend.querySelector('[data-testid="branch-reply"]')?.querySelector('img, script')).toBeNull();
    expect(first.querySelector('[onerror], img[src="x"]')).toBeNull();
    expect(secondResend.querySelector('[data-testid="branch-reply"]')?.textContent).toBe(japanese.demo.replies[0]);
  });

  it('leaves invalid payloads readable and still starts a following valid island', async () => {
    const invalid = await appendDemo({ copy: english.demo, chrome: englishCommon.chrome });
    invalid.setAttribute('data-docs-props', JSON.stringify({
      copy: { ...english.demo, stages: [['missing nested steps']] },
      chrome: englishCommon.chrome,
    }));
    const valid = await appendDemo({ copy: japanese.demo, chrome: japaneseCommon.chrome });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const apps = hydrateBranchingDemos({ document });
    using _cleanup = {
      [Symbol.dispose]() {
        apps.forEach(app => app.unmount()); document.body.replaceChildren(); error.mockRestore();
      },
    };
    await nextTick();
    expect(apps).toHaveLength(1);
    expect(invalid.querySelector('[data-testid="branch-method-edit"] [data-testid="branch-reply"]')?.textContent).toBe(english.demo.editedReply);
    expect((invalid.querySelector('button') as HTMLButtonElement).disabled).toBe(true);
    expect(invalid.dataset.docsHydrated).toBeUndefined();
    expect(valid.dataset.docsHydrated).toBe('ready');
    expect(error).toHaveBeenCalledTimes(1);
  });
});
