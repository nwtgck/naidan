import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils';
import AudioReferenceInput from './AudioReferenceInput.vue';
import { ensureAllStringsForTest } from '@/strings/test-utils';
import { referenceFile } from '@/features/audio-generation/test-utils/blob';
import type { prepareReferenceAudio } from '@/features/audio-generation/reference-audio';
const prepare = vi.hoisted(() => vi.fn<typeof prepareReferenceAudio>());
vi.mock('../reference-audio', async importOriginal => ({ ...await importOriginal<typeof import('@/features/audio-generation/reference-audio')>(), prepareReferenceAudio: prepare }));
let view: VueWrapper | undefined;
const urls = { create: vi.fn(), revoke: vi.fn() };
beforeEach(async () => {
  vi.resetAllMocks(); prepare.mockImplementation(async ({ sources }) => sources[0]); let sequence = 0; urls.create.mockImplementation(() => `blob:reference-${++sequence}`);
  vi.stubGlobal('URL', class extends URL {
    static override createObjectURL = urls.create; static override revokeObjectURL = urls.revoke;
  });
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {}); vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {});
  await ensureAllStringsForTest({ locale: 'en' });
});
afterEach(() => {
  view?.unmount(); view = undefined; vi.restoreAllMocks(); vi.unstubAllGlobals();
});
function screen() {
  view = mount(AudioReferenceInput, { props: { disabled: false, invalid: false } }); return view;
}
async function add({ wrapper, files }: { wrapper: VueWrapper, files: File[] }) {
  const input = wrapper.get<HTMLInputElement>('[data-testid="audio-reference"]'); Object.defineProperty(input.element, 'files', { configurable: true, value: files }); await input.trigger('change');
}
describe('reference input workflow', () => {
  it('advertises drop, file selection and recording, but never requests permission on mount', () => {
    const wrapper = screen(); expect(wrapper.get('[data-testid="audio-reference-drop"]').text()).toContain('Drop audio');
    expect(wrapper.get('[data-testid="audio-reference"]').attributes()).toHaveProperty('multiple'); expect(wrapper.find('[data-testid="audio-reference-record"]').exists()).toBe(true);
  });
  it('keeps dropped files and selects the last added source', async () => {
    const wrapper = screen(); const one = referenceFile({ name: 'one.wav' }); const two = referenceFile({ name: 'two.wav' });
    await wrapper.get('[data-testid="audio-reference-drop"]').trigger('drop', { dataTransfer: { files: [one, two] } });
    const boxes = wrapper.findAll<HTMLInputElement>('[data-testid="audio-reference-selected"]');
    expect(boxes.map(box => box.element.checked)).toEqual([true, false]); expect(wrapper.findAll('[data-testid="audio-reference-entry"]')).toHaveLength(2);
    await boxes[1]!.setValue(true); const signal = new AbortController().signal;
    await (wrapper.vm as unknown as { prepare: ({ signal }: { signal: AbortSignal }) => Promise<Blob | undefined> }).prepare({ signal });
    expect(prepare).toHaveBeenCalledWith({ sources: [two, one], signal });
  });
  it('deselects all without deleting files, then allows selecting an older reference', async () => {
    const wrapper = screen(); await add({ wrapper, files: [referenceFile({ name: 'one.wav' }), referenceFile({ name: 'two.wav' })] });
    await wrapper.get('[data-testid="audio-clear-reference"]').trigger('click'); expect(wrapper.find('[data-testid="audio-reference-none"]').exists()).toBe(true); expect(urls.revoke).not.toHaveBeenCalled();
    await wrapper.findAll('[data-testid="audio-reference-selected"]')[1]!.setValue(true); expect(wrapper.find('[data-testid="audio-reference-none"]').exists()).toBe(false);
  });
  it('deletes reference URLs and detaches their media players', async () => {
    const wrapper = screen(); await add({ wrapper, files: [referenceFile({ name: 'one.wav' }), referenceFile({ name: 'two.wav' })] });
    await wrapper.findAll('[data-testid="audio-reference-delete"]')[0]!.trigger('click'); expect(urls.revoke).toHaveBeenCalledWith('blob:reference-2');
    expect(HTMLMediaElement.prototype.pause).toHaveBeenCalledOnce(); await wrapper.get('[data-testid="audio-reference-delete-all"]').trigger('click');
    expect(wrapper.findAll('[data-testid="audio-reference-entry"]')).toHaveLength(0); expect(urls.revoke).toHaveBeenCalledTimes(2);
  });
  it('shows a rejected file without clearing accepted references or their selection', async () => {
    const wrapper = screen(); await add({ wrapper, files: [referenceFile({ name: 'one.wav' }), new File([], 'empty.wav')] });
    expect(wrapper.get('[data-testid="audio-reference-error"]').text()).toContain('empty.wav'); expect(wrapper.findAll('[data-testid="audio-reference-entry"]')).toHaveLength(1);
    expect(wrapper.get<HTMLInputElement>('[data-testid="audio-reference-selected"]').element.checked).toBe(true);
  });
  it('ignores a drop while generation has locked selection', async () => {
    const wrapper = screen(); await wrapper.setProps({ disabled: true });
    await wrapper.get('[data-testid="audio-reference-drop"]').trigger('drop', { dataTransfer: { files: [referenceFile({ name: 'one.wav' })] } });
    expect(urls.create).not.toHaveBeenCalled(); expect(wrapper.get('[data-testid="audio-reference-record"]').attributes('disabled')).toBeDefined();
  });
  it('shows preparation failures locally rather than silently using no reference', async () => {
    const wrapper = screen(); prepare.mockRejectedValueOnce(new Error('decode')); await add({ wrapper, files: [referenceFile({ name: 'one.webm' })] });
    await expect((wrapper.vm as unknown as { prepare: ({ signal }: { signal: AbortSignal }) => Promise<Blob | undefined> }).prepare({ signal: new AbortController().signal })).rejects.toThrow();
    await flushPromises(); expect(wrapper.get('[data-testid="audio-reference-error"]').text()).toContain('could not decode');
    expect(wrapper.findAll('[data-testid="audio-reference-entry"]')).toHaveLength(1);
  });
});


