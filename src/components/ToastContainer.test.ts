import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { mount } from '@vue/test-utils';
import ToastContainer from './ToastContainer.vue';
import { useToast } from '../composables/useToast';

vi.mock('../composables/useToast', () => ({
  useToast: vi.fn(),
}));

describe('ToastContainer', () => {
  const mockRemoveToast = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders nothing when there are no toasts', () => {
    (useToast as unknown as Mock).mockReturnValue({
      toasts: [],
      removeToast: mockRemoveToast,
    });
    const wrapper = mount(ToastContainer);
    expect(wrapper.findAll('.toast-enter-active').length).toBe(0);
    expect(wrapper.text()).toBe('');
  });

  it('renders toasts correctly', () => {
    (useToast as unknown as Mock).mockReturnValue({
      toasts: [
        { id: '1', message: 'Test message 1' },
        { id: '2', message: 'Test message 2', actionLabel: 'Undo' },
      ],
      removeToast: mockRemoveToast,
    });
    const wrapper = mount(ToastContainer);
    const toastElements = wrapper.findAll('.pointer-events-auto');
    expect(toastElements).toHaveLength(2);
    expect(wrapper.text()).toContain('Test message 1');
    expect(wrapper.text()).toContain('Test message 2');
    expect(wrapper.text()).toContain('Undo');
  });

  it('calls removeToast when close button is clicked', async () => {
    (useToast as unknown as Mock).mockReturnValue({
      toasts: [{ id: '1', message: 'Test message' }],
      removeToast: mockRemoveToast,
    });
    const wrapper = mount(ToastContainer);
    const closeButton = wrapper.find('button:not(.text-indigo-400)');
    await closeButton.trigger('click');
    expect(mockRemoveToast).toHaveBeenCalledWith('1', 'dismiss');
  });

  it('calls handleAction and removeToast when action button is clicked', async () => {
    const onAction = vi.fn();
    (useToast as unknown as Mock).mockReturnValue({
      toasts: [{ id: '1', message: 'Test message', actionLabel: 'Undo', onAction }],
      removeToast: mockRemoveToast,
    });
    const wrapper = mount(ToastContainer);
    const actionButton = wrapper.find('button.text-indigo-400');
    await actionButton.trigger('click');
    expect(onAction).toHaveBeenCalled();
    expect(mockRemoveToast).toHaveBeenCalledWith('1', 'action');
  });

  it('renders multiple toasts in order', () => {
    (useToast as unknown as Mock).mockReturnValue({
      toasts: [
        { id: '1', message: 'First toast' },
        { id: '2', message: 'Second toast' },
        { id: '3', message: 'Third toast' },
      ],
      removeToast: mockRemoveToast,
    });
    const wrapper = mount(ToastContainer);
    const messages = wrapper.findAll('.text-sm.flex-1').map(el => el.text());
    expect(messages).toEqual(['First toast', 'Second toast', 'Third toast']);
  });
});
