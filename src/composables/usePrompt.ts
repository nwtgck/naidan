import { ref, type Component, shallowRef } from 'vue';

interface PromptOptions {
  title?: string;
  message?: string;
  confirmButtonText?: string;
  cancelButtonText?: string;
  defaultValue?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  bodyComponent?: Component | any | null;
}

const isPromptOpen = ref(false);
const promptTitle = ref('');
const promptMessage = ref('');
const promptConfirmButtonText = ref('Confirm');
const promptCancelButtonText = ref('Cancel');
const promptInputValue = ref('');
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const promptBodyComponent = shallowRef<Component | any | null>(null);
let resolvePromptPromise: ((value: string | null) => void) | undefined;

export function usePrompt() {
  const showPrompt = (options: PromptOptions): Promise<string | null> => {
    return new Promise((resolve) => {
      promptTitle.value = options.title || 'Prompt';
      promptMessage.value = options.message || '';
      promptConfirmButtonText.value = options.confirmButtonText || 'Confirm';
      promptCancelButtonText.value = options.cancelButtonText || 'Cancel';
      promptInputValue.value = options.defaultValue || '';
      promptBodyComponent.value = options.bodyComponent || null;
      isPromptOpen.value = true;
      resolvePromptPromise = resolve;
    });
  };

  const hidePrompt = () => {
    isPromptOpen.value = false;
    promptBodyComponent.value = null; // Clear the component
    resolvePromptPromise = undefined; // Clear the resolve function
  };

  const handlePromptConfirm = () => {
    if (resolvePromptPromise) { // Check first
      resolvePromptPromise(promptInputValue.value);
    }
    hidePrompt(); // Then hide
  };

  const handlePromptCancel = () => {
    if (resolvePromptPromise) { // Check first
      resolvePromptPromise(null); // Resolve with null on cancel
    }
    hidePrompt(); // Then hide
  };

  return {
    isPromptOpen,
    promptTitle,
    promptMessage,
    promptConfirmButtonText,
    promptCancelButtonText,
    promptInputValue,
    promptBodyComponent,
    showPrompt,
    handlePromptConfirm,
    handlePromptCancel,
    __testOnly: {
      // Export internal state and logic used only for testing here. Do not reference these in production logic.
    },
  };
}
