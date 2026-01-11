import { ref } from 'vue';

interface PromptOptions {
  title?: string;
  message?: string;
  confirmButtonText?: string;
  cancelButtonText?: string;
  defaultValue?: string;
}

const isPromptOpen = ref(false);
const promptTitle = ref('');
const promptMessage = ref('');
const promptConfirmButtonText = ref('Confirm');
const promptCancelButtonText = ref('Cancel');
const promptInputValue = ref('');
let resolvePromptPromise: ((value: string | null) => void) | undefined;

export function usePrompt() {
  const showPrompt = (options: PromptOptions): Promise<string | null> => {
    return new Promise((resolve) => {
      promptTitle.value = options.title || 'Prompt';
      promptMessage.value = options.message || '';
      promptConfirmButtonText.value = options.confirmButtonText || 'Confirm';
      promptCancelButtonText.value = options.cancelButtonText || 'Cancel';
      promptInputValue.value = options.defaultValue || '';
      isPromptOpen.value = true;
      resolvePromptPromise = resolve;
    });
  };

  const hidePrompt = () => {
    isPromptOpen.value = false;
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
    showPrompt,
    handlePromptConfirm,
    handlePromptCancel,
  };
}
