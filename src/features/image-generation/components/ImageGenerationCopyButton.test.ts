import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { ensureAllStringsForTest } from '@/strings/test-utils';
import ImageGenerationCopyButton from './ImageGenerationCopyButton.vue';
let wrapper: VueWrapper | undefined;
const descriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
const writeText = vi.fn();
beforeEach(async () => {
  await ensureAllStringsForTest({ locale: 'en' });
  writeText.mockReset().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
});
afterEach(() => {
  wrapper?.unmount(); wrapper = undefined; vi.useRealTimers();
  if (descriptor) Object.defineProperty(navigator, 'clipboard', descriptor);
  else Reflect.deleteProperty(navigator, 'clipboard');
});
function open({ text }: { text: string | undefined }) {
  wrapper = mount(ImageGenerationCopyButton, { props: { text, label: 'Copy prompt', showLabel: true }, attrs: { 'data-testid': 'copy-target' } });
  return wrapper;
}
describe('image prompt copying', () => {
  it('copies the complete Unicode text, whitespace and markup literally', async () => {
    const text = `  日本語🌃 <script>alert(1)</script>\n${'long prompt '.repeat(500)}  `;
    const surface = open({ text });
    await surface.get('[data-testid="copy-target"]').trigger('click'); await flushPromises();
    expect(writeText).toHaveBeenCalledExactlyOnceWith(text);
    expect(surface.get('[role="status"]').text()).toBe('Copied');
    expect(surface.find('script').exists()).toBe(false);
  });
  it.each([undefined, ''])('does not invoke clipboard for missing prompt %s', async text => {
    const surface = open({ text });
    expect(surface.get('button').attributes('disabled')).toBeDefined();
    await surface.get('button').trigger('click'); expect(writeText).not.toHaveBeenCalled();
  });
  it('reports a denied clipboard without claiming success and permits retry', async () => {
    writeText.mockRejectedValueOnce(new DOMException('denied', 'NotAllowedError'));
    const surface = open({ text: 'keep this prompt' });
    await surface.get('button').trigger('click'); await flushPromises();
    expect(surface.get('[role="status"]').text()).toContain('Could not copy');
    expect(surface.get('[role="status"]').text()).not.toBe('Copied');
    await surface.get('button').trigger('click'); await flushPromises();
    expect(surface.get('[role="status"]').text()).toBe('Copied');
  });
  it('handles an unavailable clipboard without an uncaught UI rejection', async () => {
    Reflect.deleteProperty(navigator, 'clipboard');
    const surface = open({ text: 'plain text' });
    await surface.get('button').trigger('click'); await flushPromises();
    expect(surface.text()).toContain('Could not copy');
  });
  it.each(['resolve', 'reject'] as const)('does not apply an old %s to a changed prompt', async settle => {
    const gate = Promise.withResolvers<void>(); writeText.mockReturnValueOnce(gate.promise);
    const surface = open({ text: 'old' });
    await surface.get('button').trigger('click'); await surface.setProps({ text: 'new' });
    switch (settle) {
    case 'resolve': gate.resolve(); break;
    case 'reject': gate.reject(new Error('old denial')); break;
    default: { const exhaustive: never = settle; throw new Error(String(exhaustive)); }
    }
    await flushPromises(); expect(surface.get('[role="status"]').text()).toBe('');
    await surface.get('button').trigger('click'); await flushPromises();
    expect(writeText).toHaveBeenLastCalledWith('new');
  });
  it('prevents a duplicate in-flight copy and resets the success hint', async () => {
    vi.useFakeTimers(); const gate = Promise.withResolvers<void>(); writeText.mockReturnValueOnce(gate.promise);
    const surface = open({ text: 'a' }); await surface.get('button').trigger('click'); await surface.get('button').trigger('click');
    expect(writeText).toHaveBeenCalledOnce(); gate.resolve(); await flushPromises();
    expect(surface.text()).toContain('Copied'); await vi.advanceTimersByTimeAsync(1800);
    expect(surface.get('[role="status"]').text()).toBe('');
  });
  it('ignores a completion after unmount', async () => {
    const gate = Promise.withResolvers<void>(); writeText.mockReturnValueOnce(gate.promise);
    const surface = open({ text: 'a' }); await surface.get('button').trigger('click'); surface.unmount(); wrapper = undefined;
    gate.reject(new Error('late denial')); await flushPromises();
    expect(writeText).toHaveBeenCalledOnce();
  });
});
