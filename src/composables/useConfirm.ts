import { ref } from 'vue';

interface ConfirmOptions {
  title?: string;
  message?: string;
  confirmButtonText?: string;
  cancelButtonText?: string;
  confirmButtonVariant?: 'default' | 'danger'; // Add new variant
}

const isConfirmOpen = ref(false);
const confirmTitle = ref('');
const confirmMessage = ref('');
const confirmConfirmButtonText = ref('Confirm');
const confirmCancelButtonText = ref('Cancel');
const confirmButtonVariant = ref<'default' | 'danger'>('default'); // New ref for variant
let resolvePromise: ((value: boolean) => void) | undefined;

export function useConfirm() {
  const showConfirm = (options: ConfirmOptions): Promise<boolean> => {
    return new Promise((resolve) => {
      confirmTitle.value = options.title || 'Confirm';
      confirmMessage.value = options.message || '';
      confirmConfirmButtonText.value = options.confirmButtonText || 'Confirm';
      confirmCancelButtonText.value = options.cancelButtonText || 'Cancel';
      confirmButtonVariant.value = options.confirmButtonVariant || 'default'; // Set variant
      isConfirmOpen.value = true;
      resolvePromise = resolve;
    });
  };

  const hideConfirm = () => {
    isConfirmOpen.value = false;
    confirmButtonVariant.value = 'default'; // Reset variant on close
    resolvePromise = undefined; // Clear the resolve function
  };

  const handleConfirm = () => {
    if (resolvePromise) { // Check first
      resolvePromise(true);
    }
    hideConfirm(); // Then hide
  };

  const handleCancel = () => {
    if (resolvePromise) { // Check first
      resolvePromise(false); // Resolve with false on cancel
    }
    hideConfirm(); // Then hide
  };

  return {
    isConfirmOpen,
    confirmTitle,
    confirmMessage,
    confirmConfirmButtonText,
    confirmCancelButtonText,
    confirmButtonVariant, // Expose the variant
    showConfirm,
    handleConfirm,
    handleCancel,
  };
}