import { ref, shallowRef, type Component } from 'vue';
import { ensureStrings } from '@/strings';

interface ConfirmOptions {
  title?: string,
  message?: string,
  confirmButtonText?: string,
  cancelButtonText?: string,
  confirmButtonVariant?: 'default' | 'danger', // Add new variant
  icon?: Component, // Change to Component
}

const isConfirmOpen = ref(false);
const confirmTitle = ref('');
const confirmMessage = ref('');
const confirmConfirmButtonText = ref('Confirm');
const confirmCancelButtonText = ref('Cancel');
const confirmButtonVariant = ref<'default' | 'danger'>('default'); // New ref for variant
const confirmIcon = shallowRef<Component | undefined>(undefined); // Use shallowRef for components
let resolvePromise: ReturnType<typeof Promise.withResolvers<boolean>>['resolve'] | undefined;

export function useConfirm() {
  const showConfirm = async ({ title, message, confirmButtonText, cancelButtonText, confirmButtonVariant: buttonVariant, icon }: ConfirmOptions): Promise<boolean> => {
    const [resolvedTitle, resolvedConfirmButtonText, resolvedCancelButtonText] = await Promise.all([
      title ? Promise.resolve(title) : ensureStrings.SHARED__confirm(),
      confirmButtonText ? Promise.resolve(confirmButtonText) : ensureStrings.SHARED__confirm(),
      cancelButtonText ? Promise.resolve(cancelButtonText) : ensureStrings.SHARED__cancel(),
    ]);

    return new Promise((resolve) => {
      confirmTitle.value = resolvedTitle;
      confirmMessage.value = message || '';
      confirmConfirmButtonText.value = resolvedConfirmButtonText;
      confirmCancelButtonText.value = resolvedCancelButtonText;
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
