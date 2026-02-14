import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { nextTick, markRaw } from 'vue'; // Import nextTick and markRaw from vue
import { mount } from '@vue/test-utils';
import CustomDialog from './CustomDialog.vue';

const mockSetActiveFocusArea = vi.fn();

vi.mock('../composables/useLayout', () => ({
  useLayout: () => ({
    setActiveFocusArea: mockSetActiveFocusArea,
  }),
}));

describe('CustomDialog.vue', () => {
  let wrapper: ReturnType<typeof mount>;
  let attachPoint: HTMLElement; // Declare attachPoint outside beforeEach

  beforeEach(async () => { // Make beforeEach async
    attachPoint = document.createElement('div'); // Create a new div
    document.body.appendChild(attachPoint); // Append it to body

    wrapper = mount(CustomDialog, {
      props: {
        show: true, // Correct prop name
        title: 'Test Title',
        message: 'Test Message',
        confirmButtonText: 'Confirm',
        cancelButtonText: 'Cancel',
        confirmButtonVariant: 'default', // Add this required prop
      },
      attachTo: attachPoint, // Attach to the new div
    });
    await nextTick(); // Wait for component to render
  });

  afterEach(() => { // Added afterEach
    wrapper.unmount();
    document.body.removeChild(attachPoint); // Clean up the div
  });

  it('renders correctly with title and message', () => {
    expect(wrapper.find('[data-testid="dialog-title"]').text()).toBe('Test Title');
    expect(wrapper.find('[data-testid="dialog-message"]').text()).toBe('Test Message');
    expect(wrapper.find('button[data-testid="dialog-confirm-button"]').text()).toBe('Confirm');
    expect(wrapper.find('button[data-testid="dialog-cancel-button"]').text()).toBe('Cancel');
  });

  it('applies danger variant to confirm button', async () => {
    await wrapper.setProps({ confirmButtonVariant: 'danger' });
    const confirmButton = wrapper.find('button[data-testid="dialog-confirm-button"]');
    expect(confirmButton.classes()).toContain('bg-red-600');
    expect(confirmButton.classes()).toContain('hover:bg-red-700');
    // Ensure default variant classes are NOT present
    expect(confirmButton.classes()).not.toContain('bg-indigo-600');
    expect(confirmButton.classes()).not.toContain('hover:bg-indigo-700');
  });

  it('shows input field when showInput is true', async () => {
    await wrapper.setProps({ showInput: true, inputPlaceholder: 'Enter value' });
    const inputField = wrapper.find('input[data-testid="dialog-input"]');
    expect(inputField.exists()).toBe(true);
    expect((inputField.element as HTMLInputElement).placeholder).toBe('Enter value');
  });

  it('updates input value', async () => {
    await wrapper.setProps({ showInput: true });
    const inputField = wrapper.find('input[data-testid="dialog-input"]');
    await inputField.setValue('new value');
    expect((inputField.element as HTMLInputElement).value).toBe('new value');
  });

  it('emits confirm event with input value if present', async () => {
    await wrapper.setProps({ showInput: true });
    const inputField = wrapper.find('input[data-testid="dialog-input"]');
    await inputField.setValue('input value'); // Sets native input value, emits 'update:inputValue'

    // Simulate parent updating the prop in response to 'update:inputValue'
    await wrapper.setProps({ inputValue: 'input value' }); // Add this line

    await wrapper.find('button[data-testid="dialog-confirm-button"]').trigger('click');
    expect(wrapper.emitted('confirm')).toBeTruthy();
    expect(wrapper.emitted('confirm')![0]).toEqual(['input value']);
  });

  it('emits confirm event without input value if not present', async () => {
    await wrapper.find('button[data-testid="dialog-confirm-button"]').trigger('click');
    expect(wrapper.emitted().confirm).toHaveLength(1); // Check if event was emitted once
    expect(wrapper.emitted().confirm![0]).toEqual([]); // Confirm event with no payload emits an empty array
  });

  it('emits cancel event when cancel button is clicked', async () => {
    await wrapper.find('button[data-testid="dialog-cancel-button"]').trigger('click');
    expect(wrapper.emitted('cancel')).toBeTruthy();
  });

  it('emits cancel event when close button (X) is clicked', async () => {
    await wrapper.find('button[data-testid="dialog-close-x"]').trigger('click');
    expect(wrapper.emitted('cancel')).toBeTruthy();
  });

  it('emits cancel event when escape key is pressed', async () => {
    const overlay = wrapper.find('[data-testid="custom-dialog-overlay"]');
    await overlay.trigger('keydown.esc');
    expect(wrapper.emitted('cancel')).toBeTruthy();
  });

  it('does not render when show is false', async () => {
    await wrapper.setProps({ show: false });
    expect(wrapper.find('[data-testid="custom-dialog-overlay"]').exists()).toBe(false);
  });

  it('applies the weakened backdrop blur class', () => {
    const overlay = wrapper.find('[data-testid="custom-dialog-overlay"]');
    expect(overlay.classes()).toContain('backdrop-blur-[2px]');
  });

  it('applies animation classes for entrance effects', () => {
    const dialogContent = wrapper.find('.modal-content-zoom');
    expect(dialogContent.exists()).toBe(true);
  });

  it('renders icon when provided', async () => {
    const TestIcon = markRaw({ template: '<svg data-testid="test-icon"></svg>' });
    await wrapper.setProps({ icon: TestIcon });
    expect(wrapper.find('[data-testid="test-icon"]').exists()).toBe(true);
  });

  it('sets active focus area to dialog on click or focusin', async () => {
    const overlay = wrapper.find('[data-testid="custom-dialog-overlay"]');

    await overlay.trigger('click');
    expect(mockSetActiveFocusArea).toHaveBeenCalledWith('dialog');

    mockSetActiveFocusArea.mockClear();
    await overlay.trigger('focusin');
    expect(mockSetActiveFocusArea).toHaveBeenCalledWith('dialog');
  });
});
