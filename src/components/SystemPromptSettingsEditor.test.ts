import type { SystemPrompt } from '@/01-models/types';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import SystemPromptSettingsEditor from './SystemPromptSettingsEditor.vue';

function mountEditor({
  modelValue,
  parentPromptText,
}: {
  modelValue: SystemPrompt | undefined,
  parentPromptText: string,
}): {
  wrapper: VueWrapper,
  persistedValue: { current: SystemPrompt | undefined },
} {
  const wrapperReference: { current: VueWrapper | undefined } = {
    current: undefined,
  };
  const persistedValue: { current: SystemPrompt | undefined } = {
    current: modelValue,
  };

  const wrapper = mount(SystemPromptSettingsEditor, {
    props: {
      modelValue,
      title: 'System Prompt',
      parentModeLabel: 'Parent',
      noPromptModeLabel: 'No Prompt',
      replaceModeLabel: 'Replace',
      appendModeLabel: 'Append',
      parentPromptText,
      parentPromptSetCaption: 'Parent: Set',
      parentPromptNotSetCaption: 'Parent: Not set',
      noPromptCaption: 'No system prompt',
      replaceCaption: 'Instructions for this scope',
      appendCaption: 'Instructions to append',
      typeToReplacePlaceholder: 'Start typing to replace',
      replacePlaceholder: 'Enter replacement instructions',
      appendPlaceholder: 'Enter additional instructions',
      resetKey: 'scope-1',
      testIdPrefix: 'system-prompt',
      rows: 4,
      'onUpdate:modelValue': (value: SystemPrompt | undefined) => {
        persistedValue.current = value;
        void wrapperReference.current?.setProps({ modelValue: value });
      },
    },
  });

  wrapperReference.current = wrapper;

  return { wrapper, persistedValue };
}

async function selectMode({
  wrapper,
  mode,
}: {
  wrapper: VueWrapper,
  mode: 'parent' | 'no-prompt' | 'replace' | 'append',
}): Promise<void> {
  await wrapper.get(`[data-testid="system-prompt-${mode}-button"]`).trigger('click');
  await flushPromises();
}

function editorElement({ wrapper }: { wrapper: VueWrapper }): HTMLTextAreaElement {
  return wrapper.get('[data-testid="system-prompt-textarea"]').element as HTMLTextAreaElement;
}

function editorValue({ wrapper }: { wrapper: VueWrapper }): string {
  return editorElement({ wrapper }).value;
}

async function enterEditorValue({
  wrapper,
  value,
}: {
  wrapper: VueWrapper,
  value: string,
}): Promise<void> {
  await wrapper.get('[data-testid="system-prompt-textarea"]').setValue(value);
  await flushPromises();
}

