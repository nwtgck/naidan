import { mount } from '@vue/test-utils';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import AdvancedTextEditor from './AdvancedTextEditor.vue';
import { nextTick } from 'vue';

describe('AdvancedTextEditor.vue', () => {
  const initialValue = `Line 1
Line 2
Line 3`;

  const defaultProps = {
    initialValue,
    title: 'Test Editor',
  };

  it('renders initial value correctly', () => {
    const wrapper = mount(AdvancedTextEditor, {
      props: defaultProps,
    });

    const textarea = wrapper.find('textarea');
    expect(textarea.element.value).toBe(initialValue);
  });

  it('emits update:content when input changes', async () => {
    const wrapper = mount(AdvancedTextEditor, {
      props: defaultProps,
    });

    const textarea = wrapper.find('textarea');
    await textarea.setValue('New Content');

    expect(wrapper.emitted('update:content')).toBeTruthy();
    expect(wrapper.emitted('update:content')![0]).toEqual([{ content: 'New Content' }]);
  });

  it('handles undo and redo', async () => {
    vi.useFakeTimers();
    const wrapper = mount(AdvancedTextEditor, {
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
    expect(vm.__testOnly.history.value).toEqual(['Initial', 'Step 1', 'Step 2']);

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
      const wrapper = mount(AdvancedTextEditor, {
        props: { ...defaultProps, initialValue: 'apple banana apple orange' },
      });
      const vm = wrapper.vm as any;

      // Open search mode
      await wrapper.find('button[title^="Find & Replace"]').trigger('click');

      // Find input should be visible now
      const findInput = wrapper.find('[data-testid="find-input"]');
      await findInput.setValue('apple');

      // Verify matches
      expect(vm.__testOnly.searchMatches.value).toHaveLength(2);
      expect(vm.__testOnly.searchMatches.value[0].start).toBe(0);
      expect(vm.__testOnly.searchMatches.value[1].start).toBe(13);
    });

    it('performs replace (single)', async () => {
      const wrapper = mount(AdvancedTextEditor, {
        props: { ...defaultProps, initialValue: 'apple banana apple' },
        attachTo: document.body
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
      const buttons = wrapper.findAll('button');
      const replaceBtn = buttons.find(b => b.text() === 'Replace');

      await replaceBtn?.trigger('click');

      expect(textarea.element.value).toBe('orange banana apple');
      wrapper.unmount();
    });

    it('performs replace all', async () => {
      const wrapper = mount(AdvancedTextEditor, {
        props: { ...defaultProps, initialValue: 'apple banana apple' },
      });

      // Open search mode
      await wrapper.find('button[title^="Find & Replace"]').trigger('click');

      const findInput = wrapper.find('[data-testid="find-input"]');
      await findInput.setValue('apple');

      const replaceInput = wrapper.find('[data-testid="replace-input"]');
      await replaceInput.setValue('orange');

      // Click Replace All button
      const buttons = wrapper.findAll('button');
      const replaceAllBtn = buttons.find(b => b.text() === 'Replace All');
      await replaceAllBtn?.trigger('click');

      const textarea = wrapper.find('textarea');
      expect(textarea.element.value).toBe('orange banana orange');
    });
  });

  it('enters multi-edit mode via shortcut', async () => {
    const wrapper = mount(AdvancedTextEditor, {
      props: { ...defaultProps, initialValue: 'foo bar foo baz' },
      attachTo: document.body
    });
    const vm = wrapper.vm as any;

    const textarea = wrapper.find('textarea');
    await textarea.element.focus();

    // Set selection "foo" at start
    textarea.element.setSelectionRange(0, 3);

    // Trigger Cmd+D (or Ctrl+D)
    await textarea.trigger('keydown', { key: 'd', metaKey: true });

    expect(vm.__testOnly.isMultiEditMode.value).toBe(true);

    // Check overlay existence
    expect(wrapper.find('.absolute.bottom-12').exists()).toBe(true);

    // Simulate typing in multi-edit input
    const multiInput = wrapper.findAll('input').filter(i => i.element.placeholder === 'Type to replace all...')[0];
    await multiInput?.setValue('qux');

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

      const wrapper = mount(AdvancedTextEditor, {
        props: { ...defaultProps, initialValue: 'Line 1\nLine 2\nLine 3' },
        attachTo: document.body
      });
      const vm = wrapper.vm as any;

      // Ensure wrap is ON
      vm.__testOnly.wrapMode.value = 'wrap-on';
      await nextTick();

      // Mock textarea dimensions
      const textarea = wrapper.find('textarea').element;
      Object.defineProperty(textarea, 'clientWidth', { value: 500, configurable: true });

      // Trigger calculation manually
      await vm.__testOnly.calculateLineHeights();

      // Verify ghost creation
      expect(createElementSpy).toHaveBeenCalledWith('div');

      // Verify line heights state
      expect(vm.__testOnly.lineHeights.value).toEqual([40, 40, 40]);

      wrapper.unmount();
    });

    it('does not calculate line heights when wrap is OFF', async () => {
      const wrapper = mount(AdvancedTextEditor, {
        props: { ...defaultProps, initialValue: 'Line 1' },
      });
      const vm = wrapper.vm as any;

      // Set wrap mode to OFF
      vm.__testOnly.wrapMode.value = 'wrap-off';
      await nextTick();

      // Clear
      vm.__testOnly.lineHeights.value = [];
      createElementSpy.mockClear();

      await vm.__testOnly.calculateLineHeights();

      expect(vm.__testOnly.lineHeights.value).toEqual([]);
      expect(createElementSpy).not.toHaveBeenCalled();
    });

    it('syncs line numbers on scroll', async () => {
      const wrapper = mount(AdvancedTextEditor, {
        props: { ...defaultProps, initialValue: 'Line 1\nLine 2\nLine 3' },
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
      const wrapper = mount(AdvancedTextEditor, {
        props: { ...defaultProps, initialValue: 'test' },
      });

      const backdrop = wrapper.find('[data-testid="editor-backdrop"]');
      await backdrop.trigger('click');

      expect(wrapper.emitted('close')).toBeTruthy();
    });

    it('does not close when clicking editor content', async () => {
      const wrapper = mount(AdvancedTextEditor, {
        props: { ...defaultProps, initialValue: 'test' },
      });

      const editor = wrapper.find('[data-testid="advanced-text-editor"]');
      await editor.trigger('click');

      expect(wrapper.emitted('close')).toBeFalsy();
    });

    it('closes on Escape key when not in other modes', async () => {
      const wrapper = mount(AdvancedTextEditor, {
        props: { ...defaultProps, initialValue: 'test' },
        attachTo: document.body
      });

      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));

      expect(wrapper.emitted('close')).toBeTruthy();
      wrapper.unmount();
    });

    it('does not close on Escape if Multi-Edit is active', async () => {
      const wrapper = mount(AdvancedTextEditor, {
        props: { ...defaultProps, initialValue: 'test' },
        attachTo: document.body
      });
      const vm = wrapper.vm as any;

      vm.__testOnly.isMultiEditMode.value = true;

      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));

      // Should exit multi-edit, not close editor
      expect(vm.__testOnly.isMultiEditMode.value).toBe(false);
      expect(wrapper.emitted('close')).toBeFalsy();
      wrapper.unmount();
    });
  });
});
