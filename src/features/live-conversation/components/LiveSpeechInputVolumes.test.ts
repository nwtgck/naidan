import { beforeEach, describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import { ensureAllStringsForTest } from '@/strings/utils.test-support';
import { ensureStrings } from '@/strings';
import LiveSpeechInputVolumes from './LiveSpeechInputVolumes.vue';

beforeEach(async () => {
  await ensureAllStringsForTest({ locale: 'en' });
});

describe('response input-volume comparison choices', () => {
  it('starts with unity gain and adds multiple conditions in their displayed order', async () => {
    using view = {
      wrapper: mount(LiveSpeechInputVolumes, { props: { settings: [{ kind: 'gain', gain: 1 }], blocked: false } }),
      [Symbol.dispose]() {
        this.wrapper.unmount();
      },
    };
    const wrapper = view.wrapper;
    expect(wrapper.findAll('input[type="checkbox"]')).toHaveLength(6);
    expect(wrapper.get<HTMLInputElement>('[data-testid="live-diagnostics-input-level-gain-1"]').element.checked).toBe(true);
    await wrapper.get('[data-testid="live-diagnostics-input-level-gain-4"]').setValue(true);
    expect(wrapper.emitted('change')?.at(-1)).toEqual([[{ kind: 'gain', gain: 1 }, { kind: 'gain', gain: 4 }]]);
    await wrapper.setProps({ settings: [{ kind: 'gain', gain: 1 }, { kind: 'gain', gain: 4 }] });
    await wrapper.get('[data-testid="live-diagnostics-input-level-peak-0.8"]').setValue(true);
    expect(wrapper.emitted('change')?.at(-1)).toEqual([[{ kind: 'gain', gain: 1 }, { kind: 'gain', gain: 4 }, { kind: 'peak', targetPeak: 0.8 }]]);
    await wrapper.setProps({ settings: [{ kind: 'gain', gain: 1 }, { kind: 'gain', gain: 4 }, { kind: 'peak', targetPeak: 0.8 }] });
    expect(wrapper.get('[data-testid="live-diagnostics-peak-help"]').text()).toBe(await ensureStrings.liveConversation__peak_volume_help());
    await wrapper.get('[data-testid="live-diagnostics-input-level-gain-1"]').setValue(false);
    expect(wrapper.emitted('change')?.at(-1)).toEqual([[{ kind: 'gain', gain: 4 }, { kind: 'peak', targetPeak: 0.8 }]]);
  });

  it('allows clearing the selection and rejects changes while generation is blocked', async () => {
    using view = {
      wrapper: mount(LiveSpeechInputVolumes, { props: { settings: [{ kind: 'gain', gain: 1 }], blocked: false } }),
      [Symbol.dispose]() {
        this.wrapper.unmount();
      },
    };
    const wrapper = view.wrapper;
    await wrapper.get('[data-testid="live-diagnostics-input-level-gain-1"]').setValue(false);
    expect(wrapper.emitted('change')?.at(-1)).toEqual([[]]);
    await wrapper.setProps({ settings: [], blocked: true });
    expect(wrapper.get('[data-testid="live-diagnostics-input-level-gain-2"]').attributes('disabled')).toBeDefined();
    const events = wrapper.emitted('change')?.length;
    await wrapper.get('[data-testid="live-diagnostics-input-level-gain-2"]').trigger('change');
    expect(wrapper.emitted('change')).toHaveLength(events ?? 0);
  });
});
