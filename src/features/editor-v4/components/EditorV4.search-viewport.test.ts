import { mount } from '@vue/test-utils';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ensureAllStringsForTest } from '@/strings/utils.test-support';
import { createEditorSearchWorker } from '@/features/editor-v4/worker/impl';
import type { EditorSearchClient } from '@/features/editor-v4/worker/types';
import EditorV4 from './EditorV4.vue';

const createClient = vi.hoisted(() => vi.fn<() => Promise<EditorSearchClient>>());
vi.mock('@/features/editor-v4/worker/client', () => ({ createEditorSearchClient: createClient }));

const text = ['match at top', ...Array.from({ length: 60 }, () => 'blank'), 'match first', 'match second'].join('\n');
const firstDistant = text.indexOf('match first');
const lastDistant = text.indexOf('match second');

beforeEach(async () => {
  await ensureAllStringsForTest({ locale: 'en' });
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'requestAnimationFrame', 'cancelAnimationFrame'] });
});

afterEach(() => {
  vi.restoreAllMocks();
  createClient.mockReset();
  vi.useRealTimers();
});

function mountWrappedEditor() {
  const createRange = document.createRange.bind(document);
  vi.spyOn(document, 'createRange').mockImplementation(() => {
    const range = createRange();
    range.getBoundingClientRect = () => {
      const pieceOffset = Number(range.startContainer.parentElement?.dataset.offset ?? 0);
      const textOffset = pieceOffset + range.startOffset;
      const row = text.slice(0, textOffset).split('\n').length - 1;
      return new DOMRect(0, 8 + row * 20, 0, 20);
    };
    return range;
  });
  const worker = createEditorSearchWorker({ runtime: 'worker' });
  const client = { ...worker, search: vi.fn(worker.search), dispose: vi.fn(async () => {}) };
  createClient.mockResolvedValue(client);
  const wrapper = mount(EditorV4, { props: { initialText: text, readOnly: false, wordWrap: true } });
  const textarea = wrapper.get<HTMLTextAreaElement>('[data-testid="editor-v4-input"]');
  Object.defineProperty(textarea.element, 'clientHeight', { value: 160 });
  return {
    wrapper,
    textarea,
    client,
    worker,
    async find() {
      await textarea.trigger('scroll');
      await vi.advanceTimersByTimeAsync(20);
      await textarea.trigger('keydown', { key: 'f', ctrlKey: true });
      const field = wrapper.get('[data-testid="editor-v4-find"]');
      await field.setValue('match');
      await vi.advanceTimersByTimeAsync(100);
      return field;
    },
    [Symbol.dispose]() {
      wrapper.unmount();
    },
  };
}

it('refreshes nearby highlights after revealing the next match outside the wrapped viewport', async () => {
  using editor = mountWrappedEditor();
  const field = await editor.find();
  expect(editor.client.search).toHaveBeenCalledTimes(1);

  await field.trigger('keydown', { key: 'Enter' });
  await vi.advanceTimersByTimeAsync(250);

  expect(editor.textarea.element.selectionStart).toBe(firstDistant);
  expect(editor.client.search).toHaveBeenCalledTimes(3);
  expect(editor.client.search.mock.calls[2]?.[0].request).toMatchObject({ target: { kind: 'index', index: 1 }, visible: { end: text.length } });
  expect(editor.wrapper.get(`[data-testid="editor-v4-mirror-viewport"] [data-offset="${lastDistant}"]`).text()).toBe('match');
});

it('refreshes the newer viewport after an in-flight search measured the previous viewport', async () => {
  using editor = mountWrappedEditor();
  await editor.find();
  const blocked = Promise.withResolvers<void>();
  editor.client.search.mockImplementationOnce(async ({ request }) => {
    const result = await editor.worker.search({ request });
    await blocked.promise;
    return result;
  });
  editor.textarea.element.value = text.replace('blank', 'other');
  editor.textarea.element.setSelectionRange(0, 0);
  editor.textarea.element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertReplacementText' }));
  await vi.advanceTimersByTimeAsync(100);
  expect(editor.client.search).toHaveBeenCalledTimes(2);
  expect(editor.client.search.mock.calls[1]?.[0].request.visible.end).toBeLessThan(firstDistant);

  editor.textarea.element.scrollTop = 60 * 20;
  await editor.textarea.trigger('scroll');
  await vi.advanceTimersByTimeAsync(20);
  expect(editor.client.search).toHaveBeenCalledTimes(2);
  blocked.resolve();
  await vi.advanceTimersByTimeAsync(250);

  expect(editor.client.search).toHaveBeenCalledTimes(3);
  expect(editor.client.search.mock.calls[2]?.[0].request).toMatchObject({ target: { kind: 'index', index: 0 }, visible: { end: text.length } });
  expect(editor.wrapper.get(`[data-testid="editor-v4-mirror-viewport"] [data-offset="${lastDistant}"]`).text()).toBe('match');
});
