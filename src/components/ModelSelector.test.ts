import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ensureAllStringsForTest } from '@/strings/utils.test-support';
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import ModelSelector from './ModelSelector.vue';
import ReasoningSettings from './ReasoningSettings.vue';
import { useSettings } from '@/composables/useSettings';
import { ref, nextTick, h } from 'vue';

// Mock useSettings
vi.mock('../composables/useSettings', () => ({
  useSettings: vi.fn(),
}));

enableAutoUnmount(afterEach);

// Mock @vueuse/core for positioning tests
const mockBounding = {
  top: ref(100),
  bottom: ref(140),
  left: ref(100),
  width: ref(200),
};
const mockWindowSize = {
  width: ref(1024),
  height: ref(768),
};

vi.mock('@vueuse/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@vueuse/core')>();
  return {
    ...actual,
    useElementBounding: vi.fn(() => mockBounding),
    useWindowSize: vi.fn(() => mockWindowSize),
  };
});

beforeEach(async () => {
  await ensureAllStringsForTest({ locale: 'en' });
});

describe('ModelSelector.vue', () => {
  const availableModels = ref(['model-a', 'model-b', 'model-c']);
  const isFetchingModels = ref(false);
  const fetchModels = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    availableModels.value = ['model-a', 'model-b', 'model-c'];
    (useSettings as any).mockReturnValue({
      availableModels,
      isFetchingModels,
      fetchModels,
    });
    // Reset positioning mocks
    mockBounding.top.value = 100;
    mockBounding.bottom.value = 140;
    mockBounding.left.value = 100;
    mockBounding.width.value = 200;
    mockWindowSize.width.value = 1024;
    mockWindowSize.height.value = 768;
    document.body.innerHTML = '';
  });

  afterEach(async () => {
    await flushPromises();
    document.body.innerHTML = '';
  });

  it('renders correctly with initial modelValue', () => {
    const wrapper = mount(ModelSelector, {
      props: {
        modelValue: 'model-a',
      },
    });

    expect(wrapper.text()).toContain('model-a');
    expect(wrapper.get('[data-testid="model-selector-trigger"]').attributes('aria-describedby')).toBeUndefined();
    expect(wrapper.find('[data-testid="model-selector-trigger-metadata"]').exists()).toBe(false);
  });

  it('describes the closed trigger with optional detail even when the model has no namespace or inheritance metadata', () => {
    const wrapper = mount(ModelSelector, {
      props: { modelValue: 'model-a', surface: 'composer', chevronVisibility: 'hidden' },
      slots: { 'trigger-detail': '<span>Think High</span>' },
    });
    const trigger = wrapper.get('[data-testid="model-selector-trigger"]');
    const metadata = trigger.get('[data-testid="model-selector-trigger-metadata"]');
    expect(metadata.text()).toBe('Think High');
    expect(metadata.get('[id]').attributes('id')).toBe(trigger.attributes('aria-describedby'));
    expect(trigger.text()).toContain('model-a');
    expect(wrapper.find('[data-testid="model-selector-dropdown"]').exists()).toBe(false);
  });

  it('toggles dropdown when clicked', async () => {
    const wrapper = mount(ModelSelector, {
      props: {
        modelValue: 'model-a',
      },
    });

    const trigger = wrapper.get('[data-testid="model-selector-trigger"]');
    await trigger.trigger('click');
    await flushPromises();

    // Teleported to body
    await vi.waitFor(() => {
      expect(document.body.querySelector('.animate-in')).toBeTruthy();
    });
    const dropdown = document.body.querySelector('.animate-in');
    expect(dropdown?.querySelector('[data-testid="model-selector-filter"]')).toBeTruthy();
    expect(dropdown?.textContent).toContain('model-b');
    expect(dropdown?.textContent).toContain('model-c');

    await trigger.trigger('click');
    await flushPromises();
    expect(document.body.querySelector('.animate-in')).toBeFalsy();
  });

  it('focuses the search input when the dropdown opens', async () => {
    const wrapper = mount(ModelSelector, {
      props: {
        modelValue: 'model-a',
      },
      attachTo: document.body,
    });

    const trigger = wrapper.get('[data-testid="model-selector-trigger"]');
    await trigger.trigger('click');
    await flushPromises();

    const input = document.body.querySelector('[data-testid="model-selector-filter"]') as HTMLInputElement;
    expect(document.activeElement).toBe(input);

    wrapper.unmount();
  });

  it('filters models based on search query', async () => {
    const wrapper = mount(ModelSelector, {
      props: {
        modelValue: 'model-a',
      },
    });

    await wrapper.get('[data-testid="model-selector-trigger"]').trigger('click');
    await flushPromises();

    const input = document.body.querySelector('[data-testid="model-selector-filter"]') as HTMLInputElement;
    input.value = 'model-b';
    input.dispatchEvent(new Event('input'));
    await nextTick();

    const listItems = Array.from(document.body.querySelectorAll('.custom-scrollbar button'));
    expect(listItems.some(i => i.textContent?.includes('model-a'))).toBe(false);
    expect(listItems.some(i => i.textContent?.includes('model-b'))).toBe(true);
    expect(listItems.some(i => i.textContent?.includes('model-c'))).toBe(false);

    wrapper.unmount();
  });

  it('filters models using space-separated keywords', async () => {
    availableModels.value = [
      'anthropic/claude-3-5-sonnet',
      'openai/gpt-4o',
      'openai/gpt-3.5-turbo',
      'google/gemini-1.5-pro',
    ];
    const wrapper = mount(ModelSelector, {
      props: {
        modelValue: undefined,
      },
    });

    await wrapper.get('[data-testid="model-selector-trigger"]').trigger('click');
    await flushPromises();

    const input = document.body.querySelector('[data-testid="model-selector-filter"]') as HTMLInputElement;

    // Case 1: "gpt 4" should match "openai/gpt-4o"
    input.value = 'gpt 4';
    input.dispatchEvent(new Event('input'));
    await nextTick();

    let listItems = Array.from(document.body.querySelectorAll('[data-testid="model-selector-option"]'));
    expect(listItems.map(i => i.getAttribute('title'))).toEqual(['openai/gpt-4o']);

    // Case 2: "turbo" should match "openai/gpt-3.5-turbo"
    input.value = 'turbo';
    input.dispatchEvent(new Event('input'));
    await nextTick();

    listItems = Array.from(document.body.querySelectorAll('[data-testid="model-selector-option"]'));
    expect(listItems.map(i => i.getAttribute('title'))).toEqual(['openai/gpt-3.5-turbo']);

    // Case 3: "sonnet anthropic" (out of order) should match "anthropic/claude-3-5-sonnet"
    input.value = 'sonnet anthropic';
    input.dispatchEvent(new Event('input'));
    await nextTick();

    listItems = Array.from(document.body.querySelectorAll('[data-testid="model-selector-option"]'));
    expect(listItems.map(i => i.getAttribute('title'))).toEqual(['anthropic/claude-3-5-sonnet']);

    wrapper.unmount();
  });

  it('emits update:modelValue when a model is selected', async () => {
    const wrapper = mount(ModelSelector, {
      props: {
        modelValue: 'model-a',
      },
    });

    await wrapper.get('[data-testid="model-selector-trigger"]').trigger('click');
    await flushPromises();

    const options = Array.from(document.body.querySelectorAll('.custom-scrollbar button'))
      .filter(b => b.textContent?.includes('model-c'));

    (options[0] as HTMLElement).click();
    await nextTick();

    expect(wrapper.emitted('update:modelValue')).toBeTruthy();
    expect(wrapper.emitted('update:modelValue')![0]).toEqual(['model-c']);

    wrapper.unmount();
  });

  it('emits undefined when the placeholder/clear option is selected', async () => {
    const wrapper = mount(ModelSelector, {
      props: {
        modelValue: 'model-a',
        placeholder: 'Global Default',
        allowClear: true,
      },
    });

    await wrapper.get('[data-testid="model-selector-trigger"]').trigger('click');
    await flushPromises();

    const clearBtn = document.body.querySelector('[data-testid="model-selector-clear"]') as HTMLElement;
    expect(clearBtn.textContent).toContain('Global Default');
    clearBtn.click();
    await nextTick();

    expect(wrapper.emitted('update:modelValue')).toBeTruthy();
    expect(wrapper.emitted('update:modelValue')![0]).toEqual([undefined]);

    wrapper.unmount();
  });

  it('does not show clear option when allowClear is false', async () => {
    const wrapper = mount(ModelSelector, {
      props: {
        modelValue: 'model-a',
        allowClear: false,
      },
    });

    await wrapper.get('[data-testid="model-selector-trigger"]').trigger('click');
    await flushPromises();
    expect(document.body.querySelector('[data-testid="model-selector-clear"]')).toBeFalsy();

    wrapper.unmount();
  });

  it('calls fetchModels when refresh button is clicked', async () => {
    const wrapper = mount(ModelSelector, {
      props: {
        modelValue: 'model-a',
      },
    });

    await wrapper.get('[data-testid="model-selector-trigger"]').trigger('click');
    await flushPromises();

    const refreshBtn = Array.from(document.body.querySelectorAll('button'))
      .find(b => b.getAttribute('title') === 'Refresh model list');

    (refreshBtn as HTMLElement).click();
    await nextTick();

    expect(fetchModels).toHaveBeenCalled();

    wrapper.unmount();
  });

  it('shows loading state when isFetchingModels is true', () => {
    isFetchingModels.value = true;
    const wrapper = mount(ModelSelector, {
      props: {
        modelValue: 'model-a',
      },
    });

    expect(wrapper.find('.animate-spin').exists()).toBe(true);
    isFetchingModels.value = false;
  });

  describe('Design and Styling Regressions', () => {
    it('has dynamic positioning and fixed styling', async () => {
      const wrapper = mount(ModelSelector, {
        props: { modelValue: 'model-a' },
      });

      await wrapper.get('[data-testid="model-selector-trigger"]').trigger('click');
      await flushPromises();
      const dropdown = document.body.querySelector('.animate-in') as HTMLElement;

      expect(dropdown.style.position).toBe('fixed');
      expect(dropdown.style.zIndex).toBe('9999');

      wrapper.unmount();
    });

    it('keeps the full model label available alongside compact candidate text', async () => {
      const wrapper = mount(ModelSelector, {
        props: { modelValue: 'owner/repository/model-a', models: ['owner/repository/model-a'] },
      });

      await wrapper.get('[data-testid="model-selector-trigger"]').trigger('click');
      await flushPromises();
      const option = document.body.querySelector('[data-testid="model-selector-option"]');
      expect(option?.getAttribute('title')).toBe('owner/repository/model-a');
      expect(option?.querySelector('[data-testid="model-selector-option-name"]')?.textContent).toBe('model-a');
      expect(option?.querySelector('[data-testid="model-selector-option-namespace"]')?.textContent).toBe('owner/repository');

      wrapper.unmount();
    });
  });

  it('preserves the order of models as provided in props', async () => {
    const customModels = ['model-z', 'model-a', 'model-m'];
    const wrapper = mount(ModelSelector, {
      props: {
        modelValue: undefined,
        models: customModels,
      },
    });

    await wrapper.get('[data-testid="model-selector-trigger"]').trigger('click');
    await flushPromises();

    const options = Array.from(document.body.querySelectorAll('[data-testid="model-selector-option"]'));
    const displayedOrder = options.map(option => option.getAttribute('title'));

    expect(displayedOrder).toEqual(customModels);

    wrapper.unmount();
  });

  describe('Adaptive Positioning Features (New Specs)', () => {
    it('opens downward by default when space is available', async () => {
      const wrapper = mount(ModelSelector, { props: { modelValue: 'model-a' } });
      await wrapper.get('[data-testid="model-selector-trigger"]').trigger('click');
      await flushPromises();

      const dropdown = document.body.querySelector('.animate-in') as HTMLElement;
      expect(dropdown.classList.contains('slide-in-from-top-2')).toBe(true);
      expect(dropdown.style.top).not.toBe('auto');
      expect(dropdown.style.bottom).toBe('auto');
      wrapper.unmount();
    });

    it('flips to open upward when space below is insufficient', async () => {
      mockBounding.bottom.value = 700;
      mockBounding.top.value = 660;
      mockWindowSize.height.value = 768;

      const wrapper = mount(ModelSelector, { props: { modelValue: 'model-a' } });
      await wrapper.get('[data-testid="model-selector-trigger"]').trigger('click');
      await flushPromises();

      const dropdown = document.body.querySelector('.animate-in') as HTMLElement;
      expect(dropdown.classList.contains('slide-in-from-bottom-2')).toBe(true);
      expect(dropdown.style.bottom).not.toBe('auto');
      expect(dropdown.style.top).toBe('auto');
      wrapper.unmount();
    });

    it('shifts left if the dropdown would overflow the right edge', async () => {
      mockBounding.left.value = 900;
      mockBounding.width.value = 100;
      mockWindowSize.width.value = 1024;

      const wrapper = mount(ModelSelector, { props: { modelValue: 'model-a' } });
      await wrapper.get('[data-testid="model-selector-trigger"]').trigger('click');
      await flushPromises();

      const dropdown = document.body.querySelector('.animate-in') as HTMLElement;
      const leftValue = parseFloat(dropdown.style.left);
      const dropdownWidth = parseFloat(dropdown.style.width);

      expect(leftValue).toBeLessThan(900);
      expect(leftValue + dropdownWidth).toBeLessThanOrEqual(mockWindowSize.width.value - 16);
      wrapper.unmount();
    });

    it('closes on window width resize but stays open on height resize', async () => {
      const wrapper = mount(ModelSelector, { props: { modelValue: 'model-a' } });
      await wrapper.get('[data-testid="model-selector-trigger"]').trigger('click');
      await flushPromises();
      await vi.waitFor(() => {
        expect(document.body.querySelector('.animate-in')).toBeTruthy();
      });

      // Height change (like keyboard opening) - should STAY OPEN
      mockWindowSize.height.value = 400;
      await nextTick();
      expect(document.body.querySelector('.animate-in')).toBeTruthy();

      // Width change (like orientation change) - should CLOSE
      mockWindowSize.width.value = 800;
      await nextTick();
      expect(document.body.querySelector('.animate-in')).toBeFalsy();

      wrapper.unmount();
    });

    it('identifies clicks inside the teleported dropdown as "inside"', async () => {
      const addSpy = vi.spyOn(document, 'addEventListener');
      const wrapper = mount(ModelSelector, {
        props: { modelValue: 'model-a' },
        attachTo: document.body,
      });

      await wrapper.get('[data-testid="model-selector-trigger"]').trigger('click');
      await flushPromises();
      const dropdown = document.body.querySelector('.animate-in') as HTMLElement;

      // Find the mousedown listener
      const mousedownCall = addSpy.mock.calls.find(call => call[0] === 'mousedown');
      const handler = mousedownCall![1] as any;

      // 1. Click inside dropdown
      handler({ target: dropdown.querySelector('input') });
      await nextTick();
      expect(document.body.querySelector('.animate-in')).toBeTruthy();

      // 2. Click outside
      handler({ target: document.body });
      await nextTick();
      expect(document.body.querySelector('.animate-in')).toBeFalsy();

      wrapper.unmount();
      addSpy.mockRestore();
    });

    it('uses a wider preferred width for long model names', async () => {
      mockBounding.width.value = 150;
      const wrapper = mount(ModelSelector, { props: { modelValue: 'model-a' } });
      await wrapper.get('[data-testid="model-selector-trigger"]').trigger('click');
      await flushPromises();

      const dropdown = document.body.querySelector('.animate-in') as HTMLElement;
      expect(parseFloat(dropdown.style.width)).toBe(480);
      wrapper.unmount();
    });

    it('remains open when search input is focused and triggers height change (keyboard regression)', async () => {
      const wrapper = mount(ModelSelector, {
        props: { modelValue: 'model-a' },
        attachTo: document.body,
      });

      // 1. Open dropdown
      await wrapper.get('[data-testid="model-selector-trigger"]').trigger('click');
      await flushPromises();
      expect(document.body.querySelector('.animate-in')).toBeTruthy();

      // 2. Search input is automatically focused on toggle
      const input = document.body.querySelector('input') as HTMLInputElement;
      expect(document.activeElement).toBe(input);

      // 3. Simulate software keyboard opening (triggers height change)
      mockWindowSize.height.value = 350; // Significant height reduction
      await nextTick();

      // Dropdown should REMAIN OPEN
      expect(document.body.querySelector('.animate-in')).toBeTruthy();

      wrapper.unmount();
    });
  });

  describe('Keyboard Navigation (New Specs)', () => {
    it('opens the dropdown when ArrowDown is pressed on the trigger', async () => {
      const wrapper = mount(ModelSelector, { props: { modelValue: 'model-a' } });
      const trigger = wrapper.get('[data-testid="model-selector-trigger"]');

      await trigger.trigger('keydown', { key: 'ArrowDown' });
      expect(document.body.querySelector('.animate-in')).toBeTruthy();
      wrapper.unmount();
    });

    it('navigates through models with Arrow keys and wraps around', async () => {
      const wrapper = mount(ModelSelector, {
        props: {
          modelValue: 'model-a',
          allowClear: true, // index 0: Inherit, index 1: model-a, index 2: model-b, index 3: model-c
        },
      });
      await wrapper.get('[data-testid="model-selector-trigger"]').trigger('click');
      await flushPromises();

      const trigger = wrapper.get('[data-testid="model-selector-trigger"]');

      // Initial state: model-a is selected, so index 1 should be highlighted
      const getHighlighted = () => {
        const listButtons = Array.from(document.body.querySelectorAll('.custom-scrollbar button'));
        return listButtons.findIndex(b => b.classList.contains('bg-gray-100'));
      };

      expect(getHighlighted()).toBe(1);

      // Move down to model-b
      await trigger.trigger('keydown', { key: 'ArrowDown' });
      expect(getHighlighted()).toBe(2);

      // Move down to model-c
      await trigger.trigger('keydown', { key: 'ArrowDown' });
      expect(getHighlighted()).toBe(3);

      // Wrap around to Inherit (index 0)
      await trigger.trigger('keydown', { key: 'ArrowDown' });
      expect(getHighlighted()).toBe(0);

      // Move up to model-c (index 3)
      await trigger.trigger('keydown', { key: 'ArrowUp' });
      expect(getHighlighted()).toBe(3);

      wrapper.unmount();
    });

    it('selects the highlighted model when Enter is pressed', async () => {
      const wrapper = mount(ModelSelector, { props: { modelValue: 'model-a' } });
      await wrapper.get('[data-testid="model-selector-trigger"]').trigger('click');
      await flushPromises();
      const trigger = wrapper.get('[data-testid="model-selector-trigger"]');

      // Move down to model-b (index 1 if allowClear is false)
      await trigger.trigger('keydown', { key: 'ArrowDown' });
      await trigger.trigger('keydown', { key: 'Enter' });

      expect(wrapper.emitted('update:modelValue')![0]).toEqual(['model-b']);
      expect(document.body.querySelector('.animate-in')).toBeFalsy();
      wrapper.unmount();
    });

    it('closes the dropdown when Escape is pressed', async () => {
      const wrapper = mount(ModelSelector, { props: { modelValue: 'model-a' } });
      await wrapper.get('[data-testid="model-selector-trigger"]').trigger('click');
      await flushPromises();
      const trigger = wrapper.get('[data-testid="model-selector-trigger"]');

      expect(document.body.querySelector('.animate-in')).toBeTruthy();
      await trigger.trigger('keydown', { key: 'Escape' });
      expect(document.body.querySelector('.animate-in')).toBeFalsy();
      wrapper.unmount();
    });

    it('resets highlighted index when search query changes', async () => {
      const wrapper = mount(ModelSelector, { props: { modelValue: 'model-a' } });
      await wrapper.get('[data-testid="model-selector-trigger"]').trigger('click');
      await flushPromises();

      const trigger = wrapper.get('[data-testid="model-selector-trigger"]');
      const input = document.body.querySelector('input') as HTMLInputElement;

      // Move highlight to second item
      await trigger.trigger('keydown', { key: 'ArrowDown' });

      // Update search
      input.value = 'model';
      input.dispatchEvent(new Event('input'));
      await nextTick();

      // Highlight should reset to 0
      const highlighted = Array.from(document.body.querySelectorAll('.custom-scrollbar button'))
        .findIndex(b => b.classList.contains('bg-gray-100'));
      expect(highlighted).toBe(0);

      wrapper.unmount();
    });
  });

  describe('Smart Truncation Logic', () => {
    it('splits model name with slash into prefix and suffix', () => {
      const wrapper = mount(ModelSelector, {
        props: { modelValue: 'huggingface/user/model-name' },
      });

      const trigger = wrapper.find('[data-testid="model-selector-trigger"]');
      const prefixSpan = trigger.find('span[style*="direction: rtl"]');
      const suffixSpan = trigger.find('.truncate.flex-1');

      expect(prefixSpan.text()).toBe('huggingface/user/');
      expect(suffixSpan.text()).toBe('model-name');
    });

    it('handles model names without a slash correctly', () => {
      const wrapper = mount(ModelSelector, {
        props: { modelValue: 'gpt-4o' },
      });

      const trigger = wrapper.find('[data-testid="model-selector-trigger"]');
      const prefixSpan = trigger.find('span[style*="direction: rtl"]');
      const suffixSpan = trigger.find('.truncate.flex-1');

      expect(prefixSpan.exists()).toBe(false);
      expect(suffixSpan.text()).toBe('gpt-4o');
    });

    it('applies correct layout styles for prioritization', () => {
      const wrapper = mount(ModelSelector, {
        props: { modelValue: 'org/model' },
      });

      const prefixSpan = wrapper.find('span[style*="direction: rtl"]');
      const suffixSpan = wrapper.find('.truncate.flex-1');

      // Prefix should have high shrink to prioritize model name
      expect(prefixSpan.attributes('style')).toContain('flex: 0 1000 auto');
      // Suffix should have flex: 1 1 auto
      expect(suffixSpan.attributes('style')).toContain('flex: 1 1 auto');
    });

    it('shows placeholder when no model value is provided', () => {
      const wrapper = mount(ModelSelector, {
        props: { modelValue: '', placeholder: 'Custom Placeholder' },
      });

      expect(wrapper.text()).toContain('Custom Placeholder');
    });
  });
});

