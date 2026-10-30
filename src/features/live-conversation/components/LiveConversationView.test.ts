import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h, onMounted, shallowRef } from 'vue';
import { mount, flushPromises } from '@vue/test-utils';
import { ensureAllStringsForTest } from '@/strings/utils.test-support';
import { useLiveConversation } from '@/features/live-conversation/composables/useLiveConversation';
import { createLiveControllerFixture } from '@/features/live-conversation/logic/controller.test-support';
import LiveConversationView from './LiveConversationView.vue';

vi.mock('@/features/live-conversation/composables/useLiveConversation', () => ({ useLiveConversation: vi.fn() }));
vi.mock('@/00-storage/service', () => ({ storageService: { listVolumes: async function* () {} } }));
vi.mock('@/features/llama-cpp-browser/components/LlamaCppBrowserManager.vue', () => ({
  default: defineComponent({
    props: ['suspended'],
    emits: ['models-changed', 'model-selected', 'runtime-ready'],
    setup(_props, { emit }) {
      onMounted(() => {
        emit('models-changed', [{ modelId: 'user/live' }]);
        emit('model-selected', 'user/live');
        emit('runtime-ready', true);
      });
      return () => h('div', { 'data-testid': 'mock-model-manager' });
    },
  }),
}));
vi.mock('@/components/ModelSelector.vue', () => ({
  default: defineComponent({
    props: ['modelValue', 'disabled'],
    setup(props) {
      return () => h('input', { value: props.modelValue, disabled: props.disabled });
    },
  }),
}));

beforeEach(async () => {
  vi.clearAllMocks();
  await ensureAllStringsForTest({ locale: 'en' });
});

async function fixture() {
  const f = createLiveControllerFixture();
  const state = shallowRef(f.controller.getState());
  f.onChange.mockImplementation(({ state: next }) => {
    state.value = next;
  });
  vi.mocked(useLiveConversation).mockReturnValue({ state, controller: f.controller, TEST_ONLY: {} });
  const wrapper = mount(LiveConversationView);
  await flushPromises();
  return {
    ...f,
    state,
    wrapper,
    async [Symbol.asyncDispose]() {
      wrapper.unmount();
      await f.controller.dispose();
    },
  };
}

describe('independent live conversation workspace', () => {
  it('starts only explicitly and keeps model controls fixed during the session', async () => {
    await using f = await fixture();
    expect(f.runLiveSession).not.toHaveBeenCalled();
    expect(f.capture).not.toHaveBeenCalled();
    await f.wrapper.get('[data-testid="live-start"]').trigger('click');
    await flushPromises();
    expect(f.runLiveSession).toHaveBeenCalledOnce();
    expect(f.wrapper.get('[data-testid="live-model"]').attributes('disabled')).toBeDefined();
    expect(f.capture).not.toHaveBeenCalled();
    await f.wrapper.get('[data-testid="live-end"]').trigger('click');
    await flushPromises();
    expect(f.wrapper.find('[data-testid="live-start"]').exists()).toBe(true);
  });

  it('changes only the next response channels without another model load', async () => {
    await using f = await fixture();
    await f.wrapper.get('[data-testid="live-start"]').trigger('click');
    await flushPromises();
    await f.wrapper.get('[data-testid="live-output-voice"]').setValue(false);
    await f.wrapper.get('[data-testid="live-text"]').setValue('Hello');
    await f.wrapper.get('form').trigger('submit');
    await flushPromises();
    expect(f.request.mock.calls.find(([args]) => args.command.type === 'respond')?.[0].command).toMatchObject({ output: 'text' });
    expect(f.runLiveSession).toHaveBeenCalledOnce();
    expect(f.wrapper.get('[data-testid="live-history"]').text()).toContain('Answer');
    await f.wrapper.get('[data-testid="live-output-text"]').setValue(false);
    expect(f.wrapper.get('[data-testid="live-record"]').attributes('disabled')).toBeDefined();
    expect(f.wrapper.get('[data-testid="live-send"]').attributes('disabled')).toBeDefined();
  });

  it('uses a plain text transcript rather than interpreting model HTML', async () => {
    await using f = await fixture();
    f.state.value = { ...f.state.value, entries: [{ id: 'turn', inputText: '<script>bad()</script>', imageNames: [], hasAudio: true, transcript: '', answer: '<img src=x onerror=bad()>', output: 'mixed', status: 'complete', toolResults: [] }] };
    await flushPromises();
    expect(f.wrapper.get('[data-testid="live-history"]').text()).toContain('<img src=x onerror=bad()>');
    expect(f.wrapper.find('[data-testid="live-history"] img').exists()).toBe(false);
    expect(f.wrapper.find('[data-testid="live-history"] script').exists()).toBe(false);
  });

  it('keeps image controls visible but unavailable for an Audio-only model', async () => {
    await using f = await fixture();
    f.scope.info.vision = 'unavailable';
    await f.wrapper.get('[data-testid="live-start"]').trigger('click');
    await flushPromises();
    expect(f.wrapper.get('[data-testid="live-images"]').attributes('disabled')).toBeDefined();
    expect(f.wrapper.get('[data-testid="live-record"]').attributes('disabled')).toBeUndefined();
  });
});
