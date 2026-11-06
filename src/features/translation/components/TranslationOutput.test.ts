import { describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { nextTick } from 'vue';
import TranslationOutput from './TranslationOutput.vue';

async function fixture({ reducedMotion }: { reducedMotion: boolean }) {
  const frames = new Map<number, FrameRequestCallback>();
  let sequence = 0;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    const id = ++sequence;
    frames.set(id, callback);
    return id;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => {
    frames.delete(id);
  });
  vi.stubGlobal('matchMedia', () => ({ matches: reducedMotion, addEventListener() {}, removeEventListener() {} }));
  const original = Object.getOwnPropertyDescriptor(Range.prototype, 'getClientRects');
  Object.defineProperty(Range.prototype, 'getClientRects', {
    configurable: true,
    value: function (this: Range) {
      const element = this.startContainer;
      if (!(element instanceof HTMLElement)) {
        return [];
      }
      if (element.classList.contains('translation-output-front')) {
        return (element.textContent ?? '').split('\n').map((text, index) => new DOMRect(0, index * 28, text.length * 10, 18));
      }
      const before = Array.from(element.parentElement?.children ?? []).slice(0, Array.from(element.parentElement?.children ?? []).indexOf(element)).map(node => node.textContent).join('');
      const rows = before.split('\n');
      return [new DOMRect((rows.at(-1)?.length ?? 0) * 10, (rows.length - 1) * 28, (element.textContent ?? '').length * 10, 18)];
    },
  });
  const wrapper = mount(TranslationOutput, {
    props: {
      text: '',
      previousText: `\
ABCD
LONGER`,
      revision: 1,
      state: 'pending',
      label: 'Translation',
      placeholder: 'Result',
    },
  });
  await flushPromises();
  return {
    wrapper,
    frames,
    async frame({ time }: { time: number }) {
      const current = Array.from(frames.values());
      frames.clear();
      for (const callback of current) {
        callback(time);
      }
      await nextTick();
    },
    [Symbol.dispose]() {
      wrapper.unmount();
      if (original) {
        Object.defineProperty(Range.prototype, 'getClientRects', original);
      } else {
        Reflect.deleteProperty(Range.prototype, 'getClientRects');
      }
      vi.unstubAllGlobals();
    },
  };
}

describe('overlapping translation output', () => {
  it('keeps all previous text fully opaque while waiting, including old-only lines', async () => {
    using f = await fixture({ reducedMotion: false });
    await f.frame({ time: 0 });
    await f.frame({ time: 5000 });
    expect(f.wrapper.get('[data-testid="translation-previous-text"]').text()).toBe(`\
ABCD
LONGER`);
    expect(f.wrapper.findAll('.translation-old-fading')).toHaveLength(0);
    expect(f.wrapper.get('[data-testid="translation-previous-text"]').attributes('aria-hidden')).toBe('true');
    expect(f.wrapper.get('[data-testid="translation-current-text"]').text()).toBe('');
    expect(f.frames.size).toBe(0);
  });

  it('really overlaps text before fading only the covered old glyph, never an opaque foreground mask', async () => {
    using f = await fixture({ reducedMotion: false });
    await f.wrapper.setProps({ text: 'Z', state: 'streaming' });
    await f.frame({ time: 100 });
    expect(f.wrapper.get('[data-testid="translation-current-text"]').text()).toBe('Z');
    expect(f.wrapper.findAll('.translation-old-fading')).toHaveLength(0);
    await f.frame({ time: 164 });
    expect(f.wrapper.findAll('.translation-old-fading')).toHaveLength(0);
    await f.frame({ time: 165 });
    expect(f.wrapper.findAll('.translation-old-fading').map(node => node.text())).toEqual(['A']);
    expect(f.wrapper.get('[data-testid="translation-current-text"]').attributes('style')).toBeUndefined();
    await f.frame({ time: 1000 });
    expect(f.wrapper.findAll('.translation-old-fading')).toHaveLength(1);
  });

  it('waits for completion before fading the unmatched suffix and whole extra lines', async () => {
    using f = await fixture({ reducedMotion: false });
    await f.wrapper.setProps({ text: 'Z', state: 'streaming' });
    await f.frame({ time: 0 });
    await f.frame({ time: 65 });
    await f.wrapper.setProps({ state: 'settled' });
    await f.frame({ time: 200 });
    expect(f.wrapper.findAll('.translation-old-fading')).toHaveLength(11);
    expect(f.wrapper.find('[data-testid="translation-previous-text"]').exists()).toBe(true);
    await f.frame({ time: 331 });
    expect(f.wrapper.find('[data-testid="translation-previous-text"]').exists()).toBe(false);
    expect(f.wrapper.get('[data-testid="translation-current-text"]').text()).toBe('Z');
    expect(f.frames.size).toBe(0);
  });

  it('restores the last completed translation after a failed streamed replacement and never renders markup', async () => {
    using f = await fixture({ reducedMotion: false });
    await f.wrapper.setProps({ text: '<script>bad()</script>', state: 'streaming' });
    await f.frame({ time: 0 });
    await f.frame({ time: 100 });
    expect(f.wrapper.find('script').exists()).toBe(false);
    await f.wrapper.setProps({ text: '', state: 'failed' });
    await flushPromises();
    await f.frame({ time: 500 });
    expect(f.wrapper.findAll('.translation-old-fading')).toHaveLength(0);
    expect(f.wrapper.get('[data-testid="translation-previous-text"]').text()).toBe(`\
ABCD
LONGER`);
  });

  it('reuses the same completed-text DOM across edits while clearing obsolete fades', async () => {
    using f = await fixture({ reducedMotion: false });
    const back = f.wrapper.get('[data-testid="translation-previous-text"]').element;
    const first = f.wrapper.get('.translation-old-glyph').element;
    await f.wrapper.setProps({ text: 'Z', state: 'streaming' });
    await f.frame({ time: 0 });
    await f.frame({ time: 100 });
    expect(first.classList.contains('translation-old-fading')).toBe(true);
    await f.wrapper.setProps({ text: '', revision: 2, state: 'pending' });
    await f.frame({ time: 200 });
    expect(f.wrapper.get('[data-testid="translation-previous-text"]').element).toBe(back);
    expect(f.wrapper.get('.translation-old-glyph').element).toBe(first);
    expect(first.classList.contains('translation-old-fading')).toBe(false);
    await f.wrapper.setProps({ revision: 3 });
    expect(f.wrapper.get('.translation-old-glyph').element).toBe(first);
  });

  it('uses plain streaming on the first translation and clears private output on reset', async () => {
    using f = await fixture({ reducedMotion: false });
    await f.wrapper.setProps({ previousText: '', text: '初', revision: 2, state: 'streaming' });
    await f.frame({ time: 100 });
    expect(f.wrapper.find('[data-testid="translation-previous-text"]').exists()).toBe(false);
    expect(f.wrapper.get('[data-testid="translation-current-text"]').text()).toBe('初');
    await f.wrapper.setProps({ text: '', revision: 3, state: 'pending' });
    expect(f.wrapper.text()).toBe('Result');
  });

  it('honors reduced motion and cancels every queued frame on unmount', async () => {
    using f = await fixture({ reducedMotion: true });
    await f.wrapper.setProps({ text: 'Z', state: 'streaming' });
    await f.frame({ time: 0 });
    expect(f.wrapper.find('[data-testid="translation-previous-text"]').exists()).toBe(false);
    f.wrapper.unmount();
    expect(f.frames.size).toBe(0);
  });
});
