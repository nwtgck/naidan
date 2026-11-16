import { mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ensureStrings } from '@/strings';
import { ensureAllStringsForTest } from '@/strings/utils.test-support';
import { initialSpeechRecordingState, type SpeechRecordingClip, type SpeechRecordingState } from '@/features/live-conversation/logic/speech-recognition-recording';
import { speechFailure } from '@/features/speech-cpp-browser/types';
import LiveSpeechRecordingInput from './LiveSpeechRecordingInput.vue';

beforeEach(async () => {
  await ensureAllStringsForTest({ locale: 'en' });
});

function clip(): Pick<SpeechRecordingClip, 'id' | 'file' | 'seconds' | 'status'> {
  return { id: 'recording-a', file: new File(['pcm'], 'recording.wav', { type: 'audio/wav' }), seconds: 1.25, status: 'complete' };
}

function fixture({ purpose, state, recording }: { purpose: 'transcription' | 'response', state: SpeechRecordingState, recording: ReturnType<typeof clip> | undefined }) {
  const createUrl = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:recording-input');
  const revokeUrl = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  const wrapper = mount(LiveSpeechRecordingInput, { props: { purpose, source: 'microphone', state, clip: recording, blocked: false } });
  let mounted = true;
  function unmount(): void {
    if (mounted) {
      mounted = false;
      wrapper.unmount();
    }
  }
  return {
    wrapper,
    createUrl,
    revokeUrl,
    unmount,
    [Symbol.dispose]() {
      unmount();
      createUrl.mockRestore();
      revokeUrl.mockRestore();
    },
  };
}

