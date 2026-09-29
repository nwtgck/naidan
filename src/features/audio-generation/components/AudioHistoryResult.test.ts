import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils';
import { ensureAllStringsForTest } from '@/strings/test-utils';
import { captureAudioSettings, type AudioHistoryEntry } from '@/features/audio-generation/composables/useAudioHistory';
import { defaultAudioParameters } from '@/features/audio-generation/types';
import { audioResult } from '@/features/audio-generation/test-utils/wav';
import AudioHistoryResult from './AudioHistoryResult.vue';
const text = '  First line\n日本語のテキスト。\nSecond line\twith spacing.  ';
function entry(): AudioHistoryEntry {
  const { wav, ...result } = audioResult();
  return { id: 1, url: 'blob:history', createdAt: 1, bytes: wav.byteLength, result,
    settings: captureAudioSettings({ input: { ...defaultAudioParameters(), text, model: 'voice', options: { profile: 'auto' }, debug: 'off' }, modelName: 'Voice' }) };
}
let wrapper: VueWrapper | undefined;
const copy = vi.fn<(text: string) => Promise<void>>();
beforeEach(async () => {
  await ensureAllStringsForTest({ locale: 'en' }); copy.mockReset(); copy.mockResolvedValue();
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {});
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: copy } });
});
afterEach(() => {
  wrapper?.unmount(); wrapper = undefined;
  Reflect.deleteProperty(navigator, 'clipboard'); window.getSelection()?.removeAllRanges(); document.body.innerHTML = ''; vi.restoreAllMocks();
});
describe('compact history controls', () => {
  it('keeps the preview and player/save row outside the collapsed settings', () => {
    wrapper = mount(AudioHistoryResult, { props: { entry: entry() } });
    const details = wrapper.get<HTMLDetailsElement>('[data-testid="audio-result-settings"]');
    expect(details.element.open).toBe(false);
    expect(wrapper.get('[data-testid="audio-result-preview"]').element.closest('details')).toBeNull();
    expect(wrapper.get('[data-testid="audio-result-preview"]').element.textContent).toBe(text);
    const actions = wrapper.get('[data-testid="audio-playback-actions"]');
    expect(actions.find('[data-testid="audio-player"]').exists()).toBe(true);
    expect(actions.find('[data-testid="audio-download"]').exists()).toBe(true);
    expect(actions.get('[data-testid="audio-download"]').attributes('aria-label')).toBeTruthy();
  });
  it('copies the original text including whitespace without changing the result', async () => {
    wrapper = mount(AudioHistoryResult, { props: { entry: entry() } });
    await wrapper.get('[data-testid="audio-copy-text"]').trigger('click'); await flushPromises();
    expect(copy).toHaveBeenCalledExactlyOnceWith(text);
    expect(wrapper.get('[data-testid="audio-copy-text"]').text()).toContain('copied');
    expect(wrapper.get('[data-testid="audio-result-text"]').element.textContent).toBe(text);
    expect(wrapper.emitted('remove')).toBeUndefined();
  });
  it.each(['denied', 'unavailable'])('offers a selected-text fallback when clipboard is %s', async reason => {
    if (reason === 'denied') copy.mockRejectedValueOnce(new Error('denied'));
    else Reflect.deleteProperty(navigator, 'clipboard');
    wrapper = mount(AudioHistoryResult, { props: { entry: entry() }, attachTo: document.body });
    await wrapper.get('[data-testid="audio-copy-text"]').trigger('click'); await flushPromises();
    expect(wrapper.get('[data-testid="audio-copy-error"]').attributes('role')).toBe('status');
    expect(window.getSelection()?.toString()).toBe(text);
    expect(document.activeElement).toBe(wrapper.get('[data-testid="audio-result-text"]').element);
    expect(wrapper.get('[data-testid="audio-copy-text"]').attributes('disabled')).toBeUndefined();
  });
  it('does not select another page or update state when a delayed copy fails after deletion', async () => {
    const gate = Promise.withResolvers<void>(); copy.mockReturnValueOnce(gate.promise);
    wrapper = mount(AudioHistoryResult, { props: { entry: entry() }, attachTo: document.body });
    await wrapper.get('[data-testid="audio-copy-text"]').trigger('click');
    expect(wrapper.get('[data-testid="audio-copy-text"]').attributes('disabled')).toBeDefined();
    wrapper.unmount(); wrapper = undefined; gate.reject(new Error('late')); await flushPromises();
    expect(window.getSelection()?.toString()).toBe('');
    expect(HTMLMediaElement.prototype.pause).toHaveBeenCalledOnce();
  });
});
