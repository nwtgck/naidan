import { mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it } from 'vitest';
import { ensureStrings } from '@/strings';
import { ensureAllStringsForTest } from '@/strings/utils.test-support';
import LiveSpeechInvestigationExport from './LiveSpeechInvestigationExport.vue';

beforeEach(async () => {
  await ensureAllStringsForTest({ locale: 'en' });
});

function fixture({ captureId, saving, failure }: { captureId: string | undefined, saving: boolean, failure: string | undefined }) {
  const wrapper = mount(LiveSpeechInvestigationExport, { props: { captureId, saving, failure } });
  return {
    wrapper,
    [Symbol.dispose]() {
      wrapper.unmount();
    },
  };
}

describe('speech investigation export controls', () => {
  it('keeps the empty entry visible with a start explanation and disabled save controls', async () => {
    using f = fixture({ captureId: undefined, saving: false, failure: undefined });
    expect(f.wrapper.get('[data-testid="live-investigation-export-empty"]').text()).toBe(await ensureStrings.liveConversation__investigation_record_after_run());
    expect(f.wrapper.get<HTMLButtonElement>('[data-testid="live-investigation-save"]').element.disabled).toBe(true);
    expect(f.wrapper.get<HTMLButtonElement>('[data-testid="live-investigation-clear"]').element.disabled).toBe(true);
    for (const input of f.wrapper.findAll<HTMLInputElement>('input[type="checkbox"]')) {
      expect(input.element.disabled).toBe(true);
      expect(input.element.checked).toBe(false);
    }
    await f.wrapper.get('[data-testid="live-investigation-save"]').trigger('click');
    await f.wrapper.get('[data-testid="live-investigation-clear"]').trigger('click');
    expect(f.wrapper.emitted('download')).toBeUndefined();
    expect(f.wrapper.emitted('clear')).toBeUndefined();
    expect(f.wrapper.find('[data-testid="live-investigation-export-cancel"]').exists()).toBe(false);
  });

  it('excludes private inputs by default while describing result text and logs as included', async () => {
    using f = fixture({ captureId: 'capture-a', saving: false, failure: undefined });
    expect(f.wrapper.get('[data-testid="live-investigation-export-contents"]').text()).toBe(await ensureStrings.liveConversation__investigation_zip_contents());
    expect(f.wrapper.findAll('input[type="checkbox"]')).toHaveLength(2);
    expect(f.wrapper.get<HTMLInputElement>('[data-testid="live-investigation-include-input-audio"]').element.checked).toBe(false);
    expect(f.wrapper.get<HTMLInputElement>('[data-testid="live-investigation-include-input-text"]').element.checked).toBe(false);
    await f.wrapper.get('[data-testid="live-investigation-save"]').trigger('click');
    expect(f.wrapper.emitted('download')).toEqual([[{ includeInputAudio: 'off', includeInputText: 'off' }]]);
  });

  it('emits independent audio and instruction choices without changing an earlier export request', async () => {
    using f = fixture({ captureId: 'capture-a', saving: false, failure: undefined });
    await f.wrapper.get('[data-testid="live-investigation-include-input-audio"]').setValue(true);
    await f.wrapper.get('[data-testid="live-investigation-save"]').trigger('click');
    await f.wrapper.get('[data-testid="live-investigation-include-input-audio"]').setValue(false);
    await f.wrapper.get('[data-testid="live-investigation-include-input-text"]').setValue(true);
    await f.wrapper.get('[data-testid="live-investigation-save"]').trigger('click');
    expect(f.wrapper.emitted('download')).toEqual([
      [{ includeInputAudio: 'on', includeInputText: 'off' }],
      [{ includeInputAudio: 'off', includeInputText: 'on' }],
    ]);
  });

  it('resets opt-ins when a different capture arrives or the current capture is cleared', async () => {
    using f = fixture({ captureId: 'capture-a', saving: false, failure: undefined });
    await f.wrapper.get('[data-testid="live-investigation-include-input-audio"]').setValue(true);
    await f.wrapper.get('[data-testid="live-investigation-include-input-text"]').setValue(true);
    await f.wrapper.setProps({ captureId: 'capture-b' });
    await f.wrapper.get('[data-testid="live-investigation-save"]').trigger('click');
    expect(f.wrapper.emitted('download')).toEqual([[{ includeInputAudio: 'off', includeInputText: 'off' }]]);
    await f.wrapper.get('[data-testid="live-investigation-include-input-text"]').setValue(true);
    await f.wrapper.setProps({ captureId: undefined });
    await f.wrapper.setProps({ captureId: 'capture-c' });
    expect(f.wrapper.get<HTMLInputElement>('[data-testid="live-investigation-include-input-text"]').element.checked).toBe(false);
  });

  it('locks the capture controls while saving, permits cancel and preserves choices for retry', async () => {
    using f = fixture({ captureId: 'capture-a', saving: false, failure: undefined });
    await f.wrapper.get('[data-testid="live-investigation-include-input-audio"]').setValue(true);
    await f.wrapper.setProps({ saving: true });
    expect(f.wrapper.get('[data-testid="live-investigation-export"]').attributes('aria-busy')).toBe('true');
    expect(f.wrapper.get('[data-testid="live-investigation-save"]').text()).toBe(await ensureStrings.liveConversation__creating_investigation_zip());
    expect(f.wrapper.get<HTMLButtonElement>('[data-testid="live-investigation-save"]').element.disabled).toBe(true);
    expect(f.wrapper.get<HTMLButtonElement>('[data-testid="live-investigation-clear"]').element.disabled).toBe(true);
    for (const input of f.wrapper.findAll<HTMLInputElement>('input[type="checkbox"]')) {
      expect(input.element.disabled).toBe(true);
    }
    await f.wrapper.get('[data-testid="live-investigation-save"]').trigger('click');
    await f.wrapper.get('[data-testid="live-investigation-clear"]').trigger('click');
    await f.wrapper.get('[data-testid="live-investigation-export-cancel"]').trigger('click');
    expect(f.wrapper.emitted('download')).toBeUndefined();
    expect(f.wrapper.emitted('clear')).toBeUndefined();
    expect(f.wrapper.emitted('cancel')).toEqual([[]]);
    await f.wrapper.setProps({ saving: false });
    expect(f.wrapper.find('[data-testid="live-investigation-export-cancel"]').exists()).toBe(false);
    await f.wrapper.get('[data-testid="live-investigation-save"]').trigger('click');
    expect(f.wrapper.emitted('download')).toEqual([[{ includeInputAudio: 'on', includeInputText: 'off' }]]);
  });

  it('emits clear separately and renders complete failure details as text', async () => {
    const failure = `\
ZIP creation failed
Native detail: <archive limit> & retained audio`;
    using f = fixture({ captureId: 'capture-a', saving: false, failure });
    const alert = f.wrapper.get('[data-testid="live-investigation-export-failure"]');
    expect(alert.attributes('role')).toBe('alert');
    expect(alert.element.textContent).toBe(failure);
    expect(alert.find('archive').exists()).toBe(false);
    await f.wrapper.get('[data-testid="live-investigation-clear"]').trigger('click');
    expect(f.wrapper.emitted('clear')).toEqual([[]]);
    expect(f.wrapper.emitted('download')).toBeUndefined();
    await f.wrapper.setProps({ failure: undefined });
    expect(f.wrapper.find('[data-testid="live-investigation-export-failure"]').exists()).toBe(false);
  });
});
