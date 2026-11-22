import { mount } from '@vue/test-utils';
import { beforeEach, expect, it, vi } from 'vitest';
import { ensureAllStringsForTest } from '@/strings/utils.test-support';
import FileExplorerTranscriptionDialog from './FileExplorerTranscriptionDialog.vue';

vi.mock('@/features/audio-transcription/components/AudioTranscriptionWorkspace.vue', async () => {
  const { defineComponent, h } = await import('vue');
  return {
    default: defineComponent({
      name: 'AudioTranscriptionWorkspace',
      props: ['source', 'file', 'saveText'],
      setup(_props, { slots }) {
        return () => h('div', slots['header-actions']?.());
      },
    }),
  };
});

beforeEach(async () => {
  await ensureAllStringsForTest({ locale: 'en' });
});

it('passes the file and save callback to the file transcription workspace', () => {
  const file = new File(['audio fixture'], 'recording.wav', { type: 'audio/wav' });
  const saveText = vi.fn<({ text }: { text: string }) => Promise<void>>();
  const wrapper = mount(FileExplorerTranscriptionDialog, { props: { file, saveText } });
  using view = {
    wrapper,
    [Symbol.dispose]() {
      wrapper.unmount();
    },
  };
  expect(view.wrapper.getComponent({ name: 'AudioTranscriptionWorkspace' }).props()).toEqual({
    source: 'file',
    file,
    saveText,
  });
});

it('keeps Escape local to the dialog and preserves focus when it closes', () => {
  const button = document.createElement('button');
  using opener = {
    button,
    [Symbol.dispose]() {
      button.remove();
    },
  };
  document.body.append(opener.button);
  opener.button.focus();
  {
    const wrapper = mount(FileExplorerTranscriptionDialog, {
      props: { file: new File([], 'recording.wav'), saveText: undefined },
    });
    using view = {
      wrapper,
      [Symbol.dispose]() {
        wrapper.unmount();
      },
    };
    const panel = document.querySelector<HTMLElement>('[data-testid="file-explorer-transcription-dialog"]');
    if (!panel) {
      throw new Error('Missing transcription dialog');
    }
    expect(document.activeElement).toBe(panel);
    const keydown = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, isComposing: true });
    panel.dispatchEvent(keydown);
    expect(view.wrapper.emitted('close')).toBeUndefined();
    panel.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    expect(view.wrapper.emitted('close')).toHaveLength(1);
  }
  expect(document.activeElement).toBe(opener.button);
});
