import { mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';
import { ensureAllStringsForTest } from '@/strings/utils.test-support';
import EditorV4 from './EditorV4.vue';

beforeEach(async () => {
  await ensureAllStringsForTest({ locale: 'en' });
});

afterEach(() => {
  vi.useRealTimers();
});

function mountEditor({ text }: { text: string }) {
  const wrapper = mount(EditorV4, { props: { initialText: text, readOnly: false }, attachTo: document.body });
  return {
    wrapper,
    textarea: wrapper.get<HTMLTextAreaElement>('[data-testid="editor-v4-input"]'),
    [Symbol.dispose]() {
      wrapper.unmount();
    },
  };
}

function nativeInput({
  textarea, value, caret, inputType, composing,
}: { textarea: HTMLTextAreaElement, value: string, caret: number, inputType: string, composing: boolean }): void {
  textarea.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType, isComposing: composing }));
  textarea.value = value;
  textarea.setSelectionRange(caret, caret);
  textarea.dispatchEvent(new InputEvent('input', { bubbles: true, inputType, isComposing: composing }));
}

describe('EditorV4', () => {
  it('applies a native edit to the selected occurrences and undoes them together', async () => {
    using editor = mountEditor({ text: 'item item item' });
    editor.textarea.element.setSelectionRange(0, 4);
    await editor.textarea.trigger('keydown', { key: 'd', ctrlKey: true });

    nativeInput({ textarea: editor.textarea.element, value: 'entry item item', caret: 5, inputType: 'insertText', composing: false });
    await nextTick();

    expect(editor.textarea.element.value).toBe('entry entry item');
    expect(editor.wrapper.vm.getSnapshot()).toMatchObject({ dirty: true, text: 'entry entry item' });

    await editor.textarea.trigger('keydown', { key: 'z', ctrlKey: true });
    expect(editor.textarea.element.value).toBe('item item item');
    expect(editor.wrapper.vm.getSnapshot()).toMatchObject({ dirty: false });
  });

  it('commits native Japanese composition to all carets once', async () => {
    using editor = mountEditor({ text: 'item item' });
    const textarea = editor.textarea.element;
    textarea.setSelectionRange(0, 4);
    await editor.textarea.trigger('keydown', { key: 'L', ctrlKey: true, shiftKey: true });
    textarea.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));

    nativeInput({ textarea, value: 'へん item', caret: 2, inputType: 'insertCompositionText', composing: true });
    expect(editor.wrapper.emitted('change')).toBeUndefined();
    nativeInput({ textarea, value: '変更 item', caret: 2, inputType: 'insertCompositionText', composing: true });
    textarea.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '変更' }));
    textarea.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: '変更' }));

    await nextTick();
    expect(textarea.value).toBe('変更 変更');
    expect(editor.wrapper.emitted('change')).toHaveLength(1);
    await editor.textarea.trigger('keydown', { key: 'z', ctrlKey: true });
    expect(textarea.value).toBe('item item');
  });

  it('retains Cmd+D carets when moving to the end of the selections and typing', async () => {
    const platform = vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel');
    using _restore = {
      [Symbol.dispose]() {
        platform.mockRestore();
      },
    };
    using editor = mountEditor({ text: 'item item item' });
    const textarea = editor.textarea.element;
    textarea.setSelectionRange(0, 4);
    await editor.textarea.trigger('keydown', { key: 'd', metaKey: true });
    await editor.textarea.trigger('keydown', { key: 'd', metaKey: true });

    const right = new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true });
    if (textarea.dispatchEvent(right)) {
      textarea.setSelectionRange(4, 4);
    }
    await editor.textarea.trigger('keyup', { key: 'ArrowRight' });
    expect(textarea.selectionStart).toBe(4);
    expect(textarea.selectionEnd).toBe(4);
    nativeInput({ textarea, value: 'item! item item', caret: 5, inputType: 'insertText', composing: false });
    expect(textarea.value).toBe('item! item! item!');

    await editor.textarea.trigger('keydown', { key: 'z', metaKey: true });
    expect(textarea.value).toBe('item item item');
  });

  it('deletes the preceding word at every caret in one undoable operation', async () => {
    using editor = mountEditor({ text: 'alpha beta alpha beta' });
    const textarea = editor.textarea.element;
    textarea.setSelectionRange(6, 10);
    await editor.textarea.trigger('keydown', { key: 'd', ctrlKey: true });
    await editor.textarea.trigger('keydown', { key: 'ArrowRight' });

    const beforeInput = new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'deleteWordBackward' });
    expect(textarea.dispatchEvent(beforeInput)).toBe(false);
    expect(textarea.value).toBe('alpha  alpha ');
    await editor.textarea.trigger('keydown', { key: 'z', ctrlKey: true });
    expect(textarea.value).toBe('alpha beta alpha beta');
  });

  it('deletes the following word at every caret when native beforeinput cannot be canceled', async () => {
    using editor = mountEditor({ text: 'alpha beta alpha beta' });
    const textarea = editor.textarea.element;
    textarea.setSelectionRange(0, 5);
    await editor.textarea.trigger('keydown', { key: 'd', ctrlKey: true });
    await editor.textarea.trigger('keydown', { key: 'ArrowLeft' });

    const inputType = 'deleteWordForward';
    expect(textarea.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, inputType }))).toBe(true);
    textarea.value = ' beta alpha beta';
    textarea.setSelectionRange(0, 0);
    textarea.dispatchEvent(new InputEvent('input', { bubbles: true, inputType }));
    expect(textarea.value).toBe(' beta  beta');
    await editor.textarea.trigger('keydown', { key: 'z', ctrlKey: true });
    expect(textarea.value).toBe('alpha beta alpha beta');
  });

  it('keeps edits after a pending save dirty and recognizes the saved undo state', async () => {
    using editor = mountEditor({ text: 'a' });
    const textarea = editor.textarea.element;
    textarea.setSelectionRange(1, 1);
    nativeInput({ textarea, value: 'ab', caret: 2, inputType: 'insertText', composing: false });
    const { checkpoint } = editor.wrapper.vm.captureSavepoint();
    await editor.textarea.trigger('keydown', { key: 's', ctrlKey: true });
    expect(editor.wrapper.emitted('request-save')).toHaveLength(1);
    nativeInput({ textarea, value: 'abc', caret: 3, inputType: 'insertText', composing: false });

    editor.wrapper.vm.markSaved({ checkpoint });
    expect(editor.wrapper.vm.getSnapshot()).toMatchObject({ text: 'abc', dirty: true });
    await editor.textarea.trigger('keydown', { key: 'z', ctrlKey: true });
    expect(editor.wrapper.vm.getSnapshot()).toMatchObject({ text: 'ab', dirty: false });
  });

  it('finds and replaces literal text through the editor panel in a single transaction', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    using editor = mountEditor({ text: 'apple APPLE plum' });
    await editor.textarea.trigger('keydown', { key: 'h', ctrlKey: true });
    await editor.wrapper.get('[data-testid="editor-v4-find"]').setValue('apple');
    await vi.advanceTimersByTimeAsync(100);
    expect(editor.wrapper.get('[data-testid="editor-v4-match-count"]').text()).toBe('1 of 2');
    await editor.wrapper.get('[data-testid="editor-v4-replacement"]').setValue('$&');
    await editor.wrapper.get('[data-testid="editor-v4-replace-all"]').trigger('click');
    await vi.advanceTimersByTimeAsync(100);

    expect(editor.textarea.element.value).toBe('$& $& plum');
    await editor.textarea.trigger('keydown', { key: 'z', ctrlKey: true });
    expect(editor.textarea.element.value).toBe('apple APPLE plum');
  });

  it('keeps navigation and single replacement available after the bulk replacement limit', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const text = 'a '.repeat(20_001);
    using editor = mountEditor({ text });
    await editor.textarea.trigger('keydown', { key: 'h', ctrlKey: true });
    await editor.wrapper.get('[data-testid="editor-v4-find"]').setValue('a');
    await vi.advanceTimersByTimeAsync(100);
    await editor.wrapper.get('[data-testid="editor-v4-replacement"]').setValue('b');

    const replaceAll = editor.wrapper.get<HTMLButtonElement>('[data-testid="editor-v4-replace-all"]');
    const replaceCurrent = editor.wrapper.get<HTMLButtonElement>('[data-testid="editor-v4-replace-current"]');
    await replaceAll.trigger('click');
    await vi.advanceTimersByTimeAsync(100);
    expect(editor.textarea.element.value).toBe(text);
    expect(replaceAll.element.disabled).toBe(true);
    expect(replaceCurrent.element.disabled).toBe(false);
    expect(editor.wrapper.get('p[role="status"]').text()).toContain('Too many characters');

    await editor.wrapper.get('[aria-label="Next match"]').trigger('click');
    expect(editor.wrapper.get('p[role="status"]').text()).toContain('Too many characters');
    await vi.advanceTimersByTimeAsync(100);
    expect(editor.wrapper.get('[data-testid="editor-v4-match-count"]').text()).toBe('2 of 20001');
    await editor.wrapper.get('[aria-label="Previous match"]').trigger('click');
    await vi.advanceTimersByTimeAsync(100);
    expect(editor.wrapper.get('[data-testid="editor-v4-match-count"]').text()).toBe('1 of 20001');
    expect(replaceAll.element.disabled).toBe(true);

    await replaceCurrent.trigger('click');
    await vi.advanceTimersByTimeAsync(100);
    expect(editor.textarea.element.value).toBe('b' + text.slice(1));
  });
});
