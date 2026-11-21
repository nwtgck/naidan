import { beforeEach, afterEach, expect, expectTypeOf, it, vi } from 'vitest';
import { DOMWrapper, flushPromises, mount, type ComponentMountingOptions } from '@vue/test-utils';
import { defineComponent, h, nextTick, ref } from 'vue';
import { ensureAllStringsForTest } from '@/strings/utils.test-support';
import { useFileExplorerModal } from '@/features/file-explorer/composables/useFileExplorerModal';
import ModelSelector from './ModelSelector.vue';
import ReasoningSettings from './ReasoningSettings.vue';
import type { ModelSelectorItem } from './model-selector-item';

const mocks = vi.hoisted(() => ({ useSettings: vi.fn() }));
vi.mock('@/composables/useSettings', () => ({ useSettings: mocks.useSettings }));
const externalFetch = vi.fn<typeof fetch>();
type Props = InstanceType<typeof ModelSelector>['$props'];

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

function fixture({ props, slots }: { props: Partial<Props>, slots: ComponentMountingOptions<typeof ModelSelector>['slots'] | undefined }) {
  const host = document.createElement('div');
  document.body.append(host);
  const wrapper = mount(ModelSelector, { props: { modelValue: undefined, models, ...props }, slots, attachTo: host });
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
  using value = fixture({ props: { surface: 'sidebar', modelValue: 'stored/parakeet' }, slots: { 'trigger-label': 'Default model' } });
  await value.open();
  const refresh = value.get({ testId: 'model-selector-refresh' });
  for (const key of ['Enter', ' ', 'ArrowDown']) {
    expect(keydown({ target: refresh.element, key, isComposing: false }).defaultPrevented).toBe(false);
  }
  expect(value.wrapper.emitted('update:modelValue')).toBeUndefined();
  await refresh.trigger('click');
  expect(value.wrapper.emitted('refresh')).toEqual([[]]);
  const filter = value.get({ testId: 'model-selector-filter' });
  await filter.setValue('Japanese');
  await value.get({ testId: 'model-selector-clear-filter' }).trigger('click');
  expect((filter.element as HTMLInputElement).value).toBe('');
  expect(document.activeElement).toBe(filter.element);
  await value.wrapper.setProps({ loading: true });
  const trigger = value.get({ testId: 'model-selector-trigger' });
  expect(trigger.attributes('aria-busy')).toBe('true');
  expect(trigger.attributes('title')).toBe('stored/parakeet');
  expect(trigger.text()).toContain('Default model');
  expect(trigger.text()).toContain('Local Parakeet');
  await value.get({ testId: 'model-selector-refresh' }).trigger('click');
  expect(value.wrapper.emitted('refresh')).toEqual([[]]);
  expect(mocks.useSettings).not.toHaveBeenCalled();
  expect(externalFetch).not.toHaveBeenCalled();
});

it('distinguishes loading, an empty sidebar inventory, and unmatched filtering', async () => {
  using value = fixture({ props: { surface: 'sidebar', models: [], loading: true }, slots: undefined });
  await value.open();
  expect(value.get({ testId: 'model-selector-empty' }).text()).toBe('Loading models…');
  await value.wrapper.setProps({ loading: false });
  expect(value.get({ testId: 'model-selector-empty' }).text()).toBe('No models available');
  await value.wrapper.setProps({ models });
  await value.get({ testId: 'model-selector-filter' }).setValue('missing model');
  expect(value.get({ testId: 'model-selector-empty' }).text()).toBe('No models found');
});

it.each([false, true])('exposes a clear choice only when allowed (%s)', async allowClear => {
  using value = fixture({ props: { modelValue: 'catalog/qwen', allowClear, clearLabel: 'Use default' }, slots: undefined });
  await value.open();
  const dropdown = value.get({ testId: 'model-selector-dropdown' });
  const clear = dropdown.find('[data-testid="model-selector-clear"]');
  expect(clear.exists()).toBe(allowClear);
  if (allowClear) {
    expect(clear.text()).toBe('Use default');
    await clear.trigger('click');
    expect(value.wrapper.emitted('update:modelValue')).toEqual([[undefined]]);
  }
});

it('describes a plain model with its optional trigger detail', () => {
  using value = fixture({ props: { modelValue: 'model-a', surface: 'composer' }, slots: { 'trigger-detail': '<span>Think High</span>' } });
  const trigger = value.get({ testId: 'model-selector-trigger' });
  const detail = trigger.get('[data-testid="model-selector-trigger-metadata"]');
  expect(trigger.text()).toContain('model-a');
  expect(detail.text()).toBe('Think High');
  expect(detail.get('[id]').attributes('id')).toBe(trigger.attributes('aria-describedby'));
});

