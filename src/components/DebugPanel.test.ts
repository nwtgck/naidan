import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { mount } from '@vue/test-utils';
import DebugPanel from './DebugPanel.vue';
import { useGlobalEvents } from '../composables/useGlobalEvents';
import { useLayout } from '../composables/useLayout';
import { ref } from 'vue';

vi.mock('../composables/useGlobalEvents', () => ({
  useGlobalEvents: vi.fn(),
}));

vi.mock('../composables/useLayout', () => ({
  useLayout: vi.fn(),
}));

describe('DebugPanel', () => {
  const mockClearEvents = vi.fn();
  const mockAddErrorEvent = vi.fn();
  const mockAddInfoEvent = vi.fn();
  const isDebugOpen = ref(false);

  beforeEach(() => {
    vi.clearAllMocks();
    isDebugOpen.value = false;
    (useGlobalEvents as unknown as Mock).mockReturnValue({
      events: [],
      eventCount: 0,
      errorCount: 0,
      clearEvents: mockClearEvents,
      addErrorEvent: mockAddErrorEvent,
      addInfoEvent: mockAddInfoEvent,
    });
    (useLayout as unknown as Mock).mockReturnValue({
      isDebugOpen,
      toggleDebug: vi.fn(() => {
        isDebugOpen.value = !isDebugOpen.value;
      }),
    });
  });

  it('is collapsed when isDebugOpen is false', () => {
    const wrapper = mount(DebugPanel);
    expect(wrapper.classes()).toContain('h-0');
    expect(wrapper.classes()).toContain('overflow-hidden');
  });

  it('is expanded when isDebugOpen is true', async () => {
    isDebugOpen.value = true;
    const wrapper = mount(DebugPanel);
    await wrapper.vm.$nextTick();
    expect(wrapper.classes()).toContain('h-72');
    expect(wrapper.classes()).toContain('overflow-visible');
    expect(wrapper.classes()).toContain('z-50');
    expect(wrapper.find('[data-testid="debug-content-area"]').exists()).toBe(true);
  });

  it('opens development tools menu when ... button is clicked', async () => {
    isDebugOpen.value = true;
    const wrapper = mount(DebugPanel);
    await wrapper.vm.$nextTick();

    const menuButton = wrapper.find('[data-testid="debug-menu-button"]');
    expect(menuButton.exists()).toBe(true);

    expect(wrapper.find('[data-testid="debug-menu-dropdown"]').exists()).toBe(false);

    // Using mousedown as the component uses @mousedown.stop
    await menuButton.trigger('mousedown');
    expect(wrapper.find('[data-testid="debug-menu-dropdown"]').exists()).toBe(true);

    expect(wrapper.find('[data-testid="trigger-test-info"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="trigger-test-error"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="open-opfs-explorer"]').exists()).toBe(true);
  });

  it('shows error badge when errorCount > 0', () => {
    isDebugOpen.value = true;
    (useGlobalEvents as unknown as Mock).mockReturnValue({
      events: [],
      eventCount: 1,
      errorCount: 1,
      clearEvents: mockClearEvents,
      addErrorEvent: mockAddErrorEvent,
      addInfoEvent: mockAddInfoEvent,
    });
    const wrapper = mount(DebugPanel);
    expect(wrapper.find('[data-testid="debug-error-badge"]').exists()).toBe(true);
    expect(wrapper.text()).toContain('1 Errors');
  });

  it('calls clearEvents when clear button is clicked', async () => {
    isDebugOpen.value = true;
    (useGlobalEvents as unknown as Mock).mockReturnValue({
      events: [{ id: '1', type: 'info', timestamp: Date.now(), source: 'test', message: 'test' }],
      eventCount: 1,
      errorCount: 0,
      clearEvents: mockClearEvents,
      addErrorEvent: mockAddErrorEvent,
      addInfoEvent: mockAddInfoEvent,
    });
    const wrapper = mount(DebugPanel);
    await wrapper.find('[data-testid="debug-clear-button"]').trigger('click');
    expect(mockClearEvents).toHaveBeenCalled();
  });

  it('triggers test events from menu', async () => {
    isDebugOpen.value = true;
    const wrapper = mount(DebugPanel);
    await wrapper.vm.$nextTick();

    await wrapper.find('[data-testid="debug-menu-button"]').trigger('mousedown');

    await wrapper.find('[data-testid="trigger-test-info"]').trigger('click');
    expect(mockAddInfoEvent).toHaveBeenCalled();

    await wrapper.find('[data-testid="debug-menu-button"]').trigger('mousedown');
    await wrapper.find('[data-testid="trigger-test-error"]').trigger('click');
    expect(mockAddErrorEvent).toHaveBeenCalled();
  });

  it('renders error object details correctly', async () => {
    isDebugOpen.value = true;
    const error = new Error('Test error message');
    error.stack = 'test stack trace';

    (useGlobalEvents as unknown as Mock).mockReturnValue({
      events: [{
        id: '1',
        type: 'error',
        timestamp: Date.now(),
        source: 'test',
        message: 'Something failed',
        details: error,
      }],
      eventCount: 1,
      errorCount: 1,
      clearEvents: mockClearEvents,
      addErrorEvent: mockAddErrorEvent,
      addInfoEvent: mockAddInfoEvent,
    });

    const wrapper = mount(DebugPanel);
    const pre = wrapper.find('pre');
    expect(pre.text()).toContain('"name": "Error"');
    expect(pre.text()).toContain('"message": "Test error message"');
    expect(pre.text()).toContain('"stack": "test stack trace"');
  });

  it('handles circular references in details gracefully', async () => {
    isDebugOpen.value = true;
    const circular: Record<string, unknown> = { a: 1 };
    circular.self = circular;

    (useGlobalEvents as unknown as Mock).mockReturnValue({
      events: [{
        id: '1',
        type: 'error',
        timestamp: Date.now(),
        source: 'test',
        message: 'Circular',
        details: circular,
      }],
      eventCount: 1,
      errorCount: 1,
      clearEvents: mockClearEvents,
      addErrorEvent: mockAddErrorEvent,
      addInfoEvent: mockAddInfoEvent,
    });

    const wrapper = mount(DebugPanel);
    expect(wrapper.find('pre').text()).toBe('[Unserializable Details]');
  });

  it('closes menu when clicking outside', async () => {
    isDebugOpen.value = true;
    const wrapper = mount(DebugPanel, { attachTo: document.body });
    await wrapper.vm.$nextTick();

    await wrapper.find('[data-testid="debug-menu-button"]').trigger('mousedown');
    expect(wrapper.find('[data-testid="debug-menu-dropdown"]').exists()).toBe(true);

    document.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    await wrapper.vm.$nextTick();

    expect(wrapper.find('[data-testid="debug-menu-dropdown"]').exists()).toBe(false);
    wrapper.unmount();
  });
});