describe('controlled local-model choices', () => {
  const internalFetch = vi.fn();

  beforeEach(() => {
    vi.mocked(useSettings, { partial: true }).mockReturnValue({ availableModels: ref(['chat-only']), isFetchingModels: ref(true), fetchModels: internalFetch });
    internalFetch.mockClear();
  });

  it('keeps sidebar trigger metadata and the selected model visible during refresh', async () => {
    const wrapper = mount(ModelSelector, {
      props: { surface: 'sidebar', modelValue: 'owner/repo/model-q4', models: [], loading: false },
      slots: { 'trigger-label': 'Default model', 'trigger-summary': 'Think Medium' },
    });
    const trigger = wrapper.get('[data-testid="model-selector-trigger"]');
    expect(trigger.text()).toContain('Default model');
    expect(trigger.text()).toContain('Think Medium');
    expect(trigger.text()).toContain('owner/repo/');
    expect(trigger.text()).toContain('model-q4');
    expect(trigger.attributes('title')).toBe('owner/repo/model-q4');
    await wrapper.setProps({ loading: true });
    expect(trigger.text()).toContain('model-q4');
    expect(trigger.attributes('aria-busy')).toBe('true');
    expect(wrapper.findAll('button')).toHaveLength(1);
  });

  it.each(['default', 'composer'] as const)('keeps sidebar metadata out of the %s trigger', surface => {
    const wrapper = mount(ModelSelector, {
      props: { surface, modelValue: 'owner/model', models: [] },
      slots: { 'trigger-label': 'Sidebar-only heading', 'trigger-summary': 'Sidebar-only summary' },
    });
    const trigger = wrapper.get('[data-testid="model-selector-trigger"]');
    expect(trigger.text()).toContain('owner/');
    expect(trigger.text()).toContain('model');
    expect(trigger.text()).not.toContain('Sidebar-only');
  });

  it.each(['default', 'composer', 'sidebar'] as const)('shows %s model names and namespaces separately while emitting stable IDs', async surface => {
    const wrapper = mount(ModelSelector, {
      props: { surface, modelValue: 'owner/selected', models: ['owner/selected', 'namespace/other', 'plain'], loading: false },
    });
    await wrapper.get('[data-testid="model-selector-trigger"]').trigger('click');
    await flushPromises();
    const options = [...document.body.querySelectorAll<HTMLButtonElement>('[data-testid="model-selector-option"]')];
    expect(options.map(option => option.querySelector('[data-testid="model-selector-option-name"]')?.textContent)).toEqual(['selected', 'other', 'plain']);
    expect(options.map(option => option.querySelector('[data-testid="model-selector-option-namespace"]')?.textContent)).toEqual(['owner', 'namespace', undefined]);
    expect(options[0]!.getAttribute('title')).toBe('owner/selected');
    expect(options[0]!.getAttribute('aria-pressed')).toBe('true');
    options[1]!.click();
    await nextTick();
    expect(wrapper.emitted('update:modelValue')).toEqual([['namespace/other']]);
  });

  it.each(['default', 'composer'] as const)('splits friendly labels in %s candidates without changing their IDs', async surface => {
    const wrapper = mount(ModelSelector, {
      props: {
        surface,
        modelValue: 'stable-id-a',
        models: ['stable-id-a', 'stable-id-b'],
        modelLabels: { 'stable-id-a': 'owner/repository/friendly-model', 'stable-id-b': 'Friendly plain model' },
        loading: false,
      },
    });
    await wrapper.get('[data-testid="model-selector-trigger"]').trigger('click');
    await flushPromises();
    const options = [...document.body.querySelectorAll<HTMLButtonElement>('[data-testid="model-selector-option"]')];
    expect(options[0]!.querySelector('[data-testid="model-selector-option-name"]')?.textContent).toBe('friendly-model');
    expect(options[0]!.querySelector('[data-testid="model-selector-option-namespace"]')?.textContent).toBe('owner/repository');
    expect(options[0]!.getAttribute('title')).toBe('owner/repository/friendly-model');
    expect(options[1]!.querySelector('[data-testid="model-selector-option-name"]')?.textContent).toBe('Friendly plain model');
    expect(options[1]!.querySelector('[data-testid="model-selector-option-namespace"]')).toBeNull();
    options[0]!.click();
    await nextTick();
    expect(wrapper.emitted('update:modelValue')).toEqual([['stable-id-a']]);
  });

  it('distinguishes loading, an empty model list, and unmatched filtering in the sidebar', async () => {
    const wrapper = mount(ModelSelector, { props: { surface: 'sidebar', modelValue: undefined, models: [], loading: true } });
    await wrapper.get('[data-testid="model-selector-trigger"]').trigger('click');
    await flushPromises();
    const emptyText = () => document.body.querySelector('[data-testid="model-selector-empty"]')?.textContent;
    expect(emptyText()).toBe('Loading models…');
    await wrapper.setProps({ loading: false });
    expect(emptyText()).toBe('No models available');
    await wrapper.setProps({ models: ['model-a'] });
    const filter = document.body.querySelector<HTMLInputElement>('[data-testid="model-selector-filter"]')!;
    filter.value = 'absent';
    filter.dispatchEvent(new Event('input', { bubbles: true }));
    await nextTick();
    expect(emptyText()).toBe('No models found');
  });

  it.each(['Enter', ' '])('preserves native sidebar button activation with %s', async key => {
    const refresh = vi.fn();
    const wrapper = mount(ModelSelector, {
      props: { surface: 'sidebar', modelValue: 'model-a', models: ['model-a', 'model-b'], loading: false, onRefresh: refresh },
      slots: { settings: '<button data-testid="reasoning-control">Reasoning</button>' },
      attachTo: document.body,
    });
    await wrapper.get('[data-testid="model-selector-trigger"]').trigger('click');
    await flushPromises();
    const refreshButton = document.body.querySelector<HTMLButtonElement>('[data-testid="model-selector-refresh"]')!;
    refreshButton.focus();
    const refreshArrow = new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true });
    refreshButton.dispatchEvent(refreshArrow);
    expect(refreshArrow.defaultPrevented).toBe(false);
    const refreshKey = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
    refreshButton.dispatchEvent(refreshKey);
    expect(refreshKey.defaultPrevented).toBe(false);
    expect(wrapper.emitted('update:modelValue')).toBeUndefined();
    refreshButton.click();
    await nextTick();
    expect(refresh).toHaveBeenCalledOnce();
    const filter = document.body.querySelector<HTMLInputElement>('[data-testid="model-selector-filter"]')!;
    filter.value = 'model';
    filter.dispatchEvent(new Event('input', { bubbles: true }));
    await nextTick();
    const clear = document.body.querySelector<HTMLButtonElement>('[data-testid="model-selector-clear-filter"]')!;
    clear.focus();
    const clearArrow = new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true });
    clear.dispatchEvent(clearArrow);
    expect(clearArrow.defaultPrevented).toBe(false);
    const clearKey = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
    clear.dispatchEvent(clearKey);
    expect(clearKey.defaultPrevented).toBe(false);
    expect(wrapper.emitted('update:modelValue')).toBeUndefined();
    clear.click();
    await nextTick();
    expect(filter.value).toBe('');
    expect(document.activeElement).toBe(filter);
    const secondOption = document.body.querySelectorAll<HTMLButtonElement>('[data-testid="model-selector-option"]')[1]!;
    filter.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    secondOption.focus();
    const optionArrow = new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true });
    secondOption.dispatchEvent(optionArrow);
    expect(optionArrow.defaultPrevented).toBe(false);
    const optionKey = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
    secondOption.dispatchEvent(optionKey);
    expect(optionKey.defaultPrevented).toBe(false);
    expect(wrapper.emitted('update:modelValue')).toBeUndefined();
    secondOption.click();
    await nextTick();
    expect(wrapper.emitted('update:modelValue')).toEqual([['model-b']]);
  });

  it('keeps sidebar search navigation independent from optional settings', async () => {
    const wrapper = mount(ModelSelector, {
      props: { surface: 'sidebar', modelValue: 'model-a', models: ['model-a', 'model-b'], loading: false },
      slots: { settings: '<button data-testid="reasoning-control">Reasoning</button>' },
      attachTo: document.body,
    });
    await wrapper.get('[data-testid="model-selector-trigger"]').trigger('click');
    await flushPromises();
    const filter = document.body.querySelector<HTMLInputElement>('[data-testid="model-selector-filter"]')!;
    filter.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true }));
    expect(wrapper.emitted('update:modelValue')).toBeUndefined();
    filter.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    filter.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await nextTick();
    expect(wrapper.emitted('update:modelValue')).toEqual([['model-b']]);
    expect(document.body.querySelector('[data-testid="model-selector-dropdown"]')).toBeNull();
  });

  it('explains unavailable sidebar selection while keeping reasoning reachable', async () => {
    const wrapper = mount(ModelSelector, {
      props: { surface: 'sidebar', modelValue: 'model-a', models: [], loading: false, modelSelection: 'unavailable' },
      slots: { unavailable: 'This connection manages model choice.', settings: '<button data-testid="reasoning-control">Reasoning</button>' },
      attachTo: document.body,
    });
    await wrapper.get('[data-testid="model-selector-trigger"]').trigger('click');
    await flushPromises();
    expect(document.body.querySelector('[data-testid="model-selector-unavailable"]')?.textContent).toBe('This connection manages model choice.');
    expect(document.body.querySelector('[data-testid="model-selector-empty"]')).toBeNull();
    expect(document.body.querySelector<HTMLInputElement>('[data-testid="model-selector-filter"]')?.disabled).toBe(true);
    expect(document.body.querySelector<HTMLButtonElement>('[data-testid="model-selector-refresh"]')?.disabled).toBe(true);
    const reasoning = document.body.querySelector<HTMLButtonElement>('[data-testid="reasoning-control"]')!;
    expect(document.activeElement).toBe(reasoning);
    reasoning.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await nextTick();
    expect(document.body.querySelector('[data-testid="model-selector-dropdown"]')).toBeNull();
    expect(document.activeElement).toBe(wrapper.get('[data-testid="model-selector-trigger"]').element);
    expect(internalFetch).not.toHaveBeenCalled();
  });

  it('searches friendly labels and stable IDs while emitting the ID', async () => {
    const wrapper = mount(ModelSelector, { props: { modelValue: 'a/1', models: ['a/1', 'b/2'], modelLabels: { 'a/1': 'Voice 日本語', 'b/2': 'Voice English' } } });
    expect(wrapper.text()).toContain('Voice 日本語');
    await wrapper.get('[data-testid="model-selector-trigger"]').trigger('click');
    await flushPromises();
    const filter = document.body.querySelector<HTMLInputElement>('[data-testid="model-selector-filter"]')!;
    filter.value = 'English';
    filter.dispatchEvent(new Event('input', { bubbles: true }));
    await nextTick();
    const options = [...document.body.querySelectorAll<HTMLButtonElement>('[data-testid="model-selector-option"]')];
    expect(options).toHaveLength(1);
options[0]!.click();
await nextTick();
expect(wrapper.emitted('update:modelValue')).toEqual([['b/2']]);
  });

  it('does not refresh the chat provider when given an explicit local list', async () => {
    const wrapper = mount(ModelSelector, { props: { modelValue: undefined, models: ['local'], loading: false } });
    await wrapper.get('[data-testid="model-selector-trigger"]').trigger('click');
    await flushPromises();
    const refresh = document.body.querySelector<HTMLButtonElement>('[data-testid="model-selector-refresh"]')!;
    expect(refresh.disabled).toBe(false);
    refresh.click();
    await flushPromises();
    expect(internalFetch).not.toHaveBeenCalled();
  });

  it('closes a teleported selector when disabled and cannot emit a programmatic selection', async () => {
    const wrapper = mount(ModelSelector, { props: { modelValue: undefined, models: ['local'] } });
    await wrapper.get('[data-testid="model-selector-trigger"]').trigger('click');
    await flushPromises();
    const staleOption = document.body.querySelector<HTMLButtonElement>('[data-testid="model-selector-option"]')!;
    await wrapper.setProps({ disabled: true });
    staleOption.click();
    await nextTick();
    expect(document.body.querySelector('[data-testid="model-selector-filter"]')).toBeNull();
    expect(wrapper.emitted('update:modelValue')).toBeUndefined();
  });

  it('keeps optional settings keyboard interactions independent from model selection', async () => {
    const wrapper = mount(ModelSelector, {
      props: { modelValue: 'model-a' },
      slots: { settings: '<button data-testid="reasoning-control">Reasoning</button>' },
      attachTo: document.body,
    });
    const trigger = wrapper.get<HTMLButtonElement>('[data-testid="model-selector-trigger"]');
    await trigger.trigger('click');
    await flushPromises();
    const filter = document.body.querySelector<HTMLInputElement>('[data-testid="model-selector-filter"]')!;
    filter.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    const settings = document.body.querySelector<HTMLButtonElement>('[data-testid="reasoning-control"]')!;
    settings.focus();
    settings.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    settings.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await nextTick();
    expect(wrapper.emitted('update:modelValue')).toBeUndefined();
    expect(document.body.querySelector('[data-testid="model-selector-dropdown"]')).toBeTruthy();
    settings.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await nextTick();
    expect(document.body.querySelector('[data-testid="model-selector-dropdown"]')).toBeNull();
    expect(document.activeElement).toBe(trigger.element);
  });

  it('allows settings while explicitly disabling only model selection', async () => {
    const wrapper = mount(ModelSelector, {
      props: { modelValue: 'model-a', modelSelection: 'unavailable' },
      slots: { settings: '<button data-testid="reasoning-control">Reasoning</button>' },
      attachTo: document.body,
    });
    await wrapper.get('[data-testid="model-selector-trigger"]').trigger('click');
    await flushPromises();
    const filter = document.body.querySelector<HTMLInputElement>('[data-testid="model-selector-filter"]')!;
    const refresh = document.body.querySelector<HTMLButtonElement>('[data-testid="model-selector-refresh"]')!;
    const option = document.body.querySelector<HTMLButtonElement>('[data-testid="model-selector-option"]')!;
    expect(filter.disabled).toBe(true);
    expect(refresh.disabled).toBe(true);
    expect(option.disabled).toBe(true);
    option.click();
    refresh.click();
    expect(wrapper.emitted('update:modelValue')).toBeUndefined();
    expect(internalFetch).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(document.body.querySelector('[data-testid="reasoning-control"]'));
  });

  it('preserves the width ceiling for a wide trigger and ignores composing Enter', async () => {
    mockBounding.width.value = 900;
    const wrapper = mount(ModelSelector, { props: { modelValue: 'model-a' } });
    await wrapper.get('[data-testid="model-selector-trigger"]').trigger('click');
    await flushPromises();
    const popup = document.body.querySelector<HTMLElement>('[data-testid="model-selector-dropdown"]')!;
    expect(popup.style.width).toBe('640px');
    const filter = document.body.querySelector<HTMLInputElement>('[data-testid="model-selector-filter"]')!;
    filter.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true }));
    await nextTick();
    expect(wrapper.emitted('update:modelValue')).toBeUndefined();
    expect(document.body.querySelector('[data-testid="model-selector-dropdown"]')).toBeTruthy();
  });

  it('keeps teleported reasoning help inside the interaction boundary without closing model selection', async () => {
    const wrapper = mount(ModelSelector, {
      props: { modelValue: 'model-a' },
      slots: { settings: () => h(ReasoningSettings, { selectedEffort: undefined, surface: 'plain', notice: 'inline-help' }) },
      attachTo: document.body,
    });
    await wrapper.get('[data-testid="model-selector-trigger"]').trigger('click');
    await flushPromises();
    const help = document.body.querySelector<HTMLButtonElement>('[data-testid="reasoning-help-button"]')!;
    help.focus();
    await nextTick();
    const tooltip = document.body.querySelector<HTMLElement>('[data-testid="reasoning-help"]')!;
    const pressingHelp = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    tooltip.dispatchEvent(pressingHelp);
    expect(pressingHelp.defaultPrevented).toBe(true);
    tooltip.click();
    await nextTick();
    expect(document.body.querySelector('[data-testid="model-selector-dropdown"]')).toBeTruthy();
    expect(document.body.querySelector('[data-testid="reasoning-help"]')).toBeTruthy();
    help.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await nextTick();
    expect(document.body.querySelector('[data-testid="reasoning-help"]')).toBeNull();
    expect(document.body.querySelector('[data-testid="model-selector-dropdown"]')).toBeTruthy();
    help.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await nextTick();
    expect(document.body.querySelector('[data-testid="model-selector-dropdown"]')).toBeNull();
    expect(wrapper.emitted('update:modelValue')).toBeUndefined();
  });

  it.each(['settings', 'composer'] as const)('shows %s inherited model presentation separately from the raw clear choice', async surface => {
    const wrapper = mount(ModelSelector, { attachTo: document.body, props: { modelValue: undefined, surface, inheritedModel: { id: 'owner/repository/model-Q4', source: { label: 'Global', description: 'Follows global changes' } }, models: ['owner/repository/model-Q4'], allowClear: true } });
    const trigger = wrapper.get('[data-testid="model-selector-trigger"]');
    expect(trigger.text()).toContain('model-Q4');
    expect(trigger.text()).toContain('owner/repository');
    expect(trigger.get('[data-testid="model-selector-trigger-metadata"]').text()).toContain('Global');
    expect(trigger.attributes('aria-label')).toContain('Follows global changes');
    await trigger.trigger('click');
    const clear = document.querySelector<HTMLButtonElement>('[data-testid="model-selector-clear"]')!;
    expect(clear.getAttribute('aria-label')).toContain('Follows global changes');
    document.querySelector<HTMLButtonElement>('[data-testid="model-selector-option"]')!.click();
    expect(wrapper.emitted('update:modelValue')).toEqual([['owner/repository/model-Q4']]);
    await wrapper.setProps({ modelValue: 'owner/repository/model-Q4' });
    expect(trigger.attributes('aria-label')).not.toContain('Follows global changes');
    expect(trigger.get('[data-testid="model-selector-trigger-metadata"]').text()).not.toContain('Global');
    await trigger.trigger('click');
    document.querySelector<HTMLButtonElement>('[data-testid="model-selector-clear"]')!.click();
    expect(wrapper.emitted('update:modelValue')?.at(-1)).toEqual([undefined]);
  });

  it('returns from a settings popup to the anchor before a natural Tab move', async () => {
    const wrapper = mount(ModelSelector, { attachTo: document.body, props: { modelValue: 'model-a', surface: 'settings', models: ['model-a'], allowClear: true } });
    const trigger = wrapper.get('[data-testid="model-selector-trigger"]');
    await trigger.trigger('click');
    const option = document.querySelector<HTMLButtonElement>('[data-testid="model-selector-option"]')!;
    option.focus();
    const tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    option.dispatchEvent(tab);
    await nextTick();
    expect(document.querySelector('[data-testid="model-selector-dropdown"]')).toBeNull();
    expect(document.activeElement).toBe(trigger.element);
    expect(tab.defaultPrevented).toBe(false);
  });

  it.each(['settings', 'composer'] as const)('shows %s metadata only when the displayed model has a path or active source', async surface => {
    const wrapper = mount(ModelSelector, { props: { modelValue: undefined, models: [], surface, placeholder: 'None' } });
    using _cleanupResource = {
      [Symbol.dispose]() {
        wrapper.unmount();
      },
    };
    expect(wrapper.get('[data-testid="model-selector-trigger"]').text()).toBe('None');
    expect(wrapper.find('[data-testid="model-selector-trigger-metadata"]').exists()).toBe(false);
    await wrapper.setProps({ inheritedModel: { id: undefined, source: { label: undefined, description: undefined } } });
    expect(wrapper.find('[data-testid="model-selector-trigger-metadata"]').exists()).toBe(true);
    await wrapper.setProps({ inheritedModel: { id: undefined, source: { label: 'Conversation', description: 'Uses each conversation' } } });
    expect(wrapper.get('[data-testid="model-selector-trigger-metadata"]').text()).toBe('Conversation');
    await wrapper.setProps({ modelValue: 'owner/repository/model' });
    expect(wrapper.get('[data-testid="model-selector-trigger-metadata"]').text()).toBe('owner/repository');
    await wrapper.setProps({ modelValue: 'plain-model-name' });
    expect(wrapper.get('[data-testid="model-selector-trigger"]').text()).toBe('plain-model-name');
    expect(wrapper.find('[data-testid="model-selector-trigger-metadata"]').exists()).toBe(false);
    await wrapper.setProps({ modelValue: undefined, inheritedModel: { id: 'plain-model-name', source: undefined }, allowClear: true });
    expect(wrapper.find('[data-testid="model-selector-trigger-metadata"]').exists()).toBe(false);
    await wrapper.get('[data-testid="model-selector-trigger"]').trigger('click');
    expect(document.querySelector('[data-testid="model-selector-clear-metadata"]')).toBeNull();
  });

  it('keeps an inline popup inside its modal and handles each navigation key once', async () => {
    const wrapper = mount(ModelSelector, { attachTo: document.body, props: { modelValue: 'model-a', models: ['model-a', 'model-b', 'model-c'], surface: 'settings', popupPresentation: 'inline' } });
    const trigger = wrapper.get<HTMLButtonElement>('[data-testid="model-selector-trigger"]');
    await trigger.trigger('click');
    const dropdown = wrapper.get<HTMLElement>('[data-testid="model-selector-dropdown"]');
    expect(wrapper.element.contains(dropdown.element)).toBe(true);
    expect(dropdown.element.style.position).toBe('');
    const filter = wrapper.get<HTMLInputElement>('[data-testid="model-selector-filter"]');
    expect(document.activeElement).toBe(filter.element);
    await filter.trigger('keydown', { key: 'ArrowDown' });
    await filter.trigger('keydown', { key: 'Enter' });
    expect(wrapper.emitted('update:modelValue')).toEqual([['model-b']]);
    expect(wrapper.find('[data-testid="model-selector-dropdown"]').exists()).toBe(false);
    expect(document.activeElement).toBe(trigger.element);
  });

  it.each([false, true])('closes its popup before an enclosing dialog on Escape (inline=%s)', async inline => {
    const escaped = vi.fn();
    const host = document.createElement('section');
    document.body.append(host);
    const wrapper = mount(ModelSelector, { attachTo: host, props: { modelValue: 'model-a', models: ['model-a'], surface: 'settings', popupPresentation: inline ? 'inline' : 'floating' } });
    const trigger = wrapper.get<HTMLButtonElement>('[data-testid="model-selector-trigger"]');
    host.addEventListener('keydown', escaped);
    await trigger.trigger('click');
    // Escape can originate at the trigger as well as the focused popup filter.
    trigger.element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    await nextTick();
    expect(document.body.querySelector('[data-testid="model-selector-dropdown"]')).toBeNull();
    expect(escaped).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(trigger.element);
    trigger.element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    expect(escaped).toHaveBeenCalledOnce();
  });

  it.each([false, true])('returns focus from an inline menu on Tab without blocking native focus navigation (shift=%s)', async shiftKey => {
    const wrapper = mount(ModelSelector, { attachTo: document.body, props: { modelValue: 'model-a', models: ['model-a'], surface: 'settings', popupPresentation: 'inline' } });
    const trigger = wrapper.get<HTMLButtonElement>('[data-testid="model-selector-trigger"]');
    await trigger.trigger('click');
    const tab = new KeyboardEvent('keydown', { key: 'Tab', shiftKey, bubbles: true, cancelable: true });
    wrapper.get('[data-testid="model-selector-filter"]').element.dispatchEvent(tab);
    await nextTick();
    expect(wrapper.find('[data-testid="model-selector-dropdown"]').exists()).toBe(false);
    expect(document.activeElement).toBe(trigger.element);
    expect(tab.defaultPrevented).toBe(false);
  });
});
