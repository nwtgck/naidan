import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import TransformersJsManager from './TransformersJsManager.vue';

// Mock the service
vi.mock('../services/transformers-js', () => ({
  transformersJsService: {
    getState: vi.fn().mockReturnValue({
      status: 'idle',
      progress: 0,
      error: null,
      activeModelId: null,
      device: 'cpu',
      isCached: false,
      isLoadingFromCache: false,
    }),
    subscribe: vi.fn().mockReturnValue(() => {}),
    subscribeModelList: vi.fn().mockReturnValue(() => {}),
    listCachedModels: vi.fn().mockResolvedValue([]),
  },
}));

// Mock useToast and useConfirm
vi.mock('../composables/useToast', () => ({
  useToast: () => ({ addToast: vi.fn() }),
}));

vi.mock('../composables/useConfirm', () => ({
  useConfirm: () => ({ showConfirm: vi.fn() }),
}));

describe('TransformersJsManager Dropdown', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should open the dropdown downwards with correct classes', async () => {
    const wrapper = mount(TransformersJsManager);

    // Find the input to trigger dropdown focus or button to toggle
    const input = wrapper.find('input[placeholder*="Hugging Face model ID"]');

    // Check dropdown is initially not visible
    expect(wrapper.find('.absolute.z-50.top-full').exists()).toBe(false);

    // Trigger focus to open dropdown
    await input.trigger('focus');

    // Find the dropdown container
    const dropdown = wrapper.find('.absolute.z-50.top-full');
    expect(dropdown.exists()).toBe(true);

    // Verify positioning and animation classes for downward opening
    // It should have 'top-full' and 'mt-3' (was bottom-full mb-3)
    // and 'slide-in-from-top-2' (was slide-in-from-bottom-2)
    expect(dropdown.classes()).toContain('top-full');
    expect(dropdown.classes()).toContain('mt-3');
    expect(dropdown.classes()).toContain('slide-in-from-top-2');

    // Ensure it does NOT have the old upward classes
    expect(dropdown.classes()).not.toContain('bottom-full');
    expect(dropdown.classes()).not.toContain('mb-3');
    expect(dropdown.classes()).not.toContain('slide-in-from-bottom-2');
  });
});
