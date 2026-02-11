import { storageService } from '../services/storage';
import { useConfirm } from './useConfirm';
import { useImagePreview } from './useImagePreview';

export function useBinaryActions() {
  const { showConfirm } = useConfirm();
  const { closePreview } = useImagePreview();

  const deleteBinaryObject = async (id: string) => {
    const obj = await storageService.getBinaryObject({ binaryObjectId: id });
    const name = obj?.name || id;

    const confirmed = await showConfirm({
      title: 'Delete Binary Object?',
      message: `Are you sure you want to delete "${name}"? This action cannot be undone. Any chat messages referencing this file will show it as missing.`,
      confirmButtonText: 'Delete Permanently',
      confirmButtonVariant: 'danger',
    });

    if (confirmed) {
      try {
        await storageService.deleteBinaryObject(id);
        closePreview();
        return true;
      } catch (error) {
        console.error('Failed to delete binary object:', error);
      }
    }
    return false;
  };

  const downloadBinaryObject = async (obj: { id: string; name?: string }) => {
    const blob = await storageService.getFile(obj.id);
    if (!blob) return;
    
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = obj.name || obj.id;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  return {
    deleteBinaryObject,
    downloadBinaryObject,
    __testOnly: {
      // Export internal state and logic used only for testing here. Do not reference these in production logic.
    },
  };
}
