import { mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ensureStrings } from '@/strings';
import { ensureAllStringsForTest } from '@/strings/utils.test-support';
import type { LiveSpeechInputLevel } from '@/features/live-conversation/logic/speech-controller';
import SettingsFormSelect from '@/components/SettingsFormSelect.vue';
import LiveSpeechInputLevelControl from './LiveSpeechInputLevel.vue';

beforeEach(async () => {
  await ensureAllStringsForTest({ locale: 'en' });
});

function emptyLevel(): LiveSpeechInputLevel {
  return { gain: 1, observation: 'off', window: undefined, captureSettings: undefined };
}

function observedLevel(): LiveSpeechInputLevel {
  return {
    gain: 4,
    observation: 'on',
    window: {
      gain: 4,
      before: { samples: 12000, sampleRate: 24000, seconds: .5, peak: .1, rms: .02, clippedSamples: 0 },
      after: { samples: 12000, sampleRate: 24000, seconds: .5, peak: .4, rms: .08, clippedSamples: 0 },
      clippedSamples: 0,
    },
    captureSettings: undefined,
  };
}

function fixture({ level, muted, blocked }: { level: LiveSpeechInputLevel, muted: boolean, blocked: boolean }) {
  const observe = vi.fn<(value: 'on' | 'off') => void>();
  const wrapper = mount(LiveSpeechInputLevelControl, { props: { level, muted, blocked, onObserve: observe } });
  let mounted = true;
  function unmount(): void {
    if (mounted) {
      mounted = false;
      wrapper.unmount();
    }
  }
  return {
    wrapper,
    observe,
    unmount,
    async expand({ value }: { value: boolean }): Promise<void> {
      wrapper.get<HTMLDetailsElement>('[data-testid="live-speech-input-level"]').element.open = value;
      await wrapper.get('[data-testid="live-speech-input-level"]').trigger('toggle');
    },
    [Symbol.dispose]() {
      unmount();
    },
  };
}

