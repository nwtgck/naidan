import { ref } from 'vue';

interface DialogOptions {
  title?: string;
  message?: string;
  confirmButtonText?: string;
  cancelButtonText?: string;
  type?: 'confirm' | 'alert' | 'prompt'; // Future expansion
}

const isDialogOpen = ref(false);
const dialogTitle = ref('');
const dialogMessage = ref('');
const dialogConfirmButtonText = ref('Confirm');
const dialogCancelButtonText = ref('Cancel');
let resolvePromise: ((value: boolean) => void) | undefined;

export function useDialog() {
  const showDialog = (options: DialogOptions): Promise<boolean> => {
    return new Promise((resolve) => {
      dialogTitle.value = options.title || 'Dialog';
      dialogMessage.value = options.message || '';
      dialogConfirmButtonText.value = options.confirmButtonText || 'Confirm';
      dialogCancelButtonText.value = options.cancelButtonText || 'Cancel';
      isDialogOpen.value = true;
      resolvePromise = resolve;
    });
  };

  const hideDialog = () => {
    isDialogOpen.value = false;
    resolvePromise = undefined; // Clear the resolve function
  };

  const handleConfirm = () => {
    hideDialog();
    if (resolvePromise) {
      resolvePromise(true);
    }
  };

  const handleCancel = () => {
    hideDialog();
    if (resolvePromise) {
      resolvePromise(false); // Resolve with false on cancel
    }
  };

  return {
    isDialogOpen,
    dialogTitle,
    dialogMessage,
    dialogConfirmButtonText,
    dialogCancelButtonText,
    showDialog,
    handleConfirm,
    handleCancel,
  };
}