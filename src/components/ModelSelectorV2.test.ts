import { beforeEach, afterEach, expect, expectTypeOf, it, vi } from 'vitest';
import { DOMWrapper, mount, type ComponentMountingOptions } from '@vue/test-utils';
import { defineComponent, h, nextTick, ref } from 'vue';
import { ensureAllStringsForTest } from '@/strings/utils.test-support';
import ModelSelectorV2, { type ModelSelectorV2Model } from './ModelSelectorV2.vue';

const mocks = vi.hoisted(() => ({ useSettings: vi.fn() }));
vi.mock('@/composables/useSettings', () => ({ useSettings: mocks.useSettings }));
const externalFetch = vi.fn<typeof fetch>();
type Props = InstanceType<typeof ModelSelectorV2>['$props'];

const models: readonly ModelSelectorV2Model[] = [
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

function fixture({ props, slots }: { props: Partial<Props>, slots: ComponentMountingOptions<typeof ModelSelectorV2>['slots'] | undefined }) {
  const host = document.createElement('div');
  document.body.append(host);
  const wrapper = mount(ModelSelectorV2, { props: { modelValue: undefined, models, ...props }, slots, attachTo: host });
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

it('requires supplied models and filters their identifiers, labels and descriptions without fetching', async () => {
  expectTypeOf<Pick<Props, 'models'>>().toExtend<{ models: readonly ModelSelectorV2Model[] }>();
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

it.each(['close', 'Escape'] as const)('closes explicitly through %s and restores trigger focus', async action => {
  using value = fixture({ props: {}, slots: undefined });
  await value.open();
  if (action === 'close') {
    await value.get({ testId: 'model-selector-dropdown' }).get('button[aria-label="Close"]').trigger('click');
  } else {
    keydown({ target: value.get({ testId: 'model-selector-filter' }).element, key: 'Escape', isComposing: false });
    await nextTick();
  }
  expect(document.body.querySelector('[data-testid="model-selector-dropdown"]')).toBeNull();
  expect(document.activeElement).toBe(value.wrapper.get('[data-testid="model-selector-trigger"]').element);
});

it('keeps the open selection UI through outside pointer, focus, drag and resize events', async () => {
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
  const sources = value.get({ testId: 'model-selector-v2-open-sources' });
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
