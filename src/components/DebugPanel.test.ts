import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import DebugPanel from './DebugPanel.vue';
import { useGlobalEvents } from '../composables/useGlobalEvents';

vi.mock('../composables/useGlobalEvents', () => ({
  useGlobalEvents: vi.fn()
}));

describe('DebugPanel', () => {
  const mockClearEvents = vi.fn();
  const mockAddErrorEvent = vi.fn();
  const mockAddInfoEvent = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    (useGlobalEvents as any).mockReturnValue({
      events: [],
      eventCount: 0,
      errorCount: 0,
      clearEvents: mockClearEvents,
      addErrorEvent: mockAddErrorEvent,
      addInfoEvent: mockAddInfoEvent
    });
  });

  it('is collapsed by default', () => {
    const wrapper = mount(DebugPanel);
    expect(wrapper.classes()).toContain('h-10');
    expect(wrapper.find('[data-testid="debug-content-area"]').exists()).toBe(false);
  });

  it('toggles when clicked', async () => {
    const wrapper = mount(DebugPanel);
    const toggle = wrapper.find('[data-testid="debug-panel-toggle"]');
    await toggle.trigger('click');
    expect(wrapper.classes()).toContain('h-64');
    expect(wrapper.find('[data-testid="debug-content-area"]').exists()).toBe(true);
  });

  it('shows error badge when errorCount > 0', () => {
    (useGlobalEvents as any).mockReturnValue({
      events: [],
      eventCount: 1,
      errorCount: 1,
      clearEvents: mockClearEvents,
      addErrorEvent: mockAddErrorEvent,
      addInfoEvent: mockAddInfoEvent
    });
    const wrapper = mount(DebugPanel);
    expect(wrapper.find('[data-testid="debug-error-badge"]').exists()).toBe(true);
    expect(wrapper.text()).toContain('1 Errors');
  });

  it('calls clearEvents when clear button is clicked', async () => {
    (useGlobalEvents as any).mockReturnValue({
      events: [{ id: '1', type: 'info', timestamp: Date.now(), source: 'test', message: 'test' }],
      eventCount: 1,
      errorCount: 0,
      clearEvents: mockClearEvents,
      addErrorEvent: mockAddErrorEvent,
      addInfoEvent: mockAddInfoEvent
    });
    const wrapper = mount(DebugPanel);
    await wrapper.find('[data-testid="debug-panel-toggle"]').trigger('click');
    await wrapper.find('[data-testid="debug-clear-button"]').trigger('click');
    expect(mockClearEvents).toHaveBeenCalled();
  });

  it('triggers test events from menu', async () => {
    const wrapper = mount(DebugPanel);
    await wrapper.find('[data-testid="debug-panel-toggle"]').trigger('click');
    await wrapper.find('[data-testid="debug-menu-button"]').trigger('click');
    
    await wrapper.find('[data-testid="trigger-test-info"]').trigger('click');
    expect(mockAddInfoEvent).toHaveBeenCalled();

    await wrapper.find('[data-testid="debug-menu-button"]').trigger('click');
    await wrapper.find('[data-testid="trigger-test-error"]').trigger('click');
    expect(mockAddErrorEvent).toHaveBeenCalled();
  });

  it('renders error object details correctly', async () => {
    const error = new Error('Test error message');
    error.stack = 'test stack trace';
    
    (useGlobalEvents as any).mockReturnValue({
      events: [{ 
        id: '1', 
        type: 'error', 
        timestamp: Date.now(), 
        source: 'test', 
        message: 'Something failed',
        details: error
      }],
      eventCount: 1,
      errorCount: 1,
      clearEvents: mockClearEvents,
      addErrorEvent: mockAddErrorEvent,
      addInfoEvent: mockAddInfoEvent
    });

    const wrapper = mount(DebugPanel);
    await wrapper.find('[data-testid="debug-panel-toggle"]').trigger('click');
    
    const pre = wrapper.find('pre');
    expect(pre.text()).toContain('"name": "Error"');
    expect(pre.text()).toContain('"message": "Test error message"');
    expect(pre.text()).toContain('"stack": "test stack trace"');
  });

  it('handles circular references in details gracefully', async () => {
    const circular: any = { a: 1 };
    circular.self = circular;

    (useGlobalEvents as any).mockReturnValue({
      events: [{ 
        id: '1', 
        type: 'error', 
        timestamp: Date.now(), 
        source: 'test', 
        message: 'Circular',
        details: circular
      }],
      eventCount: 1,
      errorCount: 1,
      clearEvents: mockClearEvents,
      addErrorEvent: mockAddErrorEvent,
      addInfoEvent: mockAddInfoEvent
    });

    const wrapper = mount(DebugPanel);
    await wrapper.find('[data-testid="debug-panel-toggle"]').trigger('click');
    
    expect(wrapper.find('pre').text()).toBe('[Unserializable Details]');
  });

  it('closes menu when clicking outside', async () => {
    const wrapper = mount(DebugPanel, { attachTo: document.body });
    await wrapper.find('[data-testid="debug-panel-toggle"]').trigger('click');
    await wrapper.find('[data-testid="debug-menu-button"]').trigger('click');
    
    expect(wrapper.find('[data-testid="debug-menu-dropdown"]').exists()).toBe(true);

    // Simulate click outside
    document.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    await wrapper.vm.$nextTick();

    expect(wrapper.find('[data-testid="debug-menu-dropdown"]').exists()).toBe(false);
    wrapper.unmount();
  });
});
