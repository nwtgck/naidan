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

    it('closes the dropdown automatically on window resize', async () => {
      const wrapper = mount(ModelSelector, { props: { modelValue: 'model-a' } });
      await wrapper.get('[data-testid="model-selector-trigger"]').trigger('click');
      expect(document.body.querySelector('.animate-in')).toBeTruthy();

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
  });
});
