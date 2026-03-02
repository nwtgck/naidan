import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import PrintView from './PrintView.vue';

describe('PrintView component', () => {
  it('should render slot content and root classes', () => {
    const wrapper = mount(PrintView, {
      slots: {
        default: '<div class="test-content">Slot Content</div>'
      }
    });

    // Find the container explicitly to bypass any fragment issues
    const root = wrapper.find('.naidan-print-view-layer');
    expect(root.exists()).toBe(true);
    expect(root.classes()).toContain('naidan-print-view-layer');
    expect(root.classes()).toContain('bg-white');
    expect(root.classes()).toContain('dark:bg-gray-950');

    // Check if slot content exists
    expect(root.find('.test-content').exists()).toBe(true);
    expect(root.find('.test-content').text()).toBe('Slot Content');
  });
});