it.each(['floating', 'inline'] as const)('opens and selects with the keyboard in %s mode', async popupPresentation => {
  using value = fixture({ props: { modelValue: 'catalog/qwen', popupPresentation }, slots: undefined });
  const trigger = value.get({ testId: 'model-selector-trigger' });
  keydown({ target: trigger.element, key: 'ArrowDown', isComposing: false });
  await nextTick();
  const dropdown = value.get({ testId: 'model-selector-dropdown' });
  const filter = value.get({ testId: 'model-selector-filter' });
  expect(value.wrapper.element.contains(dropdown.element)).toBe(popupPresentation === 'inline');
  expect(document.activeElement).toBe(filter.element);
  keydown({ target: filter.element, key: 'ArrowUp', isComposing: false });
  keydown({ target: filter.element, key: 'Enter', isComposing: true });
  expect(value.wrapper.emitted('update:modelValue')).toBeUndefined();
  keydown({ target: filter.element, key: 'Enter', isComposing: false });
  await nextTick();
  expect(value.wrapper.emitted('update:modelValue')).toEqual([['stored/parakeet']]);
  expect(document.activeElement).toBe(trigger.element);

  await value.open();
  const reopenedFilter = value.get({ testId: 'model-selector-filter' });
  keydown({ target: reopenedFilter.element, key: 'ArrowDown', isComposing: false });
  await reopenedFilter.setValue('recognition');
  keydown({ target: reopenedFilter.element, key: 'Enter', isComposing: false });
  expect(value.wrapper.emitted('update:modelValue')?.at(-1)).toEqual(['catalog/qwen']);
});

it('closes an inline picker on Escape before its enclosing dialog receives the key', async () => {
  using value = fixture({ props: { popupPresentation: 'inline', surface: 'settings' }, slots: undefined });
  const trigger = value.get({ testId: 'model-selector-trigger' });
  const host = value.wrapper.element.parentElement!;
  const escape = vi.fn();
  host.addEventListener('keydown', escape);
  await value.open();
  const filter = value.get({ testId: 'model-selector-filter' });
  const tab = keydown({ target: filter.element, key: 'Tab', isComposing: false });
  expect(tab.defaultPrevented).toBe(false);
  expect(escape).toHaveBeenCalledWith(tab);
  escape.mockClear();
  keydown({ target: filter.element, key: 'Escape', isComposing: false });
  await nextTick();
  expect(escape).not.toHaveBeenCalled();
  expect(document.activeElement).toBe(trigger.element);
  keydown({ target: trigger.element, key: 'Escape', isComposing: false });
  expect(escape).toHaveBeenCalledOnce();
});

it('closes a disabled picker and ignores a stale option click', async () => {
  using value = fixture({ props: {}, slots: undefined });
  await value.open();
  const option = value.get({ testId: 'model-selector-option' });
  await value.wrapper.setProps({ disabled: true });
  await option.trigger('click');
  expect(document.querySelector('[data-testid="model-selector-dropdown"]')).toBeNull();
  expect(value.wrapper.emitted('update:modelValue')).toBeUndefined();
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
  const indicator = () => value.get({ testId: 'model-selector-tab-indicator' });
  const moving = 'model-selector-tab-indicator-moving';
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
  expect(value.get({ testId: 'model-selector-tab-indicator' }).classes()).not.toContain('model-selector-tab-indicator-moving');
  expect(externalFetch).not.toHaveBeenCalled();
});

it('keeps chat settings visible in the same footer on every tab', async () => {
  const panels = [
    { id: 'chat-candidates', label: 'Chat candidates', placement: 'before-models' },
    { id: 'hugging-face', label: 'Hugging Face' },
    { id: 'files', label: 'Add files' },
  ] as const;
  using value = fixture({ props: { surface: 'composer', initialPanel: 'chat-candidates', panels }, slots: { settings: '<button type="button">Thinking</button>' } });
  await value.open();
  expect(value.panelButton({ label: 'Chat candidates' }).attributes('aria-pressed')).toBe('true');
  const footer = value.get({ testId: 'model-selector-settings' });
  expect(footer.isVisible()).toBe(true);
  for (const label of ['Models', ...panels.map(panel => panel.label)]) {
    await value.panelButton({ label }).trigger('click');
    expect(value.panelButton({ label }).attributes('aria-pressed')).toBe('true');
    const visibleFooter = value.get({ testId: 'model-selector-settings' });
    expect(visibleFooter.element).toBe(footer.element);
    expect(visibleFooter.isVisible()).toBe(true);
  }
});

