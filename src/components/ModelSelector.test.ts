import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import ModelSelector from './ModelSelector.vue';
import { useSettings } from '../composables/useSettings';
import { ref } from 'vue';

// Mock useSettings
vi.mock('../composables/useSettings', () => ({
  useSettings: vi.fn(),
}));

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

    expect(wrapper.find('input[placeholder="Filter models..."]').exists()).toBe(true);
    expect(wrapper.text()).toContain('model-b');
    expect(wrapper.text()).toContain('model-c');

    await trigger.trigger('click');
    expect(wrapper.find('input[placeholder="Filter models..."]').exists()).toBe(false);
  });

  it('focuses the search input when the dropdown opens', async () => {
    // We need to attach to document for focus testing to work properly in some environments
    const wrapper = mount(ModelSelector, {
      props: {
        modelValue: 'model-a',
      },
      attachTo: document.body
    });

    const trigger = wrapper.get('[data-testid="model-selector-trigger"]');
    await trigger.trigger('click');
    
    const input = wrapper.get('input[placeholder="Filter models..."]');
    expect(document.activeElement).toBe(input.element);

    wrapper.unmount();
  });

  it('filters models based on search query', async () => {
    const wrapper = mount(ModelSelector, {
      props: {
        modelValue: 'model-a',
      },
    });

    await wrapper.get('[data-testid="model-selector-trigger"]').trigger('click');
    
    const input = wrapper.get('input[placeholder="Filter models..."]');
    await input.setValue('model-b');

    // Get all model buttons in the list (excluding search and refresh)
    const listItems = wrapper.findAll('.custom-scrollbar button');
    
    expect(listItems.some(i => i.text().includes('model-a'))).toBe(false);
    expect(listItems.some(i => i.text().includes('model-b'))).toBe(true);
    expect(listItems.some(i => i.text().includes('model-c'))).toBe(false);
  });

  it('emits update:modelValue when a model is selected', async () => {
    const wrapper = mount(ModelSelector, {
      props: {
        modelValue: 'model-a',
      },
    });

    await wrapper.get('[data-testid="model-selector-trigger"]').trigger('click');
    
    const options = wrapper.findAll('button').filter(b => b.text().includes('model-c'));
    await options[0]!.trigger('click');

    expect(wrapper.emitted('update:modelValue')).toBeTruthy();
    expect(wrapper.emitted('update:modelValue')![0]).toEqual(['model-c']);
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
    
    const clearBtn = wrapper.get('[data-testid="model-selector-clear"]');
    expect(clearBtn.text()).toContain('Use Global Default');
    await clearBtn.trigger('click');

    expect(wrapper.emitted('update:modelValue')).toBeTruthy();
    expect(wrapper.emitted('update:modelValue')![0]).toEqual([undefined]);
  });

  it('does not show clear option when allowClear is false', async () => {
    const wrapper = mount(ModelSelector, {
      props: {
        modelValue: 'model-a',
        allowClear: false,
      },
    });

    await wrapper.get('[data-testid="model-selector-trigger"]').trigger('click');
    expect(wrapper.find('[data-testid="model-selector-clear"]').exists()).toBe(false);
  });

  it('calls fetchModels when refresh button is clicked', async () => {
    const wrapper = mount(ModelSelector, {
      props: {
        modelValue: 'model-a',
      },
    });

    await wrapper.get('[data-testid="model-selector-trigger"]').trigger('click');
    
    const refreshBtn = wrapper.findAll('button').find(b => b.attributes('title') === 'Refresh model list');
    await refreshBtn!.trigger('click');

    expect(fetchModels).toHaveBeenCalled();
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
    it('has correct width classes for the dropdown to prevent clipping', async () => {
      const wrapper = mount(ModelSelector, {
        props: { modelValue: 'model-a' },
      });

      await wrapper.get('[data-testid="model-selector-trigger"]').trigger('click');
      const dropdown = wrapper.find('.absolute.z-50');

      expect(dropdown.classes()).toContain('min-w-full');
      expect(dropdown.classes()).toContain('w-max');
      // Using pattern match for max-width since it contains dynamic calculation
      expect(dropdown.attributes('class')).toContain('max-w-[min(480px,calc(100vw-2rem))]');
    });

    it('applies text wrapping classes to model names', async () => {
      const wrapper = mount(ModelSelector, {
        props: { modelValue: 'model-a' },
      });

      await wrapper.get('[data-testid="model-selector-trigger"]').trigger('click');
      const modelSpan = wrapper.find('button span.break-all');

      expect(modelSpan.exists()).toBe(true);
      expect(modelSpan.classes()).toContain('whitespace-normal');
    });
  });
});
