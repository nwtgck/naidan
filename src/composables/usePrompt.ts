import { ref, type Component, shallowRef } from 'vue';

interface PromptOptions {
  title?: string,
  message?: string,
  confirmButtonText?: string,
  cancelButtonText?: string,
  defaultValue?: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  bodyComponent?: Component | any | null,
}

const isPromptOpen = ref(false);
const promptTitle = ref('');
const promptMessage = ref('');
const promptConfirmButtonText = ref('Confirm');
const promptCancelButtonText = ref('Cancel');
const promptInputValue = ref('');
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const promptBodyComponent = shallowRef<Component | any | null>(null);
let resolvePromptPromise: ReturnType<typeof Promise.withResolvers<string | null>>['resolve'] | undefined;

export function usePrompt() {
  const showPrompt = ({ title, message, confirmButtonText, cancelButtonText, defaultValue, bodyComponent }: PromptOptions): Promise<string | null> => {
    return new Promise((resolve) => {
      promptTitle.value = title || 'Prompt';
      promptMessage.value = message || '';
      promptConfirmButtonText.value = confirmButtonText || 'Confirm';
      promptCancelButtonText.value = cancelButtonText || 'Cancel';
      promptInputValue.value = defaultValue || '';
      promptBodyComponent.value = bodyComponent || null;
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
    TEST_ONLY: {
      // Export internal state and logic used only for testing here. Do not reference these in production logic.
    },
  };
}