it('keeps the sidebar reasoning help within the picker and closes it first on Escape', async () => {
  using value = fixture({
    props: { surface: 'sidebar', modelSelection: 'unavailable' },
    slots: {
      unavailable: 'This connection manages model choice.',
      settings: ({ popupTarget }: { popupTarget: HTMLElement | undefined }) => h(ReasoningSettings, { selectedEffort: undefined, surface: 'plain', layout: 'inline', notice: 'inline-help', popupTarget }),
    },
  });
  await value.open();
  const dropdown = value.get({ testId: 'model-selector-dropdown' });
  const help = value.get({ testId: 'reasoning-help-button' });
  expect(value.get({ testId: 'model-selector-unavailable' }).text()).toBe('This connection manages model choice.');
  expect((value.get({ testId: 'model-selector-filter' }).element as HTMLInputElement).disabled).toBe(true);
  expect(value.get({ testId: 'model-selector-option' }).attributes('disabled')).toBeDefined();
  expect(value.get({ testId: 'model-selector-refresh' }).attributes('disabled')).toBeDefined();
  await help.trigger('click');
  const tooltip = value.get({ testId: 'reasoning-help' });
  expect(dropdown.element.contains(tooltip.element)).toBe(true);
  tooltip.element.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, composed: true }));
  await tooltip.trigger('click');
  expect(dropdown.attributes('open')).toBeDefined();
  await help.trigger('keydown', { key: 'Escape' });
  expect(document.querySelector('[data-testid="reasoning-help"]')).toBeNull();
  expect(dropdown.attributes('open')).toBeDefined();
  await help.trigger('keydown', { key: 'Escape' });
  expect(document.querySelector('[data-testid="model-selector-dropdown"]')).toBeNull();
});

it.each(['hf.co', 'host/Models'])('shows the model name and complete variant for a %s model', async source => {
  const modelId = `${source}/owner/Gemma-GGUF:imatrix/Q4_K_M`;
  using value = fixture({ props: { modelValue: modelId, models: [{ id: modelId, label: modelId, description: undefined, availability: 'local' }] }, slots: undefined });
  const trigger = value.wrapper.get('[data-testid="model-selector-trigger"]');
  expect(trigger.text()).toContain('Gemma-GGUF:imatrix/Q4_K_M');
  expect(trigger.attributes('title')).toBe(modelId);
  await value.open();
  const row = value.get({ testId: 'model-selector-option' });
  expect(row.attributes('aria-pressed')).toBe('true');
  await row.trigger('click');
  expect(value.wrapper.emitted('update:modelValue')?.[0]).toEqual([modelId]);
});

it('keeps the first-use hint visible until the download starts and omits progress from the closed selector', async () => {
  using value = fixture({ props: { modelValue: 'catalog/qwen' }, slots: undefined });
  expect(value.wrapper.find('[data-testid="model-selector-download-hint"]').exists()).toBe(true);
  await value.wrapper.setProps({ hideFirstUseDownloadHint: true });
  expect(value.wrapper.find('[data-testid="model-selector-download-hint"]').exists()).toBe(false);
  expect(value.wrapper.get('[data-testid="model-selector-trigger"]').text()).toBe('Qwen speech');
});

it('refreshes the picker’s model inventory when its File Explorer closes', async () => {
  const modelId = '~user/model';
  const relativePath = 'model.gguf';
  const primary = { storageKind: 'temp' as const, relativePath, file: new File([], relativePath), registrationRevision: 1 };
  const { llamaCppBrowserModelFiles } = await import('@/features/llama-cpp-browser/model-files');
  const explorer = await import('@/features/llama-cpp-browser/model-file-explorer');
  const inspect = vi.spyOn(llamaCppBrowserModelFiles, 'inspectModelFiles').mockResolvedValue({
    modelId,
    directory: { primaryFile: primary, files: [primary], projectorFile: undefined },
    location: { kind: 'temp', rootPath: modelId },
  });
  const createOptions = vi.spyOn(explorer, 'createModelFileExplorerOptions').mockResolvedValue({ kind: 'opfs-root' });
  const { isFileExplorerOpen, closeFileExplorer } = useFileExplorerModal();
  using cleanup = {
    [Symbol.dispose]() {
      closeFileExplorer();
      inspect.mockRestore();
      createOptions.mockRestore();
    },
  };
  void cleanup;
  const refreshAfterFileExplorer = vi.fn();
  using value = fixture({
    props: {
      modelValue: modelId,
      models: [{ id: modelId, label: modelId, description: undefined, availability: 'local' }],
      refreshAfterFileExplorer,
    },
    slots: undefined,
  });
  await value.open();
  await value.get({ testId: 'model-selector-stored-variant-details' }).trigger('click');
  await flushPromises();
  await value.get({ testId: 'model-selector-open-model-folders' }).trigger('click');
  await flushPromises();
  expect(isFileExplorerOpen.value).toBe(true);
  expect(refreshAfterFileExplorer).not.toHaveBeenCalled();
  closeFileExplorer();
  expect(refreshAfterFileExplorer).toHaveBeenCalledOnce();
});

