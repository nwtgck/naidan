import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, nextTick } from 'vue';
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils';
import { ensureAllStringsForTest } from '@/strings/test-utils';
import type { LlamaCppBrowserService } from '@/features/llama-cpp-browser/service-contract';
import type { EngineState } from '@/features/llama-cpp-browser/types';
import { LlamaCppBrowserError } from '@/features/llama-cpp-browser/types';
import { audioResult } from './test-utils/wav';
import AudioGenerationView from './AudioGenerationView.vue';

const service = vi.hoisted(() => ({
  getState: vi.fn<LlamaCppBrowserService['getState']>(), getOptions: vi.fn<LlamaCppBrowserService['getOptions']>(),
  subscribe: vi.fn<LlamaCppBrowserService['subscribe']>(), generateAudio: vi.fn<LlamaCppBrowserService['generateAudio']>(),
  cancel: vi.fn(), release: vi.fn(), setOptions: vi.fn(), unsubscribe: vi.fn(),
}));
vi.mock('@/features/llama-cpp-browser', () => ({ llamaCppBrowserService: service }));
vi.mock('@/features/llama-cpp-browser/components/LlamaCppBrowserManager.vue', () => ({ default: defineComponent({
  name: 'LlamaCppBrowserManager', props: ['suggestions'], emits: ['modelsChanged', 'modelSelected', 'runtimeReady'], template: '<div />',
}) }));
const urls = { create: vi.fn(), revoke: vi.fn() };
let wrapper: VueWrapper | undefined;
beforeEach(async () => {
  vi.resetAllMocks();
  service.getState.mockReturnValue({ status: 'idle' }); service.getOptions.mockReturnValue({ profile: 'cpu-wasm32' });
  service.subscribe.mockReturnValue(service.unsubscribe); service.generateAudio.mockResolvedValue(audioResult());
  urls.create.mockReturnValue('blob:generated-audio');
  vi.stubGlobal('URL', class extends URL {
    static override createObjectURL = urls.create; static override revokeObjectURL = urls.revoke;
  });
  await ensureAllStringsForTest({ locale: 'en' });
});
afterEach(() => {
  wrapper?.unmount(); wrapper = undefined; vi.unstubAllGlobals();
});
async function ready(): Promise<VueWrapper> {
  wrapper = mount(AudioGenerationView);
  const manager = wrapper.findComponent({ name: 'LlamaCppBrowserManager' });
  manager.vm.$emit('modelsChanged', [{ id: 'user/voice', name: 'Voice', size: 100, importedAt: 1 }]);
  manager.vm.$emit('runtimeReady', true); manager.vm.$emit('modelSelected', 'Voice');
  await nextTick(); await wrapper.get('[data-testid="audio-text"]').setValue('Hello');
  return wrapper;
}
async function submit({ view }: { view: VueWrapper }): Promise<void> {
  await view.get('form').trigger('submit'); await flushPromises();
}
function notify({ state }: { state: EngineState }): void {
  service.subscribe.mock.calls[0]?.[0].listener({ state });
}
describe('independent audio generation screen', () => {
  it('does not generate on mount and hides chat suggestions without changing chat options', async () => {
    const view = await ready();
    expect(view.findComponent({ name: 'LlamaCppBrowserManager' }).props('suggestions')).toBe('none');
    expect(service.generateAudio).not.toHaveBeenCalled(); expect(service.setOptions).not.toHaveBeenCalled();
    expect(view.get<HTMLSelectElement>('[data-testid="audio-model"]').element.value).toBe('user/voice');
  });
  it('uses the local model ID and emits a downloadable WAV without autoplay', async () => {
    const view = await ready(); await view.get('[data-testid="audio-language"]').setValue('ja'); await submit({ view });
    expect(service.generateAudio).toHaveBeenCalledOnce();
    expect(service.generateAudio.mock.calls[0]?.[0].input).toMatchObject({ model: 'user/voice', text: 'Hello', language: 'ja', audioBackend: 'cpu', contextTokens: 4096, debug: 'off' });
    expect(service.generateAudio.mock.calls[0]?.[0].input).not.toHaveProperty('messages');
    const player = view.get('[data-testid="audio-player"]'); expect(player.attributes('src')).toBe('blob:generated-audio');
    expect(player.attributes()).not.toHaveProperty('autoplay');
    expect(view.get('[data-testid="audio-download"]').attributes('download')).toBe('naidan-audio.wav');
    expect(urls.create.mock.calls[0]?.[0]).toBeInstanceOf(Blob);
    expect((urls.create.mock.calls[0]?.[0] as Blob).type).toBe('audio/wav');
    expect(view.find('[data-testid="audio-truncated"]').exists()).toBe(false);
  });
  it.each(['frame-limit', 'context-limit'] as const)('labels truncated output: %s', async finishReason => {
    service.generateAudio.mockResolvedValueOnce({ ...audioResult(), finishReason });
    const view = await ready(); await submit({ view }); expect(view.get('[data-testid="audio-truncated"]').text()).not.toBe('');
  });
  it('does not submit invalid values even when HTML validation is bypassed', async () => {
    const view = await ready(); await view.get('[data-testid="audio-context"]').setValue('1'); await submit({ view });
    expect(service.generateAudio).not.toHaveBeenCalled(); expect(view.find('[data-testid="audio-error"]').exists()).toBe(true);
  });
  it('waits for runtime availability and avoids starting alongside another active operation', async () => {
    const view = await ready(); const manager = view.findComponent({ name: 'LlamaCppBrowserManager' });
    manager.vm.$emit('runtimeReady', false); await nextTick(); await submit({ view }); expect(service.generateAudio).not.toHaveBeenCalled();
    manager.vm.$emit('runtimeReady', true); notify({ state: { status: 'working', progress: { phase: 'generating', completed: 1, total: 10 } } });
    await nextTick(); await submit({ view }); expect(service.generateAudio).not.toHaveBeenCalled();
  });
  it('clears a selection whose model was removed', async () => {
    const view = await ready(); view.findComponent({ name: 'LlamaCppBrowserManager' }).vm.$emit('modelsChanged', []);
    await nextTick(); await submit({ view }); expect(service.generateAudio).not.toHaveBeenCalled();
  });
  it('accepts a reference and lets the user clear it without retaining it elsewhere', async () => {
    const view = await ready(); const input = view.get<HTMLInputElement>('[data-testid="audio-reference"]'); const file = new File(['reference'], 'speaker.wav');
    Object.defineProperty(input.element, 'files', { configurable: true, value: [file] }); await input.trigger('change');
    await submit({ view }); expect(service.generateAudio.mock.calls[0]?.[0].input.reference).toBe(file);
    await view.get('[data-testid="audio-clear-reference"]').trigger('click'); await submit({ view });
    expect(service.generateAudio.mock.calls[1]?.[0].input.reference).toBeUndefined();
  });
  it('rejects stale success after Stop and aborts only its own request', async () => {
    const pending = Promise.withResolvers<ReturnType<typeof audioResult>>(); service.generateAudio.mockReturnValueOnce(pending.promise);
    const view = await ready(); await submit({ view }); await view.get('[data-testid="audio-stop"]').trigger('click');
    expect(service.generateAudio.mock.calls[0]?.[0].signal?.aborted).toBe(true); expect(service.cancel).not.toHaveBeenCalled(); expect(service.release).not.toHaveBeenCalled();
    pending.resolve(audioResult()); await flushPromises();
    expect(urls.create).not.toHaveBeenCalled(); expect(view.find('[data-testid="audio-stopped"]').exists()).toBe(true);
  });
  it('aborts on navigation and ignores a success arriving after unmount', async () => {
    const pending = Promise.withResolvers<ReturnType<typeof audioResult>>(); service.generateAudio.mockReturnValueOnce(pending.promise);
    const view = await ready(); await submit({ view }); view.unmount(); wrapper = undefined;
    expect(service.generateAudio.mock.calls[0]?.[0].signal?.aborted).toBe(true); expect(service.unsubscribe).toHaveBeenCalledOnce();
    pending.resolve(audioResult()); await flushPromises(); expect(urls.create).not.toHaveBeenCalled();
  });
  it('revokes output URLs on replacement and unmount', async () => {
    const view = await ready(); await submit({ view }); await submit({ view });
    expect(urls.revoke).toHaveBeenCalledExactlyOnceWith('blob:generated-audio'); view.unmount(); wrapper = undefined;
    expect(urls.revoke).toHaveBeenCalledTimes(2);
  });
  it.each(['audio-model-unsupported', 'audio-reference-required', 'audio-reference-invalid', 'audio-output-empty', 'context-full'] as const)('shows a specific failure without producing audio: %s', async code => {
    service.generateAudio.mockRejectedValueOnce(new LlamaCppBrowserError({ code })); const view = await ready(); await submit({ view });
    expect(view.get('[data-testid="audio-error"]').text()).toContain(code); expect(urls.create).not.toHaveBeenCalled();
  });
  it('rejects malformed WAV bytes even when the transport metadata is valid', async () => {
    const result = audioResult(); result.wav[0] = 0; service.generateAudio.mockResolvedValueOnce(result);
    const view = await ready(); await submit({ view }); expect(view.find('[data-testid="audio-error"]').exists()).toBe(true); expect(urls.create).not.toHaveBeenCalled();
  });
});

it('distinguishes waveform decoding from frame generation without a misleading percent complete', async () => {
  const pending = Promise.withResolvers<ReturnType<typeof audioResult>>(); service.generateAudio.mockReturnValueOnce(pending.promise);
  const view = await ready(); await submit({ view });
  notify({ state: { status: 'working', progress: { phase: 'decoding-audio', completed: 0, total: 0 } } }); await nextTick();
  expect(view.get('[data-testid="audio-progress"]').text()).toContain('Decoding');
  expect(view.get('[data-testid="audio-progress"]').text()).not.toContain('%');
  pending.resolve(audioResult()); await flushPromises();
});
