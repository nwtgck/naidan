import { ref, shallowRef, type Component } from 'vue';

interface ConfirmOptions {
  title?: string;
  message?: string;
  confirmButtonText?: string;
  cancelButtonText?: string;
  confirmButtonVariant?: 'default' | 'danger'; // Add new variant
  icon?: Component; // Change to Component
}

const isConfirmOpen = ref(false);
const confirmTitle = ref('');
const confirmMessage = ref('');
const confirmConfirmButtonText = ref('Confirm');
const confirmCancelButtonText = ref('Cancel');
const confirmButtonVariant = ref<'default' | 'danger'>('default'); // New ref for variant
const confirmIcon = shallowRef<Component | undefined>(undefined); // Use shallowRef for components
// eslint-disable-next-line local-rules-named-args/require-named-args -- Kept positional because this stores the native Promise resolve callback contract.
let resolvePromise: ((value: boolean) => void) | undefined;

export function useConfirm() {
  const showConfirm = ({ title, message, confirmButtonText, cancelButtonText, confirmButtonVariant: buttonVariant, icon }: ConfirmOptions): Promise<boolean> => {
    return new Promise((resolve) => {
      confirmTitle.value = title || 'Confirm';
      confirmMessage.value = message || '';
      confirmConfirmButtonText.value = confirmButtonText || 'Confirm';
      confirmCancelButtonText.value = cancelButtonText || 'Cancel';
      confirmButtonVariant.value = buttonVariant || 'default'; // Set variant
      confirmIcon.value = icon; // Set icon
      isConfirmOpen.value = true;
      resolvePromise = resolve;
    });
  };

  const hideConfirm = () => {
    isConfirmOpen.value = false;
    confirmButtonVariant.value = 'default'; // Reset variant on close
    confirmIcon.value = undefined; // Reset icon on close
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
    confirmIcon, // Expose the icon
    showConfirm,
    handleConfirm,
    handleCancel,
    TEST_ONLY: {
      // Export internal state and logic used only for testing here. Do not reference these in production logic.
    },
  };
}
