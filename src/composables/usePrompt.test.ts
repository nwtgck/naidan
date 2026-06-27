import { describe, it, expect, vi, beforeEach } from 'vitest';
import { nextTick } from 'vue'; // Imported nextTick from vue
import { usePrompt } from './usePrompt';
import { mount } from '@vue/test-utils';
import { defineComponent } from 'vue';

// Mock the global CustomDialog component
const MockCustomDialog = defineComponent({
  props: ['isOpen', 'title', 'message', 'confirmButtonText', 'cancelButtonText', 'confirmButtonVariant', 'showInput', 'inputType', 'inputPlaceholder', 'inputValue'],
  emits: ['confirm', 'cancel', 'update:inputValue'], // Added update:inputValue
  template: `
    <div v-if="isOpen" data-testid="mock-custom-dialog">
      <h2>{{ title }}</h2>
      <p>{{ message }}</p>
      <input 
        v-if="showInput" 
        :type="inputType" 
        :placeholder="inputPlaceholder" 
        :value="inputValue" 
        @input="$emit('update:inputValue', $event.target.value)"
        data-testid="mock-input-field"
      >
      <button @click="$emit('confirm', inputValue)" data-testid="mock-confirm-button">{{ confirmButtonText }}</button>
      <button @click="$emit('cancel')" data-testid="mock-cancel-button">{{ cancelButtonText }}</button>
    </div>
  `,
});

describe('usePrompt', () => {
  let promptHook: ReturnType<typeof usePrompt>;
  // Removed: let wrapper: ReturnType<typeof mount>; // Hold the wrapper instance

  // A helper component to "mount" the composable and provide global dialog instances
  const TestComponent = defineComponent({
    setup() {
      promptHook = usePrompt();
      return { ...promptHook }; // Expose all returned refs and functions
    },
    components: { MockCustomDialog },
    template: `
      <MockCustomDialog
        :is-open="isPromptOpen"
        :title="promptTitle"
        :message="promptMessage"
        :confirm-button-text="promptConfirmButtonText"
        :cancel-button-text="promptCancelButtonText"
        :show-input="true"
        :input-value="promptInputValue"
        @update:inputValue="promptInputValue = $event"
        @confirm="handlePromptConfirm"
        @cancel="handlePromptCancel"
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

  it('showPrompt returns a promise', () => {
    const promise = promptHook.showPrompt({ message: 'Enter name:' });
    expect(promise).toBeInstanceOf(Promise);
  });

  it('showPrompt resolves with the input value on confirmation', async () => {
    const promptPromise = promptHook.showPrompt({ message: 'Enter value:', defaultValue: 'initial' });
    await nextTick(); // Wait for the dialog state to update

    // Simulate user input
    promptHook.promptInputValue.value = 'test input';
    // Simulate confirmation by calling the composable's handler
    promptHook.handlePromptConfirm();
    await nextTick(); // Wait for promise to resolve

    const result = await promptPromise;
    expect(result).toBe('test input');
    expect(promptHook.isPromptOpen.value).toBe(false); // Check dialog closed
  });

  it('showPrompt resolves to null on cancellation', async () => {
    const promptPromise = promptHook.showPrompt({ message: 'Enter value:' });
    await nextTick(); // Wait for the dialog state to update

    // Simulate cancellation by calling the composable's handler
    promptHook.handlePromptCancel();
    await nextTick(); // Wait for promise to resolve

    const result = await promptPromise;
    expect(result).toBeNull();
    expect(promptHook.isPromptOpen.value).toBe(false); // Check dialog closed
  });

  it('passes title, message, defaultValue, inputType, and placeholder correctly', async () => {
    const options = {
      title: 'Prompt Title',
      message: 'Please provide:',
      defaultValue: 'default_text',
      inputType: 'email' as const,
      inputPlaceholder: 'example@email.com',
      confirmButtonText: 'Submit',
      cancelButtonText: 'No Thanks',
    };
    promptHook.showPrompt(options);
    await nextTick(); // Wait for the dialog state to update

    expect(promptHook.isPromptOpen.value).toBe(true);
    expect(promptHook.promptTitle.value).toBe(options.title);
    expect(promptHook.promptMessage.value).toBe(options.message);
    expect(promptHook.promptInputValue.value).toBe(options.defaultValue);
    // Note: inputType and inputPlaceholder are not exposed by usePrompt, but passed to CustomDialog
    expect(promptHook.promptConfirmButtonText.value).toBe(options.confirmButtonText);
    expect(promptHook.promptCancelButtonText.value).toBe(options.cancelButtonText);
  });
});
