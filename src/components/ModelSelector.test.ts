import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount } from '@vue/test-utils';
import ModelSelector from './ModelSelector.vue';
import { useSettings } from '../composables/useSettings';
import { ref, nextTick } from 'vue';

// Mock useSettings
vi.mock('../composables/useSettings', () => ({
  useSettings: vi.fn(),
}));

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

describe('ModelSelector.vue', () => {
  const availableModels = ref(['model-a', 'model-b', 'model-c']);
  const isFetchingModels = ref(false);
  const fetchModels = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
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

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('renders correctly with initial modelValue', () => {
    const wrapper = mount(ModelSelector, {
      props: {
        modelValue: 'model-a',
      },
    });

    expect(wrapper.text()).toContain('model-a');
  });

  it('toggles dropdown when clicked', async () => {
    const wrapper = mount(ModelSelector, {
      props: {
        modelValue: 'model-a',
      },
    });

    const trigger = wrapper.get('[data-testid="model-selector-trigger"]');
    await trigger.trigger('click');

    // Teleported to body
    const dropdown = document.body.querySelector('.animate-in');
    expect(dropdown).toBeTruthy();
    expect(dropdown?.querySelector('input[placeholder="Filter models..."]')).toBeTruthy();
    expect(dropdown?.textContent).toContain('model-b');
    expect(dropdown?.textContent).toContain('model-c');

    await trigger.trigger('click');
    expect(document.body.querySelector('.animate-in')).toBeFalsy();
  });

  it('focuses the search input when the dropdown opens', async () => {
    const wrapper = mount(ModelSelector, {
      props: {
        modelValue: 'model-a',
      },
      attachTo: document.body
    });

    const trigger = wrapper.get('[data-testid="model-selector-trigger"]');
    await trigger.trigger('click');
    
    const input = document.body.querySelector('input[placeholder="Filter models..."]') as HTMLInputElement;
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
    
    const input = document.body.querySelector('input[placeholder="Filter models..."]') as HTMLInputElement;
    input.value = 'model-b';
    input.dispatchEvent(new Event('input'));
    await nextTick();

    const listItems = Array.from(document.body.querySelectorAll('.custom-scrollbar button'));
    expect(listItems.some(i => i.textContent?.includes('model-a'))).toBe(false);
    expect(listItems.some(i => i.textContent?.includes('model-b'))).toBe(true);
    expect(listItems.some(i => i.textContent?.includes('model-c'))).toBe(false);
    
    wrapper.unmount();
  });

  it('emits update:modelValue when a model is selected', async () => {
    const wrapper = mount(ModelSelector, {
      props: {
        modelValue: 'model-a',
      },
    });

    await wrapper.get('[data-testid="model-selector-trigger"]').trigger('click');
    
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
      const dropdown = document.body.querySelector('.animate-in') as HTMLElement;

      expect(dropdown.style.position).toBe('fixed');
      expect(dropdown.style.zIndex).toBe('9999');
      
      wrapper.unmount();
    });

    it('applies text wrapping classes to model names', async () => {
      const wrapper = mount(ModelSelector, {
        props: { modelValue: 'model-a' },
      });

      await wrapper.get('[data-testid="model-selector-trigger"]').trigger('click');
      const modelSpan = document.body.querySelector('.custom-scrollbar button span.break-all');

      expect(modelSpan).toBeTruthy();
      expect(modelSpan?.classList.contains('whitespace-normal')).toBe(true);
      
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

    const spans = Array.from(document.body.querySelectorAll('.custom-scrollbar button span.break-all'));
    const displayedOrder = spans.map(span => span.textContent);

    expect(displayedOrder).toEqual(customModels);
    
    wrapper.unmount();
  });

  describe('Adaptive Positioning Features (New Specs)', () => {
    it('opens downward by default when space is available', async () => {
      const wrapper = mount(ModelSelector, { props: { modelValue: 'model-a' } });
      await wrapper.get('[data-testid="model-selector-trigger"]').trigger('click');
      
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
      expect(document.body.querySelector('.animate-in')).toBeTruthy();

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
        attachTo: document.body
      });
      
      await wrapper.get('[data-testid="model-selector-trigger"]').trigger('click');
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
      
      const dropdown = document.body.querySelector('.animate-in') as HTMLElement;
      expect(parseFloat(dropdown.style.width)).toBe(480);
      wrapper.unmount();
    });

    it('remains open when search input is focused and triggers height change (keyboard regression)', async () => {
      const wrapper = mount(ModelSelector, { 
        props: { modelValue: 'model-a' },
        attachTo: document.body 
      });
      
      // 1. Open dropdown
      await wrapper.get('[data-testid="model-selector-trigger"]').trigger('click');
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
          allowClear: true // index 0: Inherit, index 1: model-a, index 2: model-b, index 3: model-c
        } 
      });
      await wrapper.get('[data-testid="model-selector-trigger"]').trigger('click');
      
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
      const trigger = wrapper.get('[data-testid="model-selector-trigger"]');

      expect(document.body.querySelector('.animate-in')).toBeTruthy();
      await trigger.trigger('keydown', { key: 'Escape' });
      expect(document.body.querySelector('.animate-in')).toBeFalsy();
      wrapper.unmount();
    });

    it('resets highlighted index when search query changes', async () => {
      const wrapper = mount(ModelSelector, { props: { modelValue: 'model-a' } });
      await wrapper.get('[data-testid="model-selector-trigger"]').trigger('click');
      
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