it('changes quantization without closing the picker and copies the full selected model ID', async () => {
  const ids = ['hf.co/owner/Model-GGUF:Q4_K_M', 'hf.co/owner/Model-GGUF:Q8_0', 'host/Other/owner/Model-GGUF:Q8_0', 'hf.co/owner/Model-GGUF:Custom-Q8_0'];
  const selectedId = ids[1]!;
  const writeText = vi.fn<typeof navigator.clipboard.writeText>().mockResolvedValue(undefined);
  vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
  using value = fixture({ props: { modelValue: selectedId, models: ids.map(id => ({ id, label: id, description: undefined, availability: 'local' })) }, slots: undefined });
  await value.open();
  expect(value.options()).toEqual([selectedId, ids[2]]);
  const group = value.get({ testId: 'model-selector-stored-variant-group' });
  const button = group.get('[data-testid="model-selector-stored-variant"]');
  expect(button.text()).toBe('Q8_0');
  await group.get('[data-testid="model-selector-stored-variant-details"]').trigger('click');
  await group.get('[data-testid="model-selector-copy-model-id"]').trigger('click');
  expect(writeText).toHaveBeenLastCalledWith(selectedId);
  await button.trigger('click');
  expect(value.get({ testId: 'settings-select-option-' + ids[3] }).text()).toBe('Custom-Q8_0');
  const q4 = value.get({ testId: 'settings-select-option-' + ids[0] });
  await q4.trigger('pointerdown');
  await q4.trigger('click');
  expect(value.wrapper.emitted('update:modelValue')).toEqual([[ids[0]]]);
  await value.wrapper.setProps({ modelValue: ids[0] });
  expect(value.get({ testId: 'model-selector-dropdown' }).attributes('open')).toBeDefined();
  expect(button.text()).toBe('Q4_K_M');
  await group.get('[data-testid="model-selector-copy-model-id"]').trigger('click');
  expect(writeText).toHaveBeenLastCalledWith(ids[0]);
  const single = document.querySelectorAll('[data-testid="model-selector-stored-variant"]')[1]!;
  expect(single.hasAttribute('disabled')).toBe(true);
  expect(single.querySelector('svg')).toBeNull();
  const filter = value.get({ testId: 'model-selector-filter' });
  filter.element.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
  keydown({ target: filter.element, key: 'Enter', isComposing: false });
  expect(value.wrapper.emitted('update:modelValue')?.at(-1)).toEqual([ids[0]]);
});

it('selects the first displayed quantization for a row with no selection', async () => {
  const ids = ['hf.co/leejet/Z-Image-Turbo-GGUF:image_turbo-Q4_K', 'hf.co/leejet/Z-Image-Turbo-GGUF:image_turbo-Q8_0'];
  using value = fixture({ props: { models: ids.map(id => ({ id, label: id, description: undefined, availability: 'local' })) }, slots: undefined });
  await value.open();
  const button = value.get({ testId: 'model-selector-stored-variant' });
  expect(value.get({ testId: 'model-selector-option-name' }).text()).toBe('Z-Image-Turbo-GGUF');
  expect(button.text()).toBe('image_turbo-Q4_K');
  await button.trigger('click');
  const first = value.get({ testId: 'settings-select-option-' + ids[0] });
  expect(first.attributes('aria-selected')).toBe('false');
  await first.trigger('click');
  expect(value.wrapper.emitted('update:modelValue')).toEqual([[ids[0]]]);
  expect(value.get({ testId: 'model-selector-dropdown' }).attributes('open')).toBeDefined();
});

it('finds a saved model across hyphen differences and copies an ID without a quantization separator', async () => {
  const modelId = 'user/gemma-4-E2B-GGUF/gemma-4-E2B-q4_0';
  const writeText = vi.fn<typeof navigator.clipboard.writeText>().mockResolvedValue(undefined);
  vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
  using value = fixture({ props: { models: [...models, { id: modelId, label: modelId, description: undefined, availability: 'local' }] }, slots: undefined });
  await value.open();
  await value.get({ testId: 'model-selector-filter' }).setValue('gemma4');
  expect(value.options()).toEqual([modelId]);
  const group = value.get({ testId: 'model-selector-stored-variant-group' });
  expect(group.find('[data-testid="model-selector-stored-variant"]').exists()).toBe(false);
  await group.get('[data-testid="model-selector-stored-variant-details"]').trigger('click');
  await group.get('[data-testid="model-selector-copy-model-id"]').trigger('click');
  expect(writeText).toHaveBeenCalledExactlyOnceWith(modelId);
  expect(externalFetch).not.toHaveBeenCalled();
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
  const sources = value.get({ testId: 'model-selector-open-sources' });
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
