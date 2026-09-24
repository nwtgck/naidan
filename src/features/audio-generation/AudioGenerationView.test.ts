import LlamaCppBrowserModelSuggestions from '@/features/llama-cpp-browser/components/LlamaCppBrowserModelSuggestions.vue';
import { audioModelCatalog } from './model-catalog';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, nextTick, ref } from 'vue';
import ModelSelector from '@/components/ModelSelector.vue';
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils';
import { setLocale } from '@/strings';
import { ensureAllStringsForTest } from '@/strings/test-utils';
import type { LlamaCppBrowserService } from '@/features/llama-cpp-browser/service-contract';
import type { EngineState } from '@/features/llama-cpp-browser/types';
import { LlamaCppBrowserError } from '@/features/llama-cpp-browser/types';
import { audioResult } from './test-utils/wav';
import AudioGenerationView from './AudioGenerationView.vue';
import * as referencePreparation from './reference-audio';
import type { inspectStoredAudioModel } from './model-detection';
vi.mock('@/composables/useSettings', () => ({ useSettings: () => ({ availableModels: ref([]), isFetchingModels: ref(false), fetchModels: vi.fn() }) }));
const detection = vi.hoisted(() => ({ inspect: vi.fn<typeof inspectStoredAudioModel>() }));
vi.mock('./model-detection', async importOriginal => ({ ...await importOriginal<typeof import('./model-detection')>(), inspectStoredAudioModel: detection.inspect }));

