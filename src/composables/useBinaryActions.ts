import { storageService } from '@/00-storage/service';
import { idToRaw } from '@/01-models/ids';
import { useConfirm } from './useConfirm';
import { useImagePreview } from './useImagePreview';
import type { BinaryObject } from '@/01-models/types';
import type { BinaryObjectId } from '@/01-models/ids';
import { ensureStrings } from '@/strings';

export function useBinaryActions() {
  const { showConfirm } = useConfirm();
  const { closePreview } = useImagePreview();

  const deleteBinaryObject = async ({ id }: { id: BinaryObjectId }) => {
    const obj = await storageService.getBinaryObject({ binaryObjectId: id });
    const name = obj?.name || idToRaw({ id });

    const confirmed = await showConfirm({
      title: await ensureStrings.useBinaryActions__delete_binary_object(),
      message: await ensureStrings.useBinaryActions__delete_binary_object_warning({ name }),
      confirmButtonText: await ensureStrings.useBinaryActions__delete_permanently(),
      confirmButtonVariant: 'danger',
    });

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
    ...((__BUILD_MODE_IS_TEST__ && {
      TEST_ONLY: {
        // Export internal state and logic used only for testing here. Do not reference these in production logic.
      },
    }) || {}),
  };
}
