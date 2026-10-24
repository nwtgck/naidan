import { beforeEach, expect, it, vi } from 'vitest';
import { computed, shallowRef } from 'vue';
import { DOMWrapper, flushPromises, mount } from '@vue/test-utils';
import { ensureAllStringsForTest } from '@/strings/utils.test-support';
import type { ChatLocalModelOperation, ChatLocalModelUi } from '@/composables/chat/chat-scoped/useChatLocalModel';
import ChatModelRecovery from './ChatModelRecovery.vue';
import type { ChatModelRecoveryNotice } from './ChatModelRecoverySummary.vue';

const picker = vi.hoisted(() => ({ mounts: 0 }));
vi.mock('@/features/llama-cpp-browser/components/ChatLocalModelInput.vue', () => ({
  __esModule: true,
  default: {
    name: 'ChatLocalModelInput',
    props: ['state', 'expansion', 'availability', 'layout', 'sourceTabsHost', 'scrollMode'],
    setup() {
      picker.mounts++;
    },
    template: '<div data-testid="embedded-picker"><button data-testid="picker-use" @click="state.useModel({ model: { modelId: \'user/chosen\', size: 1, importedAt: 1 } })">Use</button><button @click="state.cancel()">Cancel</button></div>',
  },
}));
vi.mock('@/composables/chat/ui/useChatModelRecoveryLayout', () => ({
  useChatModelRecoveryLayout: () => ({
    layout: computed(() => ({ left: 24, bottom: 120, width: 700, compactHeight: 100, expandedHeight: 600 })),
    scrollMode: computed(() => 'source'),
    measure: vi.fn(),
  }),
}));

beforeEach(async () => {
  picker.mounts = 0;
  await ensureAllStringsForTest({ locale: 'en' });
});

function render({ notice }: { notice: ChatModelRecoveryNotice | undefined }) {
  const host = document.createElement('div');
  const anchorHost = document.createElement('div');
  const overlayRoot = document.createElement('div');
  host.append(anchorHost, overlayRoot);
  document.body.append(host);
  const operation = shallowRef<ChatLocalModelOperation>();
  const state = {
    operation: computed(() => operation.value),
    downloadJob: computed(() => undefined),
    useModel: vi.fn(async () => {}),
    useRepositoryModel: vi.fn(async () => {}),
    pauseDownload: vi.fn(),
    maySend: computed(() => operation.value === undefined),
    accept: vi.fn(async () => {}),
    choose: vi.fn(async () => {}),
    retry: vi.fn(async () => {}),
    cancel: vi.fn(async () => {}),
    TEST_ONLY: {},
  } satisfies ChatLocalModelUi;
  const wrapper = mount(ChatModelRecovery, {
    props: {
      notice,
      state,
      expansion: 'closed',
      availability: 'available',
      presentation: 'visible',
      placement: { overlayRoot, anchorHost, anchorViewport: anchorHost, anchorClip: anchorHost, messageViewport: host },
    },
    attachTo: host,
  });
  return {
    wrapper,
    state,
    operation,
    root: new DOMWrapper(overlayRoot),
    anchor: new DOMWrapper(anchorHost),
    [Symbol.dispose]() {
      wrapper.unmount();
      host.remove();
    },
  };
}

it.each([
  'temp/LiquidAI_LFM2.5-VL-3B-GGUF',
  'hf.co/owner/LFM2.5-VL-3B-GGUF:Q4_K_M',
  'host/MyModels1/owner/LFM2.5-VL-3B-GGUF:Q8_0',
  'hf.co/owner/Model:Q%20A', 'hf.co/owner/Model:Q%2FA', 'hf.co/owner/Model:%invalid',
])('keeps the complete literal model ID readable: %s', modelId => {
  using view = render({ notice: { reason: 'missing-files', connection: 'browser', modelId } });
  const name = view.root.get('[data-testid="model-recovery-name"]');
  expect(name.text()).toBe(modelId);
  expect(name.classes()).not.toContain('truncate');
  expect(view.root.text()).toContain('Model not found');
  expect(view.anchor.text()).toContain(modelId);
  expect(view.anchor.get('[data-testid="model-recovery-footprint"]').attributes('aria-hidden')).toBe('true');
  expect(view.anchor.find('button').exists()).toBe(false);
});

it('keeps one frame, header, trigger and closed footprint while expanding the existing picker', async () => {
  const modelId = 'temp/original:Q4_K_M';
  using view = render({ notice: { reason: 'missing-files', connection: 'browser', modelId } });
  const frame = view.root.get('[data-testid="model-recovery"]');
  const heading = frame.get('h3').element;
  const trigger = frame.get('[data-testid="model-recovery-select"]');
  const footprint = view.anchor.element.innerHTML;
  expect(picker.mounts).toBe(0);
  await trigger.trigger('click');
  await vi.dynamicImportSettled();
  await flushPromises();
  expect(view.root.get('[data-testid="model-recovery"]').element).toBe(frame.element);
  expect(frame.get('h3').element).toBe(heading);
  expect(frame.get('[data-testid="model-recovery-select"]').element).toBe(trigger.element);
  expect(trigger.attributes('aria-expanded')).toBe('true');
  expect(frame.get('h3').text()).toBe('Model for this chat');
  expect(frame.find('[data-testid="model-recovery-name"]').exists()).toBe(false);
  expect(view.anchor.element.innerHTML).toBe(footprint);
  expect(picker.mounts).toBe(1);
  expect(view.wrapper.getComponent({ name: 'ChatLocalModelInput' }).props()).toMatchObject({ layout: 'embedded', expansion: 'open' });
  await view.root.get('[data-testid="picker-use"]').trigger('click');
  expect(view.state.useModel).toHaveBeenCalledWith({ model: expect.objectContaining({ modelId: 'user/chosen' }) });
  await trigger.trigger('click');
  expect(frame.get('[data-testid="model-recovery-name"]').text()).toBe(modelId);
  expect(trigger.attributes('aria-expanded')).toBe('false');
  expect(view.root.get(`#${trigger.attributes('aria-controls')}`).attributes('inert')).toBeDefined();
  await trigger.trigger('click');
  expect(picker.mounts).toBe(1);
  expect(view.state.cancel).not.toHaveBeenCalled();
});

