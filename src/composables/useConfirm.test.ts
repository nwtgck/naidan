import { describe, it, expect, vi, beforeEach } from 'vitest';
import { nextTick } from 'vue'; // Imported nextTick from vue
import { useConfirm } from './useConfirm';
import { mount } from '@vue/test-utils';
import { defineComponent } from 'vue';

// Mock the global CustomDialog component
const MockCustomDialog = defineComponent({
  props: ['isOpen', 'title', 'message', 'confirmButtonText', 'cancelButtonText', 'confirmButtonVariant', 'showInput', 'inputType', 'inputPlaceholder', 'inputValue'],
  emits: ['confirm', 'cancel'],
  template: `
    <div v-if="isOpen" data-testid="mock-custom-dialog">
      <h2>{{ title }}</h2>
      <p>{{ message }}</p>
      <input v-if="showInput" :type="inputType" :placeholder="inputPlaceholder" :value="inputValue" @input="$emit('confirm', $event.target.value)">
      <button @click="$emit('confirm', inputValue)" data-testid="mock-confirm-button">{{ confirmButtonText }}</button>
      <button @click="$emit('cancel')" data-testid="mock-cancel-button">{{ cancelButtonText }}</button>
    </div>
  `,
});

describe('useConfirm', () => {
  let confirmHook: ReturnType<typeof useConfirm>;
  // Removed: let wrapper: ReturnType<typeof mount>; // Hold the wrapper instance

  // A helper component to "mount" the composable and provide global dialog instances
  const TestComponent = defineComponent({
    setup() {
      confirmHook = useConfirm();
      return { ...confirmHook }; // Expose all returned refs and functions
    },
    components: { MockCustomDialog },
    template: `
      <MockCustomDialog
        :is-open="isConfirmOpen"
        :title="confirmTitle"
        :message="confirmMessage"
        :confirm-button-text="confirmConfirmButtonText"
        :cancel-button-text="confirmCancelButtonText"
        :confirm-button-variant="confirmButtonVariant"
        @confirm="handleConfirm"
        @cancel="handleCancel"
      />
    `,
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mount(TestComponent, { // No longer assign to wrapper
      global: {
        stubs: {
          CustomDialog: MockCustomDialog,
        },
      },
    });
  });

  it('showConfirm returns a promise', () => {
    const promise = confirmHook.showConfirm({ message: 'Are you sure?' });
    expect(promise).toBeInstanceOf(Promise);
  });

  it('showConfirm resolves to true on confirmation', async () => {
    const confirmPromise = confirmHook.showConfirm({ message: 'Confirm this?' });
    await nextTick(); // Wait for the dialog state to update

    // Simulate confirmation by calling the composable's handler
    confirmHook.handleConfirm();
    await nextTick(); // Wait for promise to resolve

    const result = await confirmPromise;
    expect(result).toBe(true);
    expect(confirmHook.isConfirmOpen.value).toBe(false); // Check dialog closed
  });

  it('showConfirm resolves to false on cancellation', async () => {
    const confirmPromise = confirmHook.showConfirm({ message: 'Cancel this?' });
    await nextTick(); // Wait for the dialog state to update

    // Simulate cancellation by calling the composable's handler
    confirmHook.handleCancel();
    await nextTick(); // Wait for promise to resolve

    const result = await confirmPromise;
    expect(result).toBe(false);
    expect(confirmHook.isConfirmOpen.value).toBe(false); // Check dialog closed
  });

  it('passes title, message, and button texts correctly', async () => {
    const options = {
      title: 'Custom Title',
      message: 'Custom Message',
      confirmButtonText: 'Proceed',
      cancelButtonText: 'Go Back',
      confirmButtonVariant: 'danger' as const,
    };
    confirmHook.showConfirm(options);
    await nextTick(); // Wait for the dialog state to update

    expect(confirmHook.isConfirmOpen.value).toBe(true);
    expect(confirmHook.confirmTitle.value).toBe(options.title);
    expect(confirmHook.confirmMessage.value).toBe(options.message);
    expect(confirmHook.confirmConfirmButtonText.value).toBe(options.confirmButtonText);
    expect(confirmHook.confirmCancelButtonText.value).toBe(options.cancelButtonText);
    expect(confirmHook.confirmButtonVariant.value).toBe(options.confirmButtonVariant);
  });
});
