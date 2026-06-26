import { mount } from '@vue/test-utils';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import AdvancedTextEditorV3 from './AdvancedTextEditorV3.vue';
import { nextTick } from 'vue';
import { setupScrollToMock } from '@/utils/test-utils';

// Mock scrollTo
setupScrollToMock();

async function flushEditorTasks() {
  await Promise.resolve();
  await nextTick();
}

describe('AdvancedTextEditorV3.vue', () => {
  const initialValue = `Line 1
Line 2
Line 3`;

  const defaultProps = {
    initialValue,
    title: 'Test Editor',
    mode: 'advanced' as const,
  };

  it('renders initial value correctly', () => {
    const wrapper = mount(AdvancedTextEditorV3, {
      props: defaultProps,
    });

    const textarea = wrapper.find('textarea');
    expect(textarea.element.value).toBe(initialValue);
  });

  it('emits update:content when closed', async () => {
    const wrapper = mount(AdvancedTextEditorV3, {
      props: defaultProps,
    });

    const textarea = wrapper.find('textarea');
    await textarea.setValue('New Content');

    // Should not emit live anymore
    expect(wrapper.emitted('update:content')).toBeFalsy();

    // Trigger close
    await wrapper.find('[data-testid="close-button"]').trigger('click');

    expect(wrapper.emitted('update:content')).toBeTruthy();
    expect(wrapper.emitted('update:content')![0]).toEqual([{ content: 'New Content' }]);
  });

  it('handles undo and redo', async () => {
    vi.useFakeTimers();
    const wrapper = mount(AdvancedTextEditorV3, {
      props: { ...defaultProps, initialValue: 'Initial' },
    });
    const vm = wrapper.vm as any;

    const textarea = wrapper.find('textarea');

    // Step 1: Change content
    await textarea.setValue('Step 1');
    vi.advanceTimersByTime(600);

    // Step 2: Change content again
    await textarea.setValue('Step 2');
    vi.advanceTimersByTime(600);

    expect(textarea.element.value).toBe('Step 2');
    // V3 stores history as string[] arrays
    expect(vm.TEST_ONLY.history.value).toHaveLength(3);

    // Undo to Step 1
    await wrapper.find('button[title^="Undo"]').trigger('click');
    expect(textarea.element.value).toBe('Step 1');

    // Undo to Initial
    await wrapper.find('button[title^="Undo"]').trigger('click');
    expect(textarea.element.value).toBe('Initial');

    // Redo to Step 1
    await wrapper.find('button[title^="Redo"]').trigger('click');
    expect(textarea.element.value).toBe('Step 1');

    vi.useRealTimers();
  });

  describe('Search & Replace', () => {
    it('performs search and updates matches', async () => {
      const wrapper = mount(AdvancedTextEditorV3, {
        props: { ...defaultProps, initialValue: 'apple banana apple orange' },
      });
      const vm = wrapper.vm as any;

      // Open search mode
      await wrapper.find('button[title^="Find & Replace"]').trigger('click');

      // Find input should be visible now
      const findInput = wrapper.find('[data-testid="find-input"]');
      await findInput.setValue('apple');
      await flushEditorTasks();

      // Verify matches
      expect(vm.TEST_ONLY.searchMatches.value).toHaveLength(2);
      expect(vm.TEST_ONLY.searchMatches.value[0].start).toBe(0);
      expect(vm.TEST_ONLY.searchMatches.value[1].start).toBe(13);
    });

    it('performs replace (single)', async () => {
      const wrapper = mount(AdvancedTextEditorV3, {
        props: { ...defaultProps, initialValue: 'apple banana apple' },
        attachTo: document.body,
      });

      // Open search mode
      await wrapper.find('button[title^="Find & Replace"]').trigger('click');

      const findInput = wrapper.find('[data-testid="find-input"]');
      await findInput.setValue('apple');

      const replaceInput = wrapper.find('[data-testid="replace-input"]');
      await replaceInput.setValue('orange');

      const textarea = wrapper.find('textarea');
      // Manually set selection to the first match to ensure "single replace" works on it
      textarea.element.setSelectionRange(0, 5); // "apple"

      // Click Replace button
      await wrapper.find('[data-testid="replace-button"]').trigger('click');
      await flushEditorTasks();

      expect(textarea.element.value).toBe('orange banana apple');
      wrapper.unmount();
    });

    it('allows undo after single replace', async () => {
      const wrapper = mount(AdvancedTextEditorV3, {
        props: { ...defaultProps, initialValue: 'apple banana apple' },
        attachTo: document.body,
      });

      await wrapper.find('button[title^="Find & Replace"]').trigger('click');

      const findInput = wrapper.find('[data-testid="find-input"]');
      await findInput.setValue('apple');
      await flushEditorTasks();

      const replaceInput = wrapper.find('[data-testid="replace-input"]');
      await replaceInput.setValue('orange');

      const textarea = wrapper.find('textarea');
      textarea.element.setSelectionRange(0, 5);

      await wrapper.find('[data-testid="replace-button"]').trigger('click');
      await flushEditorTasks();

      expect(textarea.element.value).toBe('orange banana apple');

      await wrapper.find('button[title^="Undo"]').trigger('click');
      await flushEditorTasks();

      expect(textarea.element.value).toBe('apple banana apple');
      wrapper.unmount();
    });

    it('performs replace all', async () => {
      const wrapper = mount(AdvancedTextEditorV3, {
        props: { ...defaultProps, initialValue: 'apple banana apple' },
      });

      // Open search mode
      await wrapper.find('button[title^="Find & Replace"]').trigger('click');

      const findInput = wrapper.find('[data-testid="find-input"]');
      await findInput.setValue('apple');

      const replaceInput = wrapper.find('[data-testid="replace-input"]');
      await replaceInput.setValue('orange');

      // Click Replace All button
      await wrapper.find('[data-testid="replace-all-button"]').trigger('click');
      await flushEditorTasks();

      const textarea = wrapper.find('textarea');
      expect(textarea.element.value).toBe('orange banana orange');
    });

    it('allows undo after replace all', async () => {
      const wrapper = mount(AdvancedTextEditorV3, {
        props: { ...defaultProps, initialValue: 'apple banana apple' },
      });

      await wrapper.find('button[title^="Find & Replace"]').trigger('click');

      const findInput = wrapper.find('[data-testid="find-input"]');
      await findInput.setValue('apple');
      await flushEditorTasks();

      const replaceInput = wrapper.find('[data-testid="replace-input"]');
      await replaceInput.setValue('orange');

      await wrapper.find('[data-testid="replace-all-button"]').trigger('click');
      await flushEditorTasks();

      const textarea = wrapper.find('textarea');
      expect(textarea.element.value).toBe('orange banana orange');

      await wrapper.find('button[title^="Undo"]').trigger('click');
      await flushEditorTasks();

      expect(textarea.element.value).toBe('apple banana apple');
    });
  });

  it('enters multi-edit mode via shortcut', async () => {
    const wrapper = mount(AdvancedTextEditorV3, {
      props: { ...defaultProps, initialValue: 'foo bar foo baz' },
      attachTo: document.body,
    });
    const vm = wrapper.vm as any;

    const textarea = wrapper.find('textarea');
    await textarea.element.focus();

    // Set selection "foo" at start
    textarea.element.setSelectionRange(0, 3);

    // Trigger Cmd+D (or Ctrl+D)
    await textarea.trigger('keydown', { key: 'd', metaKey: true });
    await flushEditorTasks();

    expect(vm.TEST_ONLY.isMultiEditMode.value).toBe(true);

    // Check overlay existence
    expect(wrapper.find('.absolute.bottom-12').exists()).toBe(true);

    // Simulate typing in multi-edit input
    const multiInput = wrapper.find('[data-testid="multi-edit-input"]');
    await multiInput?.setValue('qux');
    await flushEditorTasks();
    await flushEditorTasks();

    expect(textarea.element.value).toBe('qux bar qux baz');

    wrapper.unmount();
  });

  describe('Line Wrap & Height Calculation', () => {
    const originalCreateElement = document.createElement.bind(document);
    let createElementSpy: any;

    beforeEach(() => {
      // Mock getComputedStyle
      vi.spyOn(window, 'getComputedStyle').mockImplementation(() => ({
        paddingLeft: '10px',
        paddingRight: '10px',
        font: '14px monospace',
        lineHeight: '20px',
        getPropertyValue: () => '',
      } as any));

      // Standard mocks for DOM manipulation
      vi.spyOn(document.body, 'appendChild').mockImplementation((node) => node);
      vi.spyOn(document.body, 'removeChild').mockImplementation((node) => node);
      createElementSpy = vi.spyOn(document, 'createElement');
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('calculates line heights correctly when wrap is ON', async () => {
      createElementSpy.mockImplementation((tagName: string) => {
        const el = originalCreateElement(tagName);
        if (tagName === 'div') {
          Object.defineProperty(el, 'clientHeight', { value: 40, configurable: true });
        }
        return el;
      });

      const wrapper = mount(AdvancedTextEditorV3, {
        props: { ...defaultProps, initialValue: `\
Line 1
Line 2
Line 3` },
        attachTo: document.body,
      });
      const vm = wrapper.vm as any;

      // Ensure wrap is ON
      vm.TEST_ONLY.wrapMode.value = 'wrap-on';
      await nextTick();

      // Mock textarea dimensions
      const textarea = wrapper.find('textarea').element;
      Object.defineProperty(textarea, 'clientWidth', { value: 500, configurable: true });

      // Trigger calculation manually
      await vm.TEST_ONLY.calculateLineHeights();

      // Verify ghost creation
      expect(createElementSpy).toHaveBeenCalledWith('div');

      // Verify line heights state
      expect(vm.TEST_ONLY.lineHeights.value).toEqual([40, 40, 40]);

      wrapper.unmount();
    });

    it('does not calculate line heights when wrap is OFF', async () => {
      const wrapper = mount(AdvancedTextEditorV3, {
        props: { ...defaultProps, initialValue: 'Line 1' },
      });
      const vm = wrapper.vm as any;

      // Set wrap mode to OFF
      vm.TEST_ONLY.wrapMode.value = 'wrap-off';
      await nextTick();

      // Clear
      vm.TEST_ONLY.lineHeights.value = [];
      createElementSpy.mockClear();

      await vm.TEST_ONLY.calculateLineHeights();

      expect(vm.TEST_ONLY.lineHeights.value).toEqual([]);
      expect(createElementSpy).not.toHaveBeenCalled();
    });

    it('syncs line numbers on scroll', async () => {
      const wrapper = mount(AdvancedTextEditorV3, {
        props: { ...defaultProps, initialValue: `\
Line 1
Line 2
Line 3` },
      });

      const textarea = wrapper.find('textarea');
      Object.defineProperty(textarea.element, 'scrollTop', { value: 100, configurable: true });

      // Trigger scroll event
      await textarea.trigger('scroll');

      // Wait for rAF
      await new Promise(resolve => requestAnimationFrame(resolve));

      const lineNumbersContainer = wrapper.find('.will-change-transform');
      expect((lineNumbersContainer.element as HTMLElement).style.transform).toBe('translateY(-100px)');
    });

    it('handles backdrop click correctly', async () => {
      const wrapper = mount(AdvancedTextEditorV3, {
        props: { ...defaultProps, initialValue: 'test' },
      });

      const backdrop = wrapper.find('[data-testid="editor-backdrop"]');
      await backdrop.trigger('click');

      expect(wrapper.emitted('close')).toBeTruthy();
    });

    it('does not close when clicking editor content', async () => {
      const wrapper = mount(AdvancedTextEditorV3, {
        props: { ...defaultProps, initialValue: 'test' },
      });

      const editor = wrapper.find('[data-testid="advanced-text-editor"]');
      await editor.trigger('click');

      expect(wrapper.emitted('close')).toBeFalsy();
    });

    it('closes on Escape key when not in other modes', async () => {
      const wrapper = mount(AdvancedTextEditorV3, {
        props: { ...defaultProps, initialValue: 'test' },
        attachTo: document.body,
      });

      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));

      expect(wrapper.emitted('close')).toBeTruthy();
      wrapper.unmount();
    });

    it('does not close on Escape if Multi-Edit is active', async () => {
      const wrapper = mount(AdvancedTextEditorV3, {
        props: { ...defaultProps, initialValue: 'test' },
        attachTo: document.body,
      });
      const vm = wrapper.vm as any;

      vm.TEST_ONLY.isMultiEditMode.value = true;

      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));

      // Should exit multi-edit, not close editor
      expect(vm.TEST_ONLY.isMultiEditMode.value).toBe(false);
      expect(wrapper.emitted('close')).toBeFalsy();
      wrapper.unmount();
    });

    it('toggles between advanced and textarea modes', async () => {
      const wrapper = mount(AdvancedTextEditorV3, {
        props: defaultProps,
      });

      // Initial state (advanced)
      expect(wrapper.find('.absolute.left-0.w-12').exists()).toBe(true); // Line numbers
      expect(wrapper.find('textarea').classes()).toContain('pl-16');

      // Toggle to textarea mode
      const toggleBtn = wrapper.find('[data-testid="toggle-mode-button"]');
      await toggleBtn.trigger('click');

      expect(wrapper.find('.absolute.left-0.w-12').exists()).toBe(false); // Line numbers hidden
      expect(wrapper.find('textarea').classes()).toContain('pl-5');
      expect(wrapper.emitted('update:mode')).toBeTruthy();
      expect(wrapper.emitted('update:mode')![0]).toEqual([{ mode: 'textarea' }]);

      // Toggle back to advanced mode
      await toggleBtn.trigger('click');
      expect(wrapper.find('.absolute.left-0.w-12').exists()).toBe(true);
      expect(wrapper.find('textarea').classes()).toContain('pl-16');
      expect(wrapper.emitted('update:mode')![1]).toEqual([{ mode: 'advanced' }]);
    });
  });

  describe('Line-based model', () => {
    it('stores content as lines internally', () => {
      const wrapper = mount(AdvancedTextEditorV3, {
        props: { ...defaultProps, initialValue: `\
line1
line2
line3` },
      });
      const vm = wrapper.vm as any;

      expect(vm.TEST_ONLY.lines.value).toEqual(['line1', 'line2', 'line3']);
    });

    it('updates lines when textarea value changes', async () => {
      const wrapper = mount(AdvancedTextEditorV3, {
        props: { ...defaultProps, initialValue: 'hello' },
      });
      const vm = wrapper.vm as any;

      const textarea = wrapper.find('textarea');
      await textarea.setValue(`\
foo
bar`);

      expect(vm.TEST_ONLY.lines.value).toEqual(['foo', 'bar']);
    });

    it('shows and clears busy indicator during async search updates', async () => {
      const wrapper = mount(AdvancedTextEditorV3, {
        props: { ...defaultProps, initialValue: 'alpha beta alpha' },
      });

      await wrapper.find('button[title^="Find & Replace"]').trigger('click');
      const findInput = wrapper.find('[data-testid="find-input"]');
      await findInput.setValue('alpha');

      expect(wrapper.find('[data-testid="search-busy-indicator"]').exists()).toBe(true);
      await flushEditorTasks();

      expect(wrapper.find('[data-testid="search-busy-indicator"]').exists()).toBe(false);
      expect((wrapper.vm as any).TEST_ONLY.searchMatches.value).toHaveLength(2);
    });
  });

  describe('Emacs Keybindings', () => {
    it('Ctrl+A moves cursor to beginning of line', async () => {
      const wrapper = mount(AdvancedTextEditorV3, {
        props: { ...defaultProps, initialValue: 'hello world' },
        attachTo: document.body,
      });

      const textarea = wrapper.find('textarea');
      textarea.element.focus();
      textarea.element.setSelectionRange(5, 5); // Middle of line

      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', ctrlKey: true }));
      await nextTick();

      expect(textarea.element.selectionStart).toBe(0);
      wrapper.unmount();
    });

    it('Ctrl+E moves cursor to end of line', async () => {
      const wrapper = mount(AdvancedTextEditorV3, {
        props: { ...defaultProps, initialValue: `\
hello world
second line` },
        attachTo: document.body,
      });

      const textarea = wrapper.find('textarea');
      textarea.element.focus();
      textarea.element.setSelectionRange(3, 3); // Middle of first line

      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'e', ctrlKey: true }));
      await nextTick();

      // Should be at end of first line (position 11, before \n)
      expect(textarea.element.selectionStart).toBe(11);
      wrapper.unmount();
    });

    it('Ctrl+K kills text from cursor to end of line', async () => {
      const wrapper = mount(AdvancedTextEditorV3, {
        props: { ...defaultProps, initialValue: 'hello world' },
        attachTo: document.body,
      });

      const textarea = wrapper.find('textarea');
      textarea.element.focus();
      textarea.element.setSelectionRange(5, 5);

      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true }));
      await nextTick();

      expect(textarea.element.value).toBe('hello');
      wrapper.unmount();
    });

    it('Ctrl+B moves cursor backward one character', async () => {
      const wrapper = mount(AdvancedTextEditorV3, {
        props: { ...defaultProps, initialValue: 'hello' },
        attachTo: document.body,
      });

      const textarea = wrapper.find('textarea');
      textarea.element.focus();
      textarea.element.setSelectionRange(3, 3);

      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'b', ctrlKey: true }));
      await nextTick();

      expect(textarea.element.selectionStart).toBe(2);
      wrapper.unmount();
    });

    it('Ctrl+H deletes character before cursor', async () => {
      const wrapper = mount(AdvancedTextEditorV3, {
        props: { ...defaultProps, initialValue: 'hello' },
        attachTo: document.body,
      });

      const textarea = wrapper.find('textarea');
      textarea.element.focus();
      textarea.element.setSelectionRange(3, 3);

      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'h', ctrlKey: true }));
      await nextTick();

      expect(textarea.element.value).toBe('helo');
      wrapper.unmount();
    });

    it('Ctrl+T transposes two characters before cursor', async () => {
      const wrapper = mount(AdvancedTextEditorV3, {
        props: { ...defaultProps, initialValue: 'abcd' },
        attachTo: document.body,
      });

      const textarea = wrapper.find('textarea');
      textarea.element.focus();
      textarea.element.setSelectionRange(3, 3); // cursor after 'c'

      window.dispatchEvent(new KeyboardEvent('keydown', { key: 't', ctrlKey: true }));
      await nextTick();

      expect(textarea.element.value).toBe('acbd');
      wrapper.unmount();
    });
  });
});