const service = vi.hoisted(() => ({
  getState: vi.fn<LlamaCppBrowserService['getState']>(), getOptions: vi.fn<LlamaCppBrowserService['getOptions']>(),
  subscribe: vi.fn<LlamaCppBrowserService['subscribe']>(), generateAudio: vi.fn<LlamaCppBrowserService['generateAudio']>(),
  restartRuntime: vi.fn<LlamaCppBrowserService['restartRuntime']>(), cancel: vi.fn(), release: vi.fn(), setOptions: vi.fn(), unsubscribe: vi.fn(),
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
  service.restartRuntime.mockResolvedValue({ recommended: 'cpu-wasm32', profiles: [{ profile: 'cpu-wasm32', status: 'available' }] });
  service.subscribe.mockReturnValue(service.unsubscribe); service.generateAudio.mockResolvedValue(audioResult());
  urls.create.mockReturnValue('blob:generated-audio');
  detection.inspect.mockResolvedValue({ status: 'detected', pipeline: 'qwen3-tts', reference: 'optional' });
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {});
  vi.stubGlobal('URL', class extends URL {
    static override createObjectURL = urls.create; static override revokeObjectURL = urls.revoke;
  });
  await ensureAllStringsForTest({ locale: 'en' });
});
afterEach(() => {
  wrapper?.unmount(); wrapper = undefined; vi.restoreAllMocks(); vi.unstubAllGlobals();
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
    expect(view.findComponent(ModelSelector).props('modelValue')).toBe('user/voice');
  });
  it('starts with the interface language and displays localized/native names', async () => {
    await ensureAllStringsForTest({ locale: 'ja' });
    const view = await ready();
    const select = view.get<HTMLSelectElement>('[data-testid="audio-language"]');
    expect(select.element.value).toBe('ja');
    expect(view.get('option[value="en"]').text()).toBe('英語 (English)');
    expect(view.get('option[value="ja"]').text()).toBe('日本語');
    expect(view.get('option[value="zh"]').text()).toBe('中国語 (中文)');
  });
  it('updates labels after a real interface locale switch without overwriting the speech selection', async () => {
    const view = await ready(); await view.get('[data-testid="audio-language"]').setValue('de');
    await setLocale({ locale: 'ja' }); await flushPromises();
    expect(view.get('option[value="en"]').text()).toBe('英語 (English)');
    expect(view.get<HTMLSelectElement>('[data-testid="audio-language"]').element.value).toBe('de');
  });
  it('offers manual language and model default without advertising the removed downstream auto feature', async () => {
    const view = await ready();
    const select = view.get('[data-testid="audio-language"]');
    expect(select.find('option[value="auto"]').exists()).toBe(false);
    expect(select.find('option[value="default"]').exists()).toBe(true);
    expect(select.findAll('option')).toHaveLength(11);
    expect(view.find('[data-testid="audio-auto-unavailable"]').exists()).toBe(false);
    await select.setValue('default'); await submit({ view });
    expect(service.generateAudio.mock.calls[0]?.[0].input.language).toBe('default');
  });
  it('shows a field error for a stale auto value instead of submitting it or falling back', async () => {
    const view = await ready(); const select = view.get<HTMLSelectElement>('[data-testid="audio-language"]');
    // Emulate a stale/different caller that can supply a no-longer-offered value.
    select.element.add(new Option('Retired automatic language', 'auto'));
    await select.setValue('auto'); await submit({ view });
    expect(service.generateAudio).not.toHaveBeenCalled();
    expect(view.get('[data-testid="audio-error"]').text()).toContain('Language');
    expect(select.attributes('aria-invalid')).toBe('true');
    expect(select.element.value).toBe('auto');
  });
  it('renders separate feature-scoped scrolling containers', async () => {
    const view = await ready();
    expect(view.get('[data-testid="audio-generation-scroll"]').find('[data-testid="audio-generation-page"]').exists()).toBe(true);
    expect(view.get('[data-testid="audio-model-manager"]').find('[data-testid="audio-model-manager-scroll"]').exists()).toBe(true);
  });
  it('reveals invalid fields hidden inside advanced details instead of relying on browser form validation', async () => {
    const view = await ready();
    expect(view.get<HTMLFormElement>('form').element.noValidate).toBe(true);
    const context = view.get<HTMLInputElement>('[data-testid="audio-context"]');
    const details = context.element.closest('details')!;
    expect(details.open).toBe(false);
    await context.setValue('1'); await submit({ view });
    expect(details.open).toBe(true);
    expect(context.attributes('aria-invalid')).toBe('true');
    expect(view.get('[data-testid="audio-error"]').text()).toContain('1024');
    expect(service.generateAudio).not.toHaveBeenCalled();
  });
  it('reports empty text in the page and removes old validation errors on a successful retry', async () => {
    const view = await ready(); await view.get('[data-testid="audio-text"]').setValue('   '); await submit({ view });
    expect(service.generateAudio).not.toHaveBeenCalled();
    expect(view.get('[data-testid="audio-error"]').text()).toContain('text');
    await view.get('[data-testid="audio-text"]').setValue('Hello'); await submit({ view });
    expect(service.generateAudio).toHaveBeenCalledOnce(); expect(view.find('[data-testid="audio-error"]').exists()).toBe(false);
  });
  it('accepts context requests above the old 8192 UI limit', async () => {
    const view = await ready(); const context = view.get('[data-testid="audio-context"]');
    expect(context.attributes('max')).not.toBe('8192');
    await context.setValue('32768'); await submit({ view });
    expect(service.generateAudio.mock.calls[0]?.[0].input.contextTokens).toBe(32768);
  });
  it('uses the local model ID and emits a downloadable WAV without autoplay', async () => {
    const view = await ready(); await view.get('[data-testid="audio-language"]').setValue('ja'); await submit({ view });
    expect(service.generateAudio).toHaveBeenCalledOnce();
    expect(service.generateAudio.mock.calls[0]?.[0].input).toMatchObject({ model: 'user/voice', text: 'Hello', language: 'ja', audioBackend: 'profile', contextTokens: 4096, debug: 'off' });
    expect(service.generateAudio.mock.calls[0]?.[0].input).not.toHaveProperty('messages');
    const player = view.get('[data-testid="audio-player"]'); expect(player.attributes('src')).toBe('blob:generated-audio');
    expect(player.attributes()).not.toHaveProperty('autoplay');
    expect(view.get('[data-testid="audio-download"]').attributes('download')).toBe('naidan-audio-1.wav');
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
    expect(service.generateAudio.mock.calls[0]?.[0].cancellationSignal?.aborted).toBe(true); expect(service.cancel).not.toHaveBeenCalled(); expect(service.release).not.toHaveBeenCalled();
    pending.resolve(audioResult()); await flushPromises();
    expect(urls.create).not.toHaveBeenCalled(); expect(view.find('[data-testid="audio-stopped"]').exists()).toBe(true);
  });
  it('aborts on navigation and ignores a success arriving after unmount', async () => {
    const pending = Promise.withResolvers<ReturnType<typeof audioResult>>(); service.generateAudio.mockReturnValueOnce(pending.promise);
    const view = await ready(); await submit({ view }); view.unmount(); wrapper = undefined;
    expect(service.generateAudio.mock.calls[0]?.[0].cancellationSignal?.aborted).toBe(true); expect(service.unsubscribe).toHaveBeenCalledOnce();
    pending.resolve(audioResult()); await flushPromises(); expect(urls.create).not.toHaveBeenCalled();
  });
  it('retains previous output URLs on new generation and revokes all on unmount', async () => {
    const view = await ready(); await submit({ view }); await submit({ view });
    expect(urls.revoke).not.toHaveBeenCalled(); expect(view.findAll('[data-testid="audio-result"]')).toHaveLength(2); view.unmount(); wrapper = undefined;
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


describe('audio candidates and in-memory history in the view', () => {
  it('selects a metadata-detected model and offers the all-models override', async () => {
    detection.inspect.mockImplementation(async ({ id }) => id === 'user/chat'
      ? { status: 'unverified', reason: 'architecture' } : { status: 'detected', pipeline: 'qwen3-tts', reference: 'optional' });
    wrapper = mount(AudioGenerationView); const manager = wrapper.findComponent({ name: 'LlamaCppBrowserManager' });
    manager.vm.$emit('modelsChanged', [{ id: 'user/chat', name: 'Chat', size: 10, importedAt: 1 }, { id: 'user/voice', name: 'Voice', size: 100, importedAt: 1 }]);
    manager.vm.$emit('runtimeReady', true); await flushPromises();
    const select = wrapper.findComponent(ModelSelector);
    expect(select.props('modelValue')).toBe('user/voice'); expect(select.props('models')).toEqual(['user/voice']);
    await wrapper.get('[data-testid="audio-all-models"]').setValue(true);
    expect(select.props('models')).toEqual(['user/chat', 'user/voice']); select.vm.$emit('update:modelValue', 'user/chat'); await nextTick();
    await wrapper.get('[data-testid="audio-text"]').setValue('Unknown candidate'); await submit({ view: wrapper });
    expect(service.generateAudio.mock.calls[0]![0].input.model).toBe('user/chat');
  });
  it('keeps the escape hatch accessible when no metadata can be read', async () => {
    detection.inspect.mockRejectedValue(new Error('storage temporarily unavailable'));
    wrapper = mount(AudioGenerationView); const manager = wrapper.findComponent({ name: 'LlamaCppBrowserManager' });
    manager.vm.$emit('modelsChanged', [{ id: 'user/model', name: 'Model', size: 100, importedAt: 1 }]); await flushPromises();
    expect(wrapper.findComponent(ModelSelector).props('modelValue')).toBeUndefined();
    await wrapper.get('[data-testid="audio-show-all"]').trigger('click');
    wrapper.findComponent(ModelSelector).vm.$emit('update:modelValue', 'user/model'); await nextTick();
    expect(wrapper.findComponent(ModelSelector).props('modelValue')).toBe('user/model');
  });
  it('retains old audio during a pending generation, a failed attempt and invalid input', async () => {
    const view = await ready(); await submit({ view }); const pending = Promise.withResolvers<ReturnType<typeof audioResult>>();
    service.generateAudio.mockReturnValueOnce(pending.promise); await submit({ view });
    expect(view.findAll('[data-testid="audio-result"]')).toHaveLength(1); expect(urls.revoke).not.toHaveBeenCalled();
    pending.reject(new Error('failure')); await flushPromises(); expect(view.findAll('[data-testid="audio-result"]')).toHaveLength(1);
    await view.get('[data-testid="audio-text"]').setValue(''); await submit({ view });
    expect(view.findAll('[data-testid="audio-result"]')).toHaveLength(1); expect(urls.revoke).not.toHaveBeenCalled();
  });
  it('captures settings at submit rather than from the subsequently edited form', async () => {
    const view = await ready(); const pending = Promise.withResolvers<ReturnType<typeof audioResult>>(); service.generateAudio.mockReturnValueOnce(pending.promise);
    service.getOptions.mockReturnValue({ profile: 'auto' }); await view.get('[data-testid="audio-language"]').setValue('ja');
    await submit({ view });
    // Programmatic events can mutate a disabled input; delayed completion must
    // still use the submission snapshot, not the current reactive values.
    await view.get('[data-testid="audio-text"]').setValue('Changed after submit');
    await view.get('[data-testid="audio-language"]').setValue('de');
    pending.resolve(audioResult()); await flushPromises();
    expect(view.get('[data-testid="audio-result-text"]').text()).toBe('Hello');
    expect(view.get('[data-testid="audio-result-language"]').text()).toContain('Japanese');
    expect(view.get('[data-testid="audio-result-settings"]').text()).toContain('4096');
    expect(view.get('[data-testid="audio-result-settings"]').text()).toContain('1024');
    expect(view.get('[data-testid="audio-result-settings"]').text()).toContain('Random');
    await view.get('[data-testid="audio-text"]').setValue('Second text'); await submit({ view });
    expect(view.findAll('[data-testid="audio-result-text"]').map(e => e.text())).toEqual(['Second text', 'Hello']);
  });
  it('deletes one result or all results, stops players and permits deletion during generation', async () => {
    urls.create.mockReturnValueOnce('blob:first').mockReturnValueOnce('blob:second').mockReturnValueOnce('blob:third');
    const view = await ready(); await submit({ view }); await submit({ view });
    await view.findAll('[data-testid="audio-delete"]')[1]!.trigger('click');
    expect(view.findAll('[data-testid="audio-result"]')).toHaveLength(1); expect(urls.revoke).toHaveBeenCalledWith('blob:first');
    expect(HTMLMediaElement.prototype.pause).toHaveBeenCalled(); expect(HTMLMediaElement.prototype.load).toHaveBeenCalled();
    const pending = Promise.withResolvers<ReturnType<typeof audioResult>>(); service.generateAudio.mockReturnValueOnce(pending.promise); await submit({ view });
    await view.get('[data-testid="audio-delete-all"]').trigger('click');
    expect(view.find('[data-testid="audio-history"]').exists()).toBe(false);
    pending.resolve(audioResult()); await flushPromises(); expect(view.findAll('[data-testid="audio-result"]')).toHaveLength(1);
    expect(view.get('[data-testid="audio-player"]').attributes('src')).toBe('blob:third');
  });
  it('does not clear completed history when a later generation is stopped', async () => {
    const view = await ready(); await submit({ view }); const pending = Promise.withResolvers<ReturnType<typeof audioResult>>();
    service.generateAudio.mockReturnValueOnce(pending.promise); await submit({ view }); await view.get('[data-testid="audio-stop"]').trigger('click');
    pending.resolve(audioResult()); await flushPromises();
    expect(view.findAll('[data-testid="audio-result"]')).toHaveLength(1); expect(urls.create).toHaveBeenCalledOnce();
  });
  it('uses the larger step cap without changing context default or retaining obsolete wording', async () => {
    const view = await ready();
    expect(view.get<HTMLInputElement>('[data-testid="audio-max-frames"]').element.value).toBe('1024');
    expect(view.get<HTMLInputElement>('[data-testid="audio-context"]').element.value).toBe('4096');
    await setLocale({ locale: 'ja' }); await flushPromises();
    expect(view.text()).not.toContain('8192は全モデル共通の上限ではありません');
  });
});


describe('non-destructive runtime recovery in the audio workspace', () => {
  it('re-enables generation after a failed runtime is checked again without losing results or input', async () => {
    const view = await ready(); await submit({ view });
    service.generateAudio.mockRejectedValueOnce(new LlamaCppBrowserError({ code: 'worker-failed' }));
    await submit({ view });
    const manager = view.findComponent({ name: 'LlamaCppBrowserManager' });
    manager.vm.$emit('runtimeReady', false); notify({ state: { status: 'error', code: 'worker-failed' } }); await nextTick();
    expect(view.get('[data-testid="audio-generate"]').attributes('disabled')).toBeDefined();
    const pending = Promise.withResolvers<Awaited<ReturnType<LlamaCppBrowserService['restartRuntime']>>>();
    service.restartRuntime.mockReturnValueOnce(pending.promise);
    await view.get('[data-testid="audio-restart-runtime"]').trigger('click');
    expect(view.get('[data-testid="audio-restart-runtime"]').attributes('disabled')).toBeDefined();
    expect(view.findAll('[data-testid="audio-result"]')).toHaveLength(1);
    pending.resolve({ recommended: 'cpu-wasm32', profiles: [{ profile: 'cpu-wasm32', status: 'available' }] });
    manager.vm.$emit('runtimeReady', true); notify({ state: { status: 'idle' } }); await flushPromises();
    expect(view.get('[data-testid="audio-generate"]').attributes('disabled')).toBeUndefined();
    expect(view.get<HTMLTextAreaElement>('[data-testid="audio-text"]').element.value).toBe('Hello');
    expect(view.find('[data-testid="audio-error"]').exists()).toBe(false);
    expect(service.generateAudio).toHaveBeenCalledTimes(2); expect(urls.revoke).not.toHaveBeenCalled();
    await submit({ view }); expect(view.findAll('[data-testid="audio-result"]')).toHaveLength(2);
  });
  it('keeps reinitialization failures visible and allows another explicit attempt', async () => {
    const view = await ready(); service.restartRuntime.mockRejectedValueOnce(new LlamaCppBrowserError({ code: 'unavailable' }));
    await view.get('[data-testid="audio-restart-runtime"]').trigger('click'); await flushPromises();
    expect(view.get('[data-testid="audio-error"]').text()).toContain('unavailable');
    expect(view.get('[data-testid="audio-restart-runtime"]').attributes('disabled')).toBeUndefined();
    await view.get('[data-testid="audio-restart-runtime"]').trigger('click'); await flushPromises();
    expect(service.restartRuntime).toHaveBeenCalledTimes(2);
  });
  it('does not restart while another operation is working', async () => {
    const view = await ready();
    notify({ state: { status: 'working', progress: { phase: 'generating', completed: 1, total: 2 } } }); await nextTick();
    await view.get('[data-testid="audio-restart-runtime"]').trigger('click');
    expect(service.restartRuntime).not.toHaveBeenCalled(); expect(service.release).not.toHaveBeenCalled();
  });
  it('detaches only its recovery observer when the route is left', async () => {
    const view = await ready(); const pending = Promise.withResolvers<Awaited<ReturnType<LlamaCppBrowserService['restartRuntime']>>>();
    service.restartRuntime.mockReturnValueOnce(pending.promise);
    await view.get('[data-testid="audio-restart-runtime"]').trigger('click'); view.unmount(); wrapper = undefined;
    expect(service.restartRuntime.mock.calls[0]![0].signal?.aborted).toBe(true);
    expect(service.release).not.toHaveBeenCalled(); expect(service.cancel).not.toHaveBeenCalled();
    pending.reject(new Error('late recovery failure')); await flushPromises();
  });
});


describe('finish partial audio without discarding history', () => {
  it('enables finishing only after a frame and records the partial result with original settings', async () => {
    const view = await ready(); await submit({ view });
    const gate = Promise.withResolvers<ReturnType<typeof audioResult>>(); service.generateAudio.mockReturnValueOnce(gate.promise);
    await submit({ view }); expect(view.get<HTMLButtonElement>('[data-testid="audio-finish"]').element.disabled).toBe(true);
    notify({ state: { status: 'working', progress: { phase: 'generating', completed: 1, total: 1024 } } }); await nextTick();
    expect(view.get<HTMLButtonElement>('[data-testid="audio-finish"]').element.disabled).toBe(false);
    await view.get('[data-testid="audio-finish"]').trigger('click');
    const args = service.generateAudio.mock.calls[1]![0]; expect(args.completionSignal?.aborted).toBe(true); expect(args.cancellationSignal?.aborted).toBe(false);
    expect(view.get<HTMLButtonElement>('[data-testid="audio-finish"]').element.disabled).toBe(true);
    notify({ state: { status: 'working', progress: { phase: 'decoding-audio', completed: 0, total: 0 } } }); await nextTick();
    expect(view.get<HTMLButtonElement>('[data-testid="audio-stop"]').element.disabled).toBe(false);
    gate.resolve({ ...audioResult(), finishReason: 'user-stop' }); await flushPromises();
    expect(view.findAll('[data-testid="audio-player"]')).toHaveLength(2);
    expect(view.findAll('[data-testid="audio-finished-early"]')).toHaveLength(1);
    expect(view.findAll('[data-testid="audio-truncated"]')).toHaveLength(0);
  });
  it('keeps the older result and discards the pending one when cancelled after finish', async () => {
    const view = await ready(); await submit({ view }); const gate = Promise.withResolvers<ReturnType<typeof audioResult>>(); service.generateAudio.mockReturnValueOnce(gate.promise);
    await submit({ view }); notify({ state: { status: 'working', progress: { phase: 'generating', completed: 1, total: 1024 } } }); await nextTick();
    await view.get('[data-testid="audio-finish"]').trigger('click'); await view.get('[data-testid="audio-stop"]').trigger('click');
    gate.resolve({ ...audioResult(), finishReason: 'user-stop' }); await flushPromises();
    expect(view.findAll('[data-testid="audio-player"]')).toHaveLength(1);
    expect(service.generateAudio.mock.calls[1]![0].cancellationSignal?.aborted).toBe(true);
  });
});


it('can cancel pending browser reference decoding before entering the inference service', async () => {
  const gate = Promise.withResolvers<Blob | undefined>(); const prepare = vi.spyOn(referencePreparation, 'prepareReferenceAudio').mockReturnValueOnce(gate.promise);
  const view = await ready(); await submit({ view });
  expect(prepare).toHaveBeenCalledOnce(); expect(service.generateAudio).not.toHaveBeenCalled();
  expect(view.get<HTMLButtonElement>('[data-testid="audio-finish"]').element.disabled).toBe(true);
  await view.get('[data-testid="audio-stop"]').trigger('click'); expect(prepare.mock.calls[0]![0].signal?.aborted).toBe(true);
  gate.resolve(undefined); await flushPromises(); expect(service.generateAudio).not.toHaveBeenCalled();
  expect(view.get<HTMLButtonElement>('[data-testid="audio-generate"]').element.disabled).toBe(false);
  await submit({ view }); expect(service.generateAudio).toHaveBeenCalledOnce();
});


describe('catalog placement and continuing previews', () => {
  it('places the original catalog outside the model/runtime details and configures audio-only entries', async () => {
    const view = await ready();
    const catalog = view.findComponent(LlamaCppBrowserModelSuggestions);
    expect(catalog.exists()).toBe(true); expect(catalog.props('suggestions')).toEqual(audioModelCatalog);
    expect(catalog.props('selectionAction')).toBe('select');
    expect(catalog.element.closest('[data-testid="audio-model-manager"]')).toBeNull();
    expect(view.get('[data-testid="audio-model-manager"]').findComponent(LlamaCppBrowserModelSuggestions).exists()).toBe(false);
    expect(view.find('[data-testid="llama-repository-catalog"]').exists()).toBe(false);
  });
  it('adds repeated previews with their actual step counts and original settings without ending the request', async () => {
    const view = await ready(); const gate = Promise.withResolvers<ReturnType<typeof audioResult>>(); service.generateAudio.mockReturnValueOnce(gate.promise);
    await submit({ view });
    expect(view.get<HTMLButtonElement>('[data-testid="audio-preview"]').element.disabled).toBe(true);
    notify({ state: { status: 'working', progress: { phase: 'generating', completed: 20, total: 1024 } } }); await nextTick();
    await view.get('[data-testid="audio-preview"]').trigger('click');
    const args = service.generateAudio.mock.calls[0]![0];
    expect(args.preview!.requests.version).toBe(1); expect(args.cancellationSignal?.aborted).toBe(false); expect(args.completionSignal?.aborted).toBe(false);
    expect(view.get<HTMLButtonElement>('[data-testid="audio-preview"]').element.disabled).toBe(true);
    await view.get('[data-testid="audio-text"]').setValue('Later edits do not change the request');
    await args.preview!.onPreview({ requestVersion: 1, result: { ...audioResult(), frames: 72, finishReason: 'preview' } }); await nextTick();
    expect(view.findAll('[data-testid="audio-player"]')).toHaveLength(1);
    expect(view.get('[data-testid="audio-result-steps"]').text()).toBe('72');
    expect(view.get('[data-testid="audio-result-text"]').text()).toBe('Hello');
    expect(view.find('[data-testid="audio-preview-result"]').exists()).toBe(true);
    expect(view.get<HTMLButtonElement>('[data-testid="audio-preview"]').element.disabled).toBe(false);
    expect(view.get<HTMLButtonElement>('[data-testid="audio-generate"]').element.disabled).toBe(true);
    await view.get('[data-testid="audio-preview"]').trigger('click');
    await args.preview!.onPreview({ requestVersion: 2, result: { ...audioResult(), frames: 144, finishReason: 'preview' } }); await nextTick();
    expect(view.findAll('[data-testid="audio-player"]')).toHaveLength(2);
    gate.resolve({ ...audioResult(), frames: 200 }); await flushPromises();
    expect(view.findAll('[data-testid="audio-result-steps"]').map(node => node.text())).toEqual(['200', '144', '72']);
    expect(view.findAll('[data-testid="audio-preview-result"]')).toHaveLength(2);
    expect(service.generateAudio).toHaveBeenCalledOnce();
  });
  it('keeps already accepted previews when cancelled and ignores late output after cancellation or unmount', async () => {
    const view = await ready(); const gate = Promise.withResolvers<ReturnType<typeof audioResult>>(); service.generateAudio.mockReturnValueOnce(gate.promise);
    await submit({ view });
    const args = service.generateAudio.mock.calls[0]![0];
    await args.preview!.onPreview({ requestVersion: 1, result: { ...audioResult(), frames: 72, finishReason: 'preview' } }); await nextTick();
    await view.get('[data-testid="audio-stop"]').trigger('click');
    await args.preview!.onPreview({ requestVersion: 2, result: { ...audioResult(), frames: 144, finishReason: 'preview' } });
    gate.resolve({ ...audioResult(), frames: 200 }); await flushPromises();
    expect(view.findAll('[data-testid="audio-player"]')).toHaveLength(1);
    const created = urls.create.mock.calls.length; view.unmount(); wrapper = undefined;
    await args.preview!.onPreview({ requestVersion: 3, result: { ...audioResult(), frames: 216, finishReason: 'preview' } });
    expect(urls.create).toHaveBeenCalledTimes(created); expect(urls.revoke).toHaveBeenCalledOnce();
  });
});