it('lets Escape return focus without trapping the composer or stealing a handled Escape', async () => {
  using view = render({ notice: { reason: 'unconfigured', connection: 'server', modelId: undefined } });
  const trigger = view.root.get<HTMLButtonElement>('[data-testid="model-recovery-select"]');
  await trigger.trigger('click');
  const frame = view.root.get('[data-testid="model-recovery"]');
  const handled = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
  handled.preventDefault();
  frame.element.dispatchEvent(handled);
  expect(trigger.attributes('aria-expanded')).toBe('true');
  await frame.trigger('keydown', { key: 'Escape' });
  await flushPromises();
  expect(trigger.attributes('aria-expanded')).toBe('false');
  expect(document.activeElement).toBe(trigger.element);
  expect(frame.attributes('aria-modal')).toBeUndefined();
});

it('rechecks unreadable storage without asserting the model is missing or fetching a model', async () => {
  using view = render({ notice: { reason: 'unreadable', connection: 'browser', modelId: 'user/original' } });
  expect(view.root.text()).toContain('Could not check the model');
  expect(view.root.text()).not.toContain('Model not found');
  await view.root.get('[data-testid="model-recovery-recheck"]').trigger('click');
  expect(view.wrapper.emitted('recheck')).toEqual([[]]);
  expect(view.state.accept).not.toHaveBeenCalled();
  expect(view.state.useModel).not.toHaveBeenCalled();
  expect(view.state.useRepositoryModel).not.toHaveBeenCalled();
});

it('never resurrects a previous missing model after settings change or an operation ends', async () => {
  using view = render({ notice: { reason: 'missing-files', connection: 'browser', modelId: 'temp/old' } });
  await view.root.get('[data-testid="model-recovery-select"]').trigger('click');
  view.operation.value = { id: 1, phase: 'reading', model: undefined, error: undefined, downloadJobId: undefined, candidates: [] };
  await view.wrapper.setProps({ notice: undefined });
  expect(view.root.get('[data-testid="model-recovery"]').isVisible()).toBe(true);
  await view.root.get('[data-testid="model-recovery-select"]').trigger('click');
  expect(view.root.text()).toContain('Preparing the model');
  expect(view.root.text()).not.toContain('temp/old');
  view.operation.value = undefined;
  await flushPromises();
  expect(view.root.get('[data-testid="model-recovery"]').isVisible()).toBe(false);
  await view.wrapper.setProps({ notice: { reason: 'unconfigured', connection: 'server', modelId: undefined } });
  expect(view.root.get('[data-testid="model-recovery-select"]').attributes('aria-expanded')).toBe('false');
  expect(view.root.text()).not.toContain('temp/old');
});

it('suppresses and closes the inline region for higher-priority UI without cancelling work', async () => {
  using view = render({ notice: { reason: 'unconfigured', connection: 'server', modelId: 'remote' } });
  await view.root.get('[data-testid="model-recovery-select"]').trigger('click');
  await view.wrapper.setProps({ presentation: 'suppressed' });
  expect(view.root.get('[data-testid="model-recovery"]').isVisible()).toBe(false);
  expect(view.root.get('[data-testid="model-recovery"]').attributes('inert')).toBeDefined();
  expect(view.anchor.get('[data-testid="model-recovery-footprint"]').isVisible()).toBe(false);
  await view.wrapper.setProps({ presentation: 'visible' });
  expect(view.root.get('[data-testid="model-recovery-select"]').attributes('aria-expanded')).toBe('false');
  expect(view.state.cancel).not.toHaveBeenCalled();
});

it('opens through the compact surface or explicit action without toggling again through bubbling', async () => {
  using view = render({ notice: { reason: 'missing-files', connection: 'browser', modelId: 'temp/model' } });
  const frame = view.root.get('[data-testid="model-recovery"]');
  const trigger = frame.get('[data-testid="model-recovery-select"]');
  await frame.trigger('click');
  expect(trigger.attributes('aria-expanded')).toBe('true');
  await frame.trigger('click');
  expect(trigger.attributes('aria-expanded')).toBe('true');
  await trigger.trigger('click');
  expect(trigger.attributes('aria-expanded')).toBe('false');
  await frame.get('[data-testid="model-recovery-recheck"]').trigger('click');
  expect(view.wrapper.emitted('recheck')).toEqual([[]]);
  expect(trigger.attributes('aria-expanded')).toBe('false');
  await trigger.trigger('click');
  expect(trigger.attributes('aria-expanded')).toBe('true');
  expect(frame.attributes('tabindex')).toBeUndefined();
  expect(frame.attributes('role')).not.toBe('button');
});

it('allows selecting the complete model ID without activating the compact surface', async () => {
  using view = render({ notice: { reason: 'missing-files', connection: 'browser', modelId: 'temp/selected-text' } });
  const model = view.root.get('[data-testid="model-recovery-name"]');
  const range = document.createRange();
  range.selectNodeContents(model.element);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
  await model.trigger('click');
  expect(view.root.get('[data-testid="model-recovery-select"]').attributes('aria-expanded')).toBe('false');
  selection?.removeAllRanges();
});