describe('SystemPromptSettingsEditor editing session', () => {
  it('uses one editor buffer across repeated Replace and Append toggles', async () => {
    const { wrapper, persistedValue } = mountEditor({
      modelValue: undefined,
      parentPromptText: '',
    });

    await selectMode({ wrapper, mode: 'replace' });
    await enterEditorValue({ wrapper, value: 'Shared draft' });

    for (let index = 0; index < 5; index += 1) {
      await selectMode({ wrapper, mode: 'append' });
      expect(editorValue({ wrapper })).toBe('Shared draft');
      expect(persistedValue.current).toEqual({
        behavior: 'append',
        content: 'Shared draft',
      });

      await selectMode({ wrapper, mode: 'replace' });
      expect(editorValue({ wrapper })).toBe('Shared draft');
      expect(persistedValue.current).toEqual({
        behavior: 'override',
        content: 'Shared draft',
      });
    }
  });

  it('keeps the latest edit when it was entered in either editable mode', async () => {
    const { wrapper } = mountEditor({
      modelValue: undefined,
      parentPromptText: '',
    });

    await selectMode({ wrapper, mode: 'replace' });
    await enterEditorValue({ wrapper, value: 'Written while replacing' });
    await selectMode({ wrapper, mode: 'append' });
    expect(editorValue({ wrapper })).toBe('Written while replacing');

    await enterEditorValue({ wrapper, value: 'Revised while appending' });
    await selectMode({ wrapper, mode: 'replace' });
    expect(editorValue({ wrapper })).toBe('Revised while appending');
    await selectMode({ wrapper, mode: 'append' });
    expect(editorValue({ wrapper })).toBe('Revised while appending');
  });

  it('keeps the editor buffer behind Parent and No Prompt displays', async () => {
    const { wrapper } = mountEditor({
      modelValue: undefined,
      parentPromptText: 'Parent prompt',
    });
    const textarea = editorElement({ wrapper });

    await selectMode({ wrapper, mode: 'replace' });
    await enterEditorValue({ wrapper, value: 'In-progress prompt' });

    await selectMode({ wrapper, mode: 'parent' });
    expect(editorElement({ wrapper })).toBe(textarea);
    expect(editorValue({ wrapper })).toBe('Parent prompt');

    await selectMode({ wrapper, mode: 'no-prompt' });
    expect(editorElement({ wrapper })).toBe(textarea);
    expect(editorValue({ wrapper })).toBe('');

    await selectMode({ wrapper, mode: 'append' });
    expect(editorElement({ wrapper })).toBe(textarea);
    expect(editorValue({ wrapper })).toBe('In-progress prompt');

    await selectMode({ wrapper, mode: 'replace' });
    expect(editorElement({ wrapper })).toBe(textarea);
    expect(editorValue({ wrapper })).toBe('In-progress prompt');
  });

  it('preserves an intentionally empty editor buffer across every mode', async () => {
    const { wrapper } = mountEditor({
      modelValue: undefined,
      parentPromptText: 'Parent prompt',
    });

    await selectMode({ wrapper, mode: 'replace' });
    await enterEditorValue({ wrapper, value: '' });
    await selectMode({ wrapper, mode: 'append' });
    expect(editorValue({ wrapper })).toBe('');
    await selectMode({ wrapper, mode: 'parent' });
    expect(editorValue({ wrapper })).toBe('Parent prompt');
    await selectMode({ wrapper, mode: 'replace' });
    expect(editorValue({ wrapper })).toBe('');
    await selectMode({ wrapper, mode: 'no-prompt' });
    await selectMode({ wrapper, mode: 'append' });
    expect(editorValue({ wrapper })).toBe('');
  });

  it('starts direct Append empty instead of copying the parent prompt', async () => {
    const { wrapper, persistedValue } = mountEditor({
      modelValue: undefined,
      parentPromptText: 'Parent prompt',
    });

    await selectMode({ wrapper, mode: 'append' });

    expect(editorValue({ wrapper })).toBe('');
    expect(persistedValue.current).toEqual({ behavior: 'append', content: '' });

    await selectMode({ wrapper, mode: 'replace' });
    expect(editorValue({ wrapper })).toBe('');
    expect(persistedValue.current).toEqual({ behavior: 'override', content: '' });
  });

  it('materializes the parent for Replace and then keeps that same buffer in Append', async () => {
    const { wrapper, persistedValue } = mountEditor({
      modelValue: undefined,
      parentPromptText: 'Parent prompt',
    });

    await selectMode({ wrapper, mode: 'replace' });
    expect(editorValue({ wrapper })).toBe('Parent prompt');

    await selectMode({ wrapper, mode: 'append' });
    expect(editorValue({ wrapper })).toBe('Parent prompt');
    expect(persistedValue.current).toEqual({
      behavior: 'append',
      content: 'Parent prompt',
    });
  });

  it.each([
    {
      name: 'Replace',
      modelValue: { behavior: 'override', content: 'Saved editable prompt' } satisfies SystemPrompt,
      otherMode: 'append' as const,
      expectedPersistence: { behavior: 'append', content: 'Saved editable prompt' } satisfies SystemPrompt,
    },
    {
      name: 'Append',
      modelValue: { behavior: 'append', content: 'Saved editable prompt' } satisfies SystemPrompt,
      otherMode: 'replace' as const,
      expectedPersistence: { behavior: 'override', content: 'Saved editable prompt' } satisfies SystemPrompt,
    },
  ])('initializes one buffer from persisted $name content', async ({
    modelValue,
    otherMode,
    expectedPersistence,
  }) => {
    const { wrapper, persistedValue } = mountEditor({
      modelValue,
      parentPromptText: 'Parent prompt',
    });

    expect(editorValue({ wrapper })).toBe('Saved editable prompt');
    await selectMode({ wrapper, mode: otherMode });
    expect(editorValue({ wrapper })).toBe('Saved editable prompt');
    expect(persistedValue.current).toEqual(expectedPersistence);
  });

  it.each(['parent', 'no-prompt'] as const)(
    'turns editing in %s mode into Replace without losing the entered text',
    async (startMode) => {
      const { wrapper, persistedValue } = mountEditor({
        modelValue: undefined,
        parentPromptText: 'Parent prompt',
      });

      await selectMode({ wrapper, mode: startMode });
      await enterEditorValue({ wrapper, value: 'Edited visible text' });

      expect(persistedValue.current).toEqual({
        behavior: 'override',
        content: 'Edited visible text',
      });
      await selectMode({ wrapper, mode: 'append' });
      expect(editorValue({ wrapper })).toBe('Edited visible text');
    },
  );

  it('does not reinitialize the buffer from immediately echoed persisted DTOs', async () => {
    const { wrapper } = mountEditor({
      modelValue: undefined,
      parentPromptText: '',
    });

    await selectMode({ wrapper, mode: 'replace' });
    await enterEditorValue({ wrapper, value: 'A' });
    await enterEditorValue({ wrapper, value: 'AB' });
    await enterEditorValue({ wrapper, value: 'ABC' });
    await selectMode({ wrapper, mode: 'append' });
    await selectMode({ wrapper, mode: 'replace' });

    expect(editorValue({ wrapper })).toBe('ABC');
  });

  it('discards the memory-only buffer when the editor is unmounted', async () => {
    const first = mountEditor({
      modelValue: undefined,
      parentPromptText: 'Parent prompt',
    });

    await selectMode({ wrapper: first.wrapper, mode: 'replace' });
    await enterEditorValue({ wrapper: first.wrapper, value: 'Unsaved session buffer' });
    await selectMode({ wrapper: first.wrapper, mode: 'no-prompt' });
    first.wrapper.unmount();

    const reopened = mountEditor({
      modelValue: first.persistedValue.current,
      parentPromptText: 'Parent prompt',
    });
    expect(editorValue({ wrapper: reopened.wrapper })).toBe('');

    await selectMode({ wrapper: reopened.wrapper, mode: 'replace' });
    expect(editorValue({ wrapper: reopened.wrapper })).toBe('Parent prompt');
  });

  it('follows external persisted mode changes without discarding the session buffer', async () => {
    const { wrapper } = mountEditor({
      modelValue: undefined,
      parentPromptText: 'Parent prompt',
    });

    await selectMode({ wrapper, mode: 'replace' });
    await enterEditorValue({ wrapper, value: 'In-progress prompt' });

    await wrapper.setProps({
      modelValue: undefined,
    });
    await flushPromises();

    expect(editorValue({ wrapper })).toBe('Parent prompt');
    await selectMode({ wrapper, mode: 'append' });
    expect(editorValue({ wrapper })).toBe('In-progress prompt');
  });

  it('starts a new editing session when the owning scope changes', async () => {
    const { wrapper } = mountEditor({
      modelValue: undefined,
      parentPromptText: 'First parent prompt',
    });

    await selectMode({ wrapper, mode: 'replace' });
    await enterEditorValue({ wrapper, value: 'First session draft' });
    await selectMode({ wrapper, mode: 'append' });

    await wrapper.setProps({
      modelValue: { behavior: 'append', content: 'Second saved prompt' },
      parentPromptText: 'Second parent prompt',
      resetKey: 'scope-2',
    });
    await flushPromises();

    expect(editorValue({ wrapper })).toBe('Second saved prompt');
    await selectMode({ wrapper, mode: 'replace' });
    expect(editorValue({ wrapper })).toBe('Second saved prompt');
  });
});
