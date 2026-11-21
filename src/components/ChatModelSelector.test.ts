import { beforeEach, afterEach, expect, expectTypeOf, it, vi } from 'vitest';
import { DOMWrapper, mount, type ComponentMountingOptions } from '@vue/test-utils';
import { defineComponent, h, nextTick, ref } from 'vue';
import { ensureAllStringsForTest } from '@/strings/utils.test-support';
import ChatModelSelector from './ChatModelSelector.vue';
import type { ModelSelectorItem } from './model-selector-item';

const mocks = vi.hoisted(() => ({ useSettings: vi.fn() }));
vi.mock('@/composables/useSettings', () => ({ useSettings: mocks.useSettings }));
const externalFetch = vi.fn<typeof fetch>();
type Props = InstanceType<typeof ChatModelSelector>['$props'];

const models: readonly ModelSelectorItem[] = [
  { id: 'catalog/qwen', label: 'Qwen speech', description: 'Japanese recognition', availability: 'download_required' },
  { id: 'stored/parakeet', label: 'Local Parakeet', description: 'English recognition', availability: 'local' },
];

beforeEach(async () => {
  await ensureAllStringsForTest({ locale: 'en' });
  mocks.useSettings.mockReset().mockImplementation(() => {
    throw new Error('The supplied model selector must not initialize chat settings');
  });
  externalFetch.mockReset().mockRejectedValue(new Error('Unexpected external request'));
  vi.stubGlobal('fetch', externalFetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function fixture({ props, slots }: { props: Partial<Props>, slots: ComponentMountingOptions<typeof ChatModelSelector>['slots'] | undefined }) {
  const host = document.createElement('div');
  document.body.append(host);
  const wrapper = mount(ChatModelSelector, { props: { modelValue: undefined, models, ...props }, slots, attachTo: host });
  return {
    wrapper,
    get({ testId }: { testId: string }) {
      const element = document.body.querySelector(`[data-testid="${testId}"]`);
      if (element === null) {
        throw new Error(`Missing selector element: ${testId}`);
      }
      return new DOMWrapper(element);
    },
    async open(): Promise<void> {
      await wrapper.get('[data-testid="model-selector-trigger"]').trigger('click');
      await nextTick();
    },
    options(): string[] {
      return Array.from(document.body.querySelectorAll('[data-testid="model-selector-option"]'), element => element.getAttribute('title') ?? '');
    },
    panelButton({ label }: { label: string }) {
      const element = Array.from(document.body.querySelectorAll<HTMLButtonElement>('[data-testid="model-selector-dropdown"] [role="group"] button')).find(button => button.textContent === label);
      if (element === undefined) {
        throw new Error(`Missing selector panel: ${label}`);
      }
      return new DOMWrapper(element);
    },
    [Symbol.dispose]() {
      wrapper.unmount();
      host.remove();
    },
  };
}

function keydown({ target, key, isComposing }: { target: Element, key: string, isComposing: boolean }): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key, isComposing, bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  return event;
}

it.each([
  { surface: 'composer', triggerLeft: 720, popupLeft: 510 },
  { surface: 'composer', triggerLeft: 1300, popupLeft: 864 },
  { surface: 'composer', triggerLeft: 24, popupLeft: 16 },
  { surface: 'sidebar', triggerLeft: 720, popupLeft: 720 },
] as const)('positions the $surface popup at $popupLeft with the trigger at $triggerLeft', async ({ surface, triggerLeft, popupLeft }) => {
  vi.stubGlobal('innerWidth', 1440);
  vi.stubGlobal('innerHeight', 900);
  vi.stubGlobal('visualViewport', undefined);
  const bounds = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(triggerLeft, 780, 140, 36));
  using restoreBounds = { [Symbol.dispose]: () => bounds.mockRestore() };
  void restoreBounds;
  using value = fixture({ props: { surface }, slots: undefined });
  await value.open();
  const popup = value.get({ testId: 'model-selector-dropdown' }).element as HTMLDialogElement;
  expect(popup.style.left).toBe(`${popupLeft}px`);
  expect(popup.style.width).toBe('560px');
  expect(popup.style.maxHeight).toBe('756px');
});

it('requires supplied models and filters their identifiers, labels and descriptions without fetching', async () => {
  expectTypeOf<Pick<Props, 'models'>>().toExtend<{ models: readonly ModelSelectorItem[] }>();
  using value = fixture({ props: {}, slots: undefined });
  await value.open();
  expect(value.options()).toEqual(['Qwen speech', 'Local Parakeet']);
  await value.get({ testId: 'model-selector-filter' }).setValue('JAPANESE qwen');
  expect(value.options()).toEqual(['Qwen speech']);
  await value.get({ testId: 'model-selector-filter' }).setValue('stored');
  expect(value.options()).toEqual(['Local Parakeet']);
  await value.wrapper.setProps({ models: [] });
  await value.get({ testId: 'model-selector-filter' }).setValue('');
  expect(value.options()).toEqual([]);
  expect(value.wrapper.emitted('refresh')).toBeUndefined();
  expect(mocks.useSettings).not.toHaveBeenCalled();
  expect(externalFetch).not.toHaveBeenCalled();
});

it('emits controlled query edits and follows the supplied value rather than an unaccepted local edit', async () => {
  using value = fixture({ props: { query: 'Japanese' }, slots: undefined });
  await value.open();
  expect(value.options()).toEqual(['Qwen speech']);
  await value.get({ testId: 'model-selector-filter' }).setValue('English');
  expect(value.wrapper.emitted('update:query')?.at(-1)).toEqual(['English']);
  expect(value.options()).toEqual(['Qwen speech']);
  await value.wrapper.setProps({ query: 'English' });
  expect(value.options()).toEqual(['Local Parakeet']);
  expect(externalFetch).not.toHaveBeenCalled();
});

it('refreshes only through an explicit event and respects the loading gate', async () => {
  using value = fixture({ props: {}, slots: undefined });
  await value.open();
  await value.get({ testId: 'model-selector-refresh' }).trigger('click');
  expect(value.wrapper.emitted('refresh')).toEqual([[]]);
  await value.wrapper.setProps({ loading: true });
  await value.get({ testId: 'model-selector-refresh' }).trigger('click');
  expect(value.wrapper.emitted('refresh')).toEqual([[]]);
  expect(mocks.useSettings).not.toHaveBeenCalled();
  expect(externalFetch).not.toHaveBeenCalled();
});

it('keeps Tab navigation available and lets a native panel button activate without selecting a model', async () => {
  using value = fixture({ props: { panels: [{ id: 'hugging-face', label: 'Hugging Face' }], surface: 'composer' }, slots: { panel: '<input data-testid="hf-query" />' } });
  await value.open();
  const tab = keydown({ target: value.get({ testId: 'model-selector-filter' }).element, key: 'Tab', isComposing: false });
  expect(tab.defaultPrevented).toBe(false);
  expect(value.get({ testId: 'model-selector-dropdown' }).exists()).toBe(true);
  const panel = value.panelButton({ label: 'Hugging Face' });
  panel.element.focus();
  const enter = keydown({ target: panel.element, key: 'Enter', isComposing: false });
  expect(enter.defaultPrevented).toBe(false);
  // jsdom does not synthesize a native button click from Enter.
  await panel.trigger('click');
  expect(value.get({ testId: 'hf-query' }).isVisible()).toBe(true);
  expect(value.wrapper.emitted('update:modelValue')).toBeUndefined();
});

it('opens directly on Models without moving the indicator and animates only a tab change in the open popup', async () => {
  using value = fixture({
    props: {
      panels: [
        { id: 'chat-candidates', label: 'Chat candidates', placement: 'before-models' },
        { id: 'hugging-face', label: 'Hugging Face' },
      ],
    },
    slots: undefined,
  });
  const indicator = () => value.get({ testId: 'chat-model-selector-tab-indicator' });
  const moving = 'chat-model-selector-tab-indicator-moving';
  await value.open();
  expect(value.panelButton({ label: 'Models' }).attributes('aria-pressed')).toBe('true');
  expect(indicator().classes()).not.toContain(moving);
  await value.panelButton({ label: 'Chat candidates' }).trigger('click');
  expect(value.panelButton({ label: 'Chat candidates' }).attributes('aria-pressed')).toBe('true');
  expect(indicator().classes()).toContain(moving);
  await value.wrapper.get('[data-testid="model-selector-trigger"]').trigger('click');
  await value.open();
  expect(value.panelButton({ label: 'Models' }).attributes('aria-pressed')).toBe('true');
  expect(indicator().classes()).not.toContain(moving);
});

it('opens the requested candidate tab without moving the underline on entry', async () => {
  using value = fixture({
    props: { initialPanel: 'chat-candidates', panels: [{ id: 'chat-candidates', label: 'Chat candidates', placement: 'before-models' }] },
    slots: { panel: '<p data-testid="chat-candidates-panel">Candidates</p>' },
  });
  await value.open();
  expect(value.panelButton({ label: 'Chat candidates' }).attributes('aria-pressed')).toBe('true');
  expect(value.get({ testId: 'chat-candidates-panel' }).isVisible()).toBe(true);
  expect(value.get({ testId: 'chat-model-selector-tab-indicator' }).classes()).not.toContain('chat-model-selector-tab-indicator-moving');
  expect(externalFetch).not.toHaveBeenCalled();
});

it.each(['//text', '//projector/vision%2Fmmproj-F16.gguf'])('keeps the model name readable when its reference includes %s', async configuration => {
  const baseId = 'hf.co/owner/Gemma-GGUF:Q4_K_M';
  const modelId = baseId + configuration;
  using value = fixture({ props: { modelValue: modelId, models: [{ id: baseId, label: baseId, description: undefined, availability: 'local' }] }, slots: undefined });
  const trigger = value.wrapper.get('[data-testid="model-selector-trigger"]');
  expect(trigger.text()).toContain('Gemma-GGUF:Q4_K_M');
  expect(trigger.text()).not.toContain('mmproj');
  expect(trigger.attributes('title')).toBe(modelId);
  await value.open();
  const row = value.get({ testId: 'model-selector-option' });
  expect(row.attributes('aria-pressed')).toBe('true');
  await row.trigger('click');
  expect(value.wrapper.emitted('update:modelValue')?.[0]).toEqual([modelId]);
});

it('keeps the first-use hint visible until the download starts and omits progress from the closed selector', async () => {
  using value = fixture({ props: { modelValue: 'catalog/qwen' }, slots: undefined });
  expect(value.wrapper.find('[data-testid="chat-model-selector-download-hint"]').exists()).toBe(true);
  await value.wrapper.setProps({ hideFirstUseDownloadHint: true });
  expect(value.wrapper.find('[data-testid="chat-model-selector-download-hint"]').exists()).toBe(false);
  expect(value.wrapper.get('[data-testid="model-selector-trigger"]').text()).toBe('Qwen speech');
});

it('groups saved quantizations and preserves the active exact configuration on keyboard selection', async () => {
  const ids = ['hf.co/owner/Model-GGUF:Q4_K_M', 'hf.co/owner/Model-GGUF:Q8_0', 'host/Other/owner/Model-GGUF:Q8_0', 'hf.co/owner/Model-GGUF:Custom-Q8_0'];
  const configured = ids[1] + '//text';
  using value = fixture({ props: { modelValue: configured, models: ids.map(id => ({ id, label: id, description: undefined, availability: 'local' })) }, slots: undefined });
  await value.open();
  const group = value.get({ testId: 'model-selector-stored-variant-group' });
  expect(group.attributes('aria-expanded')).toBe('false');
  expect(value.options()).toEqual(ids.slice(2));
  const filter = value.get({ testId: 'model-selector-filter' });
  keydown({ target: filter.element, key: 'Enter', isComposing: false });
  await nextTick();
  expect(group.attributes('aria-expanded')).toBe('true');
  expect(value.options()).toEqual([ids[0], configured, ...ids.slice(2)]);
  expect(value.wrapper.emitted('update:modelValue')).toBeUndefined();
  keydown({ target: filter.element, key: 'ArrowDown', isComposing: false });
  keydown({ target: filter.element, key: 'ArrowDown', isComposing: false });
  keydown({ target: filter.element, key: 'Enter', isComposing: false });
  expect(value.wrapper.emitted('update:modelValue')).toEqual([[configured]]);
});

it('keeps custom panel input and component state while switching between peer panels', async () => {
  const CustomPanel = defineComponent({
    setup() {
      const query = ref('');
      return () => h('input', {
        'data-testid': 'hf-query',
        value: query.value,
        onInput(event: Event) {
          if (event.target instanceof HTMLInputElement) {
            query.value = event.target.value;
          }
        },
      });
    },
  });
  using value = fixture({ props: { panels: [{ id: 'hugging-face', label: 'Hugging Face' }] }, slots: { panel: () => h(CustomPanel) } });
  await value.open();
  await value.panelButton({ label: 'Hugging Face' }).trigger('click');
  const query = value.get({ testId: 'hf-query' });
  await query.setValue('user/repository');
  const enter = keydown({ target: query.element, key: 'Enter', isComposing: false });
  expect(enter.defaultPrevented).toBe(false);
  expect(value.wrapper.emitted('update:modelValue')).toBeUndefined();
  await value.panelButton({ label: 'Models' }).trigger('click');
  expect(query.isVisible()).toBe(false);
  expect(query.element.closest('[inert]')?.getAttribute('aria-hidden')).toBe('true');
  await value.panelButton({ label: 'Hugging Face' }).trigger('click');
  const returned = value.get({ testId: 'hf-query' });
  expect(returned.element).toBe(query.element);
  expect(returned.element).toHaveProperty('value', 'user/repository');
  expect(returned.isVisible()).toBe(true);
  const composing = keydown({ target: returned.element, key: 'Escape', isComposing: true });
  expect(composing.defaultPrevented).toBe(false);
  expect(returned.isVisible()).toBe(true);
  keydown({ target: returned.element, key: 'Escape', isComposing: false });
  await nextTick();
  expect(document.body.querySelector('[data-testid="model-selector-dropdown"]')).toBeNull();
  expect(document.activeElement).toBe(value.wrapper.get('[data-testid="model-selector-trigger"]').element);
});

it.each(['trigger', 'Escape'] as const)('closes explicitly through %s and restores trigger focus', async action => {
  using value = fixture({ props: {}, slots: undefined });
  await value.open();
  if (action === 'trigger') {
    await value.wrapper.get('[data-testid="model-selector-trigger"]').trigger('click');
  } else {
    keydown({ target: value.get({ testId: 'model-selector-filter' }).element, key: 'Escape', isComposing: false });
    await nextTick();
  }
  expect(document.body.querySelector('[data-testid="model-selector-dropdown"]')).toBeNull();
  expect(document.activeElement).toBe(value.wrapper.get('[data-testid="model-selector-trigger"]').element);
});

it('keeps the popup through drag and resize and dismisses it on outside pointer down', async () => {
  using value = fixture({ props: {}, slots: { sources: '<input type="file" data-testid="model-file-input" />' } });
  const outside = document.createElement('button');
  const originalWidth = Object.getOwnPropertyDescriptor(window, 'innerWidth');
  if (originalWidth === undefined) {
    throw new Error('The DOM test environment must provide a viewport width');
  }
  document.body.append(outside);
  using cleanup = {
    [Symbol.dispose]() {
      outside.remove();
      Object.defineProperty(window, 'innerWidth', originalWidth);
    },
  };
  await value.open();
  outside.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
  outside.focus();
  outside.dispatchEvent(new Event('dragenter', { bubbles: true }));
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: window.innerWidth - 100 });
  window.dispatchEvent(new Event('resize'));
  await nextTick();
  expect(value.get({ testId: 'model-selector-dropdown' }).exists()).toBe(true);
  const sources = value.get({ testId: 'chat-model-selector-open-sources' });
  const enter = keydown({ target: sources.element, key: 'Enter', isComposing: false });
  expect(enter.defaultPrevented).toBe(false);
  await sources.trigger('click');
  outside.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
  outside.focus();
  await nextTick();
  expect(value.get({ testId: 'model-file-input' }).isVisible()).toBe(true);
  expect(value.wrapper.emitted('update:modelValue')).toBeUndefined();
  keydown({ target: value.get({ testId: 'model-file-input' }).element, key: 'Escape', isComposing: false });
  await nextTick();
  expect(document.body.querySelector('[data-testid="model-selector-dropdown"]')).toBeNull();
  expect(document.activeElement).toBe(value.wrapper.get('[data-testid="model-selector-trigger"]').element);
  await value.open();
  outside.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
  await nextTick();
  expect(document.body.querySelector('[data-testid="model-selector-dropdown"]')).toBeNull();
  void cleanup;
});

it('keeps row actions independent while clicking the model name selects and closes', async () => {
  const rowAction = vi.fn();
  using value = fixture({
    props: {},
    slots: { 'model-action': ({ id }: { id: string }) => h('button', { type: 'button', 'data-testid': `action-${id}`, onClick: () => rowAction({ id }) }, 'Details') },
  });
  await value.open();
  const action = value.get({ testId: 'action-catalog/qwen' });
  const enter = keydown({ target: action.element, key: 'Enter', isComposing: false });
  expect(enter.defaultPrevented).toBe(false);
  await action.trigger('click');
  expect(rowAction).toHaveBeenCalledExactlyOnceWith({ id: 'catalog/qwen' });
  expect(value.wrapper.emitted('update:modelValue')).toBeUndefined();
  const name = value.get({ testId: 'model-selector-option-name' });
  await name.trigger('click');
  expect(value.wrapper.emitted('update:modelValue')).toEqual([['catalog/qwen']]);
  expect(document.body.querySelector('[data-testid="model-selector-dropdown"]')).toBeNull();
});
