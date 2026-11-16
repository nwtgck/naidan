import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { ensureStrings } from '@/strings';
import { ensureAllStringsForTest } from '@/strings/utils.test-support';
import type { SpeechRecognitionRun } from '@/features/speech-cpp-browser/recognition/controller';
import LiveSpeechRecognitionResult from './LiveSpeechRecognitionResult.vue';

beforeEach(async () => {
  await ensureAllStringsForTest({ locale: 'en' });
});

function fixture() {
  const writeText = vi.fn(async (_text: string) => {});
  const clipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  const run: SpeechRecognitionRun = {
    id: 'run-1',
    modelName: 'ASR model',
    inputName: 'input.wav',
    status: 'complete',
    text: `\
こんにちは。
次の行です。`,
    languages: ['ja'],
    inputSeconds: 8,
    preparationSeconds: 0.01,
    recognitionSeconds: 1.25,
    failure: undefined,
  };
  const wrapper = mount(LiveSpeechRecognitionResult, { props: { run, progress: undefined } });
  return {
    wrapper,
    run,
    writeText,
    [Symbol.dispose]() {
      wrapper.unmount();
      if (clipboard) {
        Object.defineProperty(navigator, 'clipboard', clipboard);
      } else {
        Reflect.deleteProperty(navigator, 'clipboard');
      }
    },
  };
}

describe('recognition result text and measurements', () => {
  it('copies the full plain transcript unchanged and keeps the execution source visible', async () => {
    using f = fixture();
    await f.wrapper.get('[data-testid="live-recognition-copy"]').trigger('click');
    await flushPromises();
    expect(f.writeText).toHaveBeenCalledWith(f.run.text);
    expect(f.wrapper.get('[data-testid="live-recognition-copy"]').text()).toBe(await ensureStrings.liveConversation__transcription_copied());
    expect(f.wrapper.get('[data-testid="live-recognition-source"]').text()).toContain('ASR model · input.wav');
    expect(f.wrapper.get('[data-testid="live-recognition-input-seconds"]').text()).toBe('8.00 s');
    expect(f.wrapper.get('[data-testid="live-recognition-preparation-seconds"]').text()).toBe('0.01 s');
    expect(f.wrapper.get('[data-testid="live-recognition-processing-seconds"]').text()).toBe('1.25 s');
  });

  it('does not attach stale copy success to the next result', async () => {
    using f = fixture();
    const copying = Promise.withResolvers<void>();
    f.writeText.mockReturnValue(copying.promise);
    await f.wrapper.get('[data-testid="live-recognition-copy"]').trigger('click');
    await f.wrapper.setProps({ run: { ...f.run, id: 'run-2', text: '別の結果' } });
    copying.resolve();
    await flushPromises();
    expect(f.wrapper.get('[data-testid="live-recognition-copy"]').text()).toBe(await ensureStrings.liveConversation__copy_transcription());
    expect(f.wrapper.get('[data-testid="live-recognition-text"]').text()).toBe('別の結果');
  });

  it('keeps the transcript selectable when clipboard access fails', async () => {
    using f = fixture();
    f.writeText.mockRejectedValue(new Error('Clipboard denied'));
    await f.wrapper.get('[data-testid="live-recognition-copy"]').trigger('click');
    await flushPromises();
    expect(f.wrapper.get('[data-testid="live-recognition-copy-failure"]').text()).toBe(await ensureStrings.liveConversation__could_not_copy_transcription());
    expect(f.wrapper.get('[data-testid="live-recognition-text"]').text()).toContain('こんにちは');
  });

  it('distinguishes an empty complete result from cancellation and leaves unmeasured times unavailable', async () => {
    using f = fixture();
    await f.wrapper.setProps({ run: { ...f.run, text: '', inputSeconds: undefined, preparationSeconds: undefined, recognitionSeconds: undefined } });
    expect(f.wrapper.get('[data-testid="live-recognition-empty"]').text()).toBe(await ensureStrings.liveConversation__no_text_recognized());
    expect(f.wrapper.get('[data-testid="live-recognition-copy"]').attributes('disabled')).toBeDefined();
    expect(f.wrapper.get('[data-testid="live-recognition-processing-seconds"]').text()).toBe('—');
    await f.wrapper.setProps({ run: { ...f.run, text: '', status: 'cancelled' } });
    expect(f.wrapper.find('[data-testid="live-recognition-empty"]').exists()).toBe(false);
    expect(f.wrapper.get('[data-testid="live-recognition-completion"]').text()).toBe(await ensureStrings.liveConversation__transcription_cancelled());
  });

  it('only displays a recognition percentage when the runtime reports one', async () => {
    using f = fixture();
    await f.wrapper.setProps({ run: { ...f.run, status: 'preparing', text: '' } });
    expect(f.wrapper.get('[data-testid="live-recognition-progress-bar"]').attributes('aria-valuenow')).toBeUndefined();
    await f.wrapper.setProps({ run: { ...f.run, status: 'recognizing', text: '' }, progress: 0.25 });
    expect(f.wrapper.get('[data-testid="live-recognition-progress"]').text()).toContain('25%');
  });
});
