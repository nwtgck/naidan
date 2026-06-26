import { storageService } from '@/services/storage';
import { idToRaw } from '@/models/ids';
import { useConfirm } from './useConfirm';
import { useImagePreview } from './useImagePreview';
import type { BinaryObject } from '@/models/types';
import type { BinaryObjectId } from '@/models/ids';
import { ensureStrings } from '@/strings';

export function useBinaryActions() {
  const { showConfirm } = useConfirm();
  const { closePreview } = useImagePreview();

  const deleteBinaryObject = async ({ id }: { id: BinaryObjectId }) => {
    const obj = await storageService.getBinaryObject({ binaryObjectId: id });
    const name = obj?.name || idToRaw({ id });

    const [title, message, confirmButtonText] = await Promise.all([
      ensureStrings.useBinaryActions__delete_binary_object(),
      ensureStrings.useBinaryActions__delete_binary_object_warning({ name }),
      ensureStrings.useBinaryActions__delete_permanently(),
    ]);
    const confirmed = await showConfirm({ title, message, confirmButtonText, confirmButtonVariant: 'danger' });

    if (confirmed) {
      try {
        await storageService.deleteBinaryObject({ binaryObjectId: id });
        closePreview();
        return true;
      } catch (error) {
        console.error('Failed to delete binary object:', error);
      }
    }
    return false;
  };

  const downloadBinaryObject = async ({ obj }: { obj: Pick<BinaryObject, 'id' | 'name'> }) => {
    const blob = await storageService.getFile({ binaryObjectId: obj.id });
    if (!blob) return;

    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = obj.name || idToRaw({ id: obj.id });
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  return {
    deleteBinaryObject,
    downloadBinaryObject,
    TEST_ONLY: {
      // Export internal state and logic used only for testing here. Do not reference these in production logic.
    },
  };
}
