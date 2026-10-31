import { mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it } from 'vitest';
import { ensureAllStringsForTest } from '@/strings/utils.test-support';
import LiveConversationInput from './LiveConversationInput.vue';

beforeEach(async () => {
  await ensureAllStringsForTest({ locale: 'en' });
});

function fixture() {
  const wrapper = mount(LiveConversationInput, { props: { draft: { text: '', images: [], audio: undefined }, textEnabled: true, imagesAllowed: true, canSubmit: true, canTalk: true, recording: false, busy: true } });
  return {
    wrapper,
    [Symbol.dispose]() {
      wrapper.unmount();
    },
  };
}

describe('dedicated live composer controls', () => {
  it('does not prevent plain Enter, and never bypasses a disabled submit via keyboard or form', async () => {
    using f = fixture();
    const text = f.wrapper.get('[data-testid="live-text"]');
    const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    text.element.dispatchEvent(enter);
    expect(enter.defaultPrevented).toBe(false);
    await f.wrapper.setProps({ canSubmit: false });
    const shortcut = new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true, cancelable: true });
    text.element.dispatchEvent(shortcut);
    expect(shortcut.defaultPrevented).toBe(true);
    await f.wrapper.get('form').trigger('submit');
    expect(f.wrapper.emitted('send')).toBeUndefined();
  });

  it('keeps editing enabled while the model responds and distinguishes queued send from interrupting talk', () => {
    using f = fixture();
    expect(f.wrapper.get('[data-testid="live-text"]').attributes('disabled')).toBeUndefined();
    expect(f.wrapper.get('[data-testid="live-send"]').attributes('title')).toBe('Send after the response');
    expect(f.wrapper.get('[data-testid="live-record"]').attributes('title')).toBe('Interrupt and talk');
  });

  it('uses Enter for newlines and Ctrl/Cmd+Enter for sending, except during composition', async () => {
    using f = fixture();
    const text = f.wrapper.get('[data-testid="live-text"]');
    await text.trigger('keydown', { key: 'Enter', isComposing: true });
    await text.trigger('keydown', { key: 'Enter', keyCode: 229 });
    await text.trigger('keydown', { key: 'Enter', shiftKey: true });
    expect(f.wrapper.emitted('send')).toBeUndefined();
    await text.trigger('keydown', { key: 'Enter' });
    expect(f.wrapper.emitted('send')).toBeUndefined();
    await text.trigger('keydown', { key: 'Enter', ctrlKey: true, isComposing: true });
    await text.trigger('keydown', { key: 'Enter', metaKey: true, keyCode: 229 });
    expect(f.wrapper.emitted('send')).toBeUndefined();
    await text.trigger('keydown', { key: 'Enter', ctrlKey: true });
    await text.trigger('keydown', { key: 'Enter', metaKey: true });
    expect(f.wrapper.emitted('send')).toHaveLength(2);
  });

  it('adds pasted images without swallowing accompanying plain text', () => {
    using f = fixture();
    const image = new File(['image'], 'clipboard.png', { type: 'image/png' });
    const makeEvent = ({ text }: { text: string }) => {
      const event = new Event('paste', { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'clipboardData', { value: { items: [{ type: 'image/png', getAsFile: () => image }], getData: () => text } });
      return event;
    };
    const onlyImage = makeEvent({ text: '' });
    f.wrapper.get('[data-testid="live-text"]').element.dispatchEvent(onlyImage);
    expect(onlyImage.defaultPrevented).toBe(true);
    const withText = makeEvent({ text: 'describe this' });
    f.wrapper.get('[data-testid="live-text"]').element.dispatchEvent(withText);
    expect(withText.defaultPrevented).toBe(false);
    expect(f.wrapper.emitted('attach')).toEqual([[[image]], [[image]]]);
  });

  it('keeps unavailable image actions visible, and prevents mixing file and microphone input accidentally', async () => {
    using f = fixture();
    await f.wrapper.setProps({ imagesAllowed: false, draft: { text: '', images: [], audio: { file: new File(['x'], 'a.wav', { type: 'audio/wav' }), url: 'blob:audio' } } });
    expect(f.wrapper.get('[data-testid="live-images"]').attributes('disabled')).toBeDefined();
    expect(f.wrapper.get('[data-testid="live-audio-file"]').attributes('disabled')).toBeUndefined();
    expect(f.wrapper.get('[data-testid="live-record"]').attributes('disabled')).toBeDefined();
    expect(f.wrapper.get('[data-testid="live-text"]').attributes('disabled')).toBeUndefined();
  });
});