describe('shared microphone recording input', () => {
  it.each(['transcription', 'response'] as const)('keeps %s recording an explicit model-free input action', async purpose => {
    using f = fixture({ purpose, state: initialSpeechRecordingState(), recording: undefined });
    const prefix = purpose === 'transcription' ? 'live-recognition' : 'live-response';
    expect(f.wrapper.find(`[data-testid="${prefix}-input"]`).exists()).toBe(true);
    expect(f.wrapper.text()).toContain(purpose === 'transcription' ? await ensureStrings.liveConversation__microphone_recording_help() : await ensureStrings.liveConversation__response_microphone_recording_help());
    expect(f.wrapper.emitted('start')).toBeUndefined();
    await f.wrapper.get(`[data-testid="${prefix}-record"]`).trigger('click');
    expect(f.wrapper.emitted('start')).toEqual([[]]);
    await f.wrapper.get(`[data-testid="${prefix}-file-source"]`).trigger('click');
    expect(f.wrapper.emitted('source')).toEqual([['file']]);
    await f.wrapper.setProps({ blocked: true });
    expect(f.wrapper.get<HTMLButtonElement>(`[data-testid="${prefix}-record"]`).element.disabled).toBe(true);
    expect(f.wrapper.get<HTMLButtonElement>(`[data-testid="${prefix}-microphone-source"]`).element.disabled).toBe(true);
  });

  it('keeps stop and discard accessible during opening and recording while preventing source switches', async () => {
    using f = fixture({ purpose: 'response', state: { ...initialSpeechRecordingState(), phase: 'opening' }, recording: undefined });
    await f.wrapper.setProps({ blocked: true });
    expect(f.wrapper.get<HTMLButtonElement>('[data-testid="live-response-file-source"]').element.disabled).toBe(true);
    expect(f.wrapper.get<HTMLButtonElement>('[data-testid="live-response-record-stop"]').element.disabled).toBe(false);
    expect(f.wrapper.get<HTMLButtonElement>('[data-testid="live-response-record-discard"]').element.disabled).toBe(false);
    await f.wrapper.get('[data-testid="live-response-record-stop"]').trigger('click');
    await f.wrapper.get('[data-testid="live-response-record-discard"]').trigger('click');
    expect(f.wrapper.emitted('stop')).toEqual([[]]);
    expect(f.wrapper.emitted('discard')).toEqual([[]]);
    await f.wrapper.setProps({ state: { ...initialSpeechRecordingState(), phase: 'recording', elapsedSeconds: 1.2 } });
    expect(f.wrapper.get('[data-testid="live-response-record-status"]').text()).toContain('1.2 s');
    await f.wrapper.setProps({ state: { ...initialSpeechRecordingState(), phase: 'stopping' } });
    expect(f.wrapper.get<HTMLButtonElement>('[data-testid="live-response-record-stop"]').element.disabled).toBe(true);
    expect(f.wrapper.get<HTMLButtonElement>('[data-testid="live-response-record-discard"]').element.disabled).toBe(false);
  });

  it.each(['transcription', 'response'] as const)('reuses the %s recording File for playback and download and cleans up its URL', async purpose => {
    const recording = clip();
    using f = fixture({ purpose, state: initialSpeechRecordingState(), recording });
    const prefix = purpose === 'transcription' ? 'live-recognition' : 'live-response';
    expect(f.createUrl).toHaveBeenCalledExactlyOnceWith(recording.file);
    const audio = f.wrapper.get<HTMLAudioElement>(`[data-testid="${prefix}-recording-replay"]`);
    expect(audio.attributes('src')).toBe('blob:recording-input');
    expect(f.wrapper.get(`[data-testid="${prefix}-recording-download"]`).attributes('download')).toBe(`naidan-${purpose}-recording-a-input.wav`);
    await audio.trigger('play');
    await audio.trigger('ended');
    expect(f.wrapper.emitted('replayStart')).toEqual([[audio.element]]);
    expect(f.wrapper.emitted('replayEnd')).toEqual([[audio.element]]);
    await f.wrapper.setProps({ clip: undefined });
    expect(f.revokeUrl).toHaveBeenCalledExactlyOnceWith('blob:recording-input');
    expect(f.wrapper.find(`[data-testid="${prefix}-recording-replay"]`).exists()).toBe(false);
  });

  it.each(['replacement', 'recording', 'source', 'unmount'] as const)('pauses playback before %s removes or disables its audio', async operation => {
    using f = fixture({ purpose: 'response', state: initialSpeechRecordingState(), recording: clip() });
    const audio = f.wrapper.get<HTMLAudioElement>('[data-testid="live-response-recording-replay"]').element;
    Object.defineProperty(audio, 'paused', { configurable: true, value: false });
    const pause = vi.spyOn(audio, 'pause').mockImplementation(() => {
      Object.defineProperty(audio, 'paused', { configurable: true, value: true });
    });
    switch (operation) {
    case 'replacement': await f.wrapper.setProps({ clip: { ...clip(), id: 'recording-b' } });
      break;
    case 'recording': await f.wrapper.setProps({ state: { ...initialSpeechRecordingState(), phase: 'recording' } });
      break;
    case 'source': await f.wrapper.setProps({ source: 'file' });
      break;
    case 'unmount': f.unmount();
      break;
    default: {
      const exhaustive: never = operation;
      throw new Error(String(exhaustive));
    }
    }
    expect(pause).toHaveBeenCalledOnce();
    expect(f.wrapper.emitted('replayEnd')).toEqual([[audio]]);
    if (operation === 'replacement' || operation === 'unmount') {
      expect(f.revokeUrl).toHaveBeenCalledOnce();
      expect(pause.mock.invocationCallOrder[0]!).toBeLessThan(f.revokeUrl.mock.invocationCallOrder[0]!);
    }
  });

  it('identifies capped and partial recordings without hiding capture failure details', async () => {
    using f = fixture({ purpose: 'response', state: initialSpeechRecordingState(), recording: { ...clip(), status: 'limit' } });
    expect(f.wrapper.text()).toContain(await ensureStrings.liveConversation__recording_limit_reached());
    await f.wrapper.setProps({ clip: { ...clip(), status: 'partial' }, state: { ...initialSpeechRecordingState(), phase: 'failed', failure: speechFailure({ error: new Error('Microphone disconnected') }) } });
    expect(f.wrapper.text()).toContain(await ensureStrings.liveConversation__partial_microphone_recording());
    expect(f.wrapper.get('[role="alert"]').text()).toBe('Microphone disconnected');
  });
});