it('consumes reference drops without forwarding them to a parent file handler', async () => {
  const wrapper = screen(); const parent = document.createElement('div'); parent.appendChild(wrapper.element); const dropped = vi.fn(); parent.addEventListener('drop', dropped);
  await wrapper.get('[data-testid="audio-reference-drop"]').trigger('drop', { dataTransfer: { files: [referenceFile({ name: 'one.wav' })] } });
  expect(dropped).not.toHaveBeenCalled(); expect(wrapper.findAll('[data-testid="audio-reference-entry"]')).toHaveLength(1);
});
it('keeps microphone Stop and Discard usable when the shared runtime becomes busy', async () => {
  const track = new EventTarget(); const stop = vi.fn(); Object.assign(track, { stop });
  const getUserMedia = vi.fn(async () => ({ getTracks: () => [track], getAudioTracks: () => [track] }));
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } }); vi.stubGlobal('OfflineAudioContext', class {});
  vi.stubGlobal('MediaRecorder', class extends EventTarget {
    static isTypeSupported = () => false;
    state: RecordingState = 'inactive'; start() {
      this.state = 'recording';
    } stop() {
      this.state = 'inactive';
    }
  });
  const wrapper = screen(); expect(getUserMedia).not.toHaveBeenCalled();
  await wrapper.get('[data-testid="audio-reference-record"]').trigger('click'); await flushPromises();
  expect(wrapper.emitted('busy')?.at(-1)).toEqual([true]);
  await wrapper.setProps({ disabled: true });
  expect(wrapper.get<HTMLButtonElement>('[data-testid="audio-reference-record-stop"]').element.disabled).toBe(false);
  expect(wrapper.get<HTMLButtonElement>('[data-testid="audio-reference-record-cancel"]').element.disabled).toBe(false);
  await wrapper.get('[data-testid="audio-reference-record-cancel"]').trigger('click');
  expect(stop).toHaveBeenCalledOnce(); expect(wrapper.emitted('busy')?.at(-1)).toEqual([false]);
});
