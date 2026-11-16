import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DOMWrapper, mount } from '@vue/test-utils';
import { ensureStrings } from '@/strings';
import { ensureAllStringsForTest } from '@/strings/utils.test-support';
import LiveConversationDiagnostics from './LiveConversationDiagnostics.vue';

beforeEach(async () => {
  await ensureAllStringsForTest({ locale: 'en' });
});

function fixture({ busy, blocked }: { busy: boolean, blocked: boolean }) {
  const file = new File(['audio'], 'same-input.wav', { type: 'audio/wav' });
  const createUrl = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:source');
  const revokeUrl = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  const pause = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  const host = document.createElement('div');
  document.body.append(host);
  const wrapper = mount(LiveConversationDiagnostics, { attachTo: host, props: { file, task: 'response', busy, blocked }, slots: { model: '<div data-testid="model-slot">model</div>', default: '<div data-testid="task-slot">task</div>' } });
  return {
    wrapper,
    file,
    createUrl,
    revokeUrl,
    page: new DOMWrapper(document.body),
    [Symbol.dispose]() {
      wrapper.unmount();
      host.remove();
      createUrl.mockRestore();
      revokeUrl.mockRestore();
      pause.mockRestore();
    },
  };
}

describe('shared investigation navigation and source audio', () => {
  it('keeps implemented task navigation open while processing and preserves the shared input', async () => {
    using f = fixture({ busy: true, blocked: true });
    const source = f.wrapper.get('[data-testid="live-diagnostics-source-replay"]').element;
    const model = f.wrapper.get('[data-testid="model-slot"]').element;
    await f.wrapper.get('[data-testid="live-diagnostics-transcription-task"]').trigger('click');
    expect(f.wrapper.emitted('task')).toEqual([['transcription']]);
    await f.wrapper.setProps({ task: 'transcription' });
    expect(f.wrapper.get('[data-testid="live-diagnostics-transcription-task"]').attributes('aria-selected')).toBe('true');
    expect(f.wrapper.get('[data-testid="live-diagnostics-source-replay"]').element).toBe(source);
    expect(f.wrapper.get('[data-testid="model-slot"]').element).toBe(model);
    expect(f.createUrl).toHaveBeenCalledOnce();
    expect(f.revokeUrl).not.toHaveBeenCalled();
    expect(f.wrapper.get('[data-testid="live-diagnostics-choose"]').attributes('disabled')).toBeDefined();
    expect(f.wrapper.get('[data-testid="live-diagnostics-tts"]').attributes('disabled')).toBeDefined();
    await f.wrapper.get('[data-testid="live-diagnostics-response-task"]').trigger('click');
    expect(f.wrapper.emitted('task')?.at(-1)).toEqual(['response']);
  });

  it('shows the unsupported investigation engine without treating normal LM conversations as unsupported', async () => {
    using f = fixture({ busy: false, blocked: false });
    await f.wrapper.get('[data-testid="live-diagnostics-engine"]').trigger('click');
    expect(f.page.get<HTMLButtonElement>('[data-testid="settings-select-option-llama"]').element.disabled).toBe(true);
    expect(f.page.get('[data-testid="settings-select-option-llama"]').text()).toBe(await ensureStrings.liveConversation__llama_cpp_investigation_unavailable());
    expect(f.wrapper.get('[data-testid="live-diagnostics-engine"]').text()).toBe(await ensureStrings.liveConversation__speech_cpp_in_browser());
    expect(f.wrapper.find('[data-testid="live-diagnostics-seed"]').exists()).toBe(false);
    expect(f.wrapper.find('[data-testid="live-diagnostics-pacing"]').exists()).toBe(false);
  });
});
