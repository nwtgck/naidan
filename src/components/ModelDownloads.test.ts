import { afterEach, expect, it, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { nextTick } from 'vue';
import ModelDownloads from './ModelDownloads.vue';
import { getDownloadManager, TEST_ONLY } from '@/logic/download-manager';
import { ensureAllStringsForTest } from '@/strings/utils.test-support';

function panel() {
  return document.querySelector<HTMLElement>('[data-testid="model-downloads-panel"]')!;
}

function mountPanel() {
  const wrapper = mount(ModelDownloads, { attachTo: document.body });
  return {
    wrapper,
    [Symbol.dispose]() {
      wrapper.unmount();
    },
  };
}

const files = [
  { name: 'first.gguf', url: 'https://huggingface.co/owner/repo/resolve/aaaa/first.gguf', destination: 'models/huggingface.co/owner/repo/resolve/main/first.gguf', size: 100, completed: 100, state: 'complete' as const },
  { name: 'second.gguf', url: 'https://huggingface.co/owner/repo/resolve/aaaa/second.gguf', destination: 'models/huggingface.co/owner/repo/resolve/main/second.gguf', size: 300, completed: 60, state: 'transferring' as const },
];

afterEach(() => {
  TEST_ONLY.reset();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

it('uses real file progress and keeps the active request alive when closed and remounted', async () => {
  await ensureAllStringsForTest({ locale: 'en' });
  const manager = getDownloadManager(), gate = Promise.withResolvers<void>();
  let signal: AbortSignal | undefined;
  const request = manager.enqueue({
    key: 'multi',
    title: 'Two files',
    category: 'language-model',
    destination: { kind: 'opfs' },
    files,
    run: async ({ execution }) => {
      signal = execution.signal;
      execution.setFiles({ files });
      await gate.promise;
    },
  });
  {
    using view = mountPanel();
    await view.wrapper.get('[data-testid="model-downloads-trigger"]').trigger('click');
    await flushPromises();
    expect(panel().textContent).toContain('Two files');
    expect(panel().querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe('40');
    panel().querySelector<HTMLButtonElement>(`[data-download-detail="${request.id}"]`)!.click();
    await nextTick();
    expect([...panel().querySelectorAll('[role="progressbar"]')].map(element => element.getAttribute('aria-valuenow'))).toEqual(['100', '20']);
    expect(panel().textContent).toContain(files[1]!.url);
    expect(panel().textContent).toContain(files[1]!.destination);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await nextTick();
    expect(panel()).toBeNull();
  }
  expect(signal?.aborted).toBe(false);
  using reopened = mountPanel();
  await reopened.wrapper.get('[data-testid="model-downloads-trigger"]').trigger('click');
  expect(panel().textContent).toContain('Two files');
  gate.resolve();
  await request.done;
  await flushPromises();
  expect(panel().textContent).toContain('Complete · 1');
  expect(panel().textContent).not.toContain('24.8');
});

it('does not invent a percentage when file size is unresolved', async () => {
  await ensureAllStringsForTest({ locale: 'en' });
  const gate = Promise.withResolvers<void>();
  const manager = getDownloadManager();
  const request = manager.enqueue({ key: 'unknown', title: 'Unknown size', category: 'file', destination: { kind: 'opfs' }, files: [{ ...files[0]!, size: undefined, completed: 0, state: 'queued' }], run: async () => gate.promise });
  using view = mountPanel();
  await view.wrapper.get('[data-testid="model-downloads-trigger"]').trigger('click');
  expect(panel().querySelector('[role="progressbar"]')?.hasAttribute('aria-valuenow')).toBe(false);
  expect(panel().textContent).toContain('Size unknown');
  gate.resolve();
  await request.done;
});

it('clears only completed session history, not queued work', async () => {
  await ensureAllStringsForTest({ locale: 'en' });
  const manager = getDownloadManager();
  const done = manager.enqueue({ key: 'done', title: 'Done', category: 'file', destination: { kind: 'opfs' }, files: [], run: async () => undefined });
  await done.done;
  const gate = Promise.withResolvers<void>();
  const pending = manager.enqueue({ key: 'pending', title: 'Still here', category: 'file', destination: { kind: 'opfs' }, files: [], run: async () => gate.promise });
  using view = mountPanel();
  await view.wrapper.get('[data-testid="model-downloads-trigger"]').trigger('click');
  [...panel().querySelectorAll('button')].find(button => button.textContent?.includes('Clear completed history'))!.click();
  await nextTick();
  expect(manager.snapshot().map(job => job.id)).toEqual([pending.id]);
  gate.resolve();
  await pending.done;
});