describe('live microphone input level control', () => {
  it('requests observation only while expanded and releases it on close and unmount', async () => {
    using f = fixture({ level: emptyLevel(), muted: false, blocked: false });
    expect(f.wrapper.emitted('observe')).toEqual([['off']]);
    expect(f.wrapper.find('[data-testid="live-speech-input-gain"]').exists()).toBe(false);
    await f.expand({ value: true });
    await f.expand({ value: true });
    expect(f.wrapper.emitted('observe')).toEqual([['off'], ['on']]);
    await f.expand({ value: false });
    expect(f.wrapper.emitted('observe')).toEqual([['off'], ['on'], ['off']]);
    await f.expand({ value: true });
    f.unmount();
    expect(f.observe.mock.calls).toEqual([['off'], ['on'], ['off'], ['on'], ['off']]);
  });

  it('starts from unity and offers only the five fixed gains, with no automatic peak mode', async () => {
    using f = fixture({ level: emptyLevel(), muted: false, blocked: false });
    await f.expand({ value: true });
    const select = f.wrapper.getComponent(SettingsFormSelect);
    expect(select.props()).toMatchObject({
      modelValue: 1,
      options: [
        { value: .5, label: '0.5×' }, { value: 1, label: '1×' }, { value: 2, label: '2×' },
        { value: 4, label: '4×' }, { value: 8, label: '8×' },
      ],
    });
    select.vm.$emit('update:modelValue', 4);
    expect(f.wrapper.emitted('gain')).toEqual([[4]]);
    expect(f.wrapper.props('level').gain).toBe(1);
    select.vm.$emit('update:modelValue', 3);
    select.vm.$emit('update:modelValue', 1);
    expect(f.wrapper.emitted('gain')).toEqual([[4]]);
  });

  it('prevents blocked gain edits without hiding the current setting', async () => {
    using f = fixture({ level: { ...emptyLevel(), gain: 2 }, muted: false, blocked: true });
    await f.expand({ value: true });
    const select = f.wrapper.getComponent(SettingsFormSelect);
    expect(select.props()).toMatchObject({ disabled: true, modelValue: 2 });
    select.vm.$emit('update:modelValue', 8);
    expect(f.wrapper.emitted('gain')).toBeUndefined();
  });

  it('does not invent zero readings before a window arrives, including while muted', async () => {
    using f = fixture({ level: emptyLevel(), muted: true, blocked: false });
    await f.expand({ value: true });
    expect(f.wrapper.get('[data-testid="live-speech-input-muted"]').text()).toBe(await ensureStrings.liveConversation__microphone_muted());
    expect(f.wrapper.get('[data-testid="live-speech-input-level-pending"]').text()).toBe(await ensureStrings.liveConversation__input_level_not_observed());
    expect(f.wrapper.find('[data-testid="live-speech-input-before"]').exists()).toBe(false);
    expect(f.wrapper.find('[data-testid="live-speech-input-after"]').exists()).toBe(false);
    const level = observedLevel();
    level.window = {
      gain: 4,
      before: { sampleRate: 24000, samples: 12000, seconds: .5, peak: 0, rms: 0, clippedSamples: 0 },
      after: { sampleRate: 24000, samples: 12000, seconds: .5, peak: 0, rms: 0, clippedSamples: 0 },
      clippedSamples: 0,
    };
    await f.wrapper.setProps({ level });
    expect(f.wrapper.find('[data-testid="live-speech-input-level-pending"]').exists()).toBe(false);
    expect(f.wrapper.get('[data-testid="live-speech-input-after"]').text()).toBe(await ensureStrings.liveConversation__audio_statistics({ seconds: '0.5', sampleRate: 24000, peak: '0', rms: '0', clipped: 0 }));
  });

  it('shows actual before/after metrics and preserves small nonzero readings', async () => {
    const level = observedLevel();
    if (level.window) {
      level.window.before.peak = .000001;
      level.window.before.rms = .0000005;
    }
    using f = fixture({ level, muted: false, blocked: false });
    await f.expand({ value: true });
    expect(f.wrapper.get('[data-testid="live-speech-input-before"]').text()).toBe(await ensureStrings.liveConversation__audio_statistics({ seconds: '0.5', sampleRate: 24000, peak: '0.000001', rms: '0.0000005', clipped: 0 }));
    expect(f.wrapper.get('[data-testid="live-speech-input-after"]').text()).toBe(await ensureStrings.liveConversation__audio_statistics({ seconds: '0.5', sampleRate: 24000, peak: '0.4', rms: '0.08', clipped: 0 }));
  });

  it('advises lowering the gain when adjustment actually clips and clears the warning with a new clean window', async () => {
    const level = observedLevel();
    if (level.window) {
      level.window.clippedSamples = 3;
    }
    using f = fixture({ level, muted: false, blocked: false });
    await f.expand({ value: true });
    expect(f.wrapper.get('[data-testid="live-speech-input-clipped"]').text()).toBe(await ensureStrings.liveConversation__live_input_clipped());
    await f.wrapper.setProps({ level: observedLevel() });
    expect(f.wrapper.find('[data-testid="live-speech-input-clipped"]').exists()).toBe(false);
  });

  it('distinguishes actual processing false, true and unknown without inferring unsupported', async () => {
    const level = emptyLevel();
    level.captureSettings = { autoGainControl: false, echoCancellation: true, noiseSuppression: undefined, sampleRate: 48000, channelCount: 1, latency: undefined };
    using f = fixture({ level, muted: false, blocked: false });
    await f.expand({ value: true });
    expect(f.wrapper.get('[data-testid="live-speech-input-agc"]').text()).toBe(await ensureStrings.liveConversation__live_input_processing_off());
    expect(f.wrapper.get('[data-testid="live-speech-input-aec"]').text()).toBe(await ensureStrings.liveConversation__live_input_processing_on());
    expect(f.wrapper.get('[data-testid="live-speech-input-ns"]').text()).toBe(await ensureStrings.liveConversation__setting_unknown());
    await f.wrapper.setProps({ level: emptyLevel() });
    for (const setting of ['agc', 'aec', 'ns']) {
      expect(f.wrapper.get(`[data-testid="live-speech-input-${setting}"]`).text()).toBe(await ensureStrings.liveConversation__setting_unknown());
    }
  });
});
