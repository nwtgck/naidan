import type { StorageType } from '@/01-models/types';
import { StorageTypeDtoSchema } from './00-dto/dto';

type StorageTypeValidationError = Extract<ReturnType<typeof StorageTypeDtoSchema.safeParse>, { success: false }>['error'];
type ParsedStorageType =
  | { status: 'valid', savedStorageType: StorageType }
  | { status: 'invalid', savedStorageTypeValidationError: StorageTypeValidationError };

export function bootstrapStorageTypeRecord({ key }: { key: string }) {
  return {
    key,
    read({ storage }: { storage: Pick<Storage, 'getItem'> | undefined }):
      | Extract<ParsedStorageType, { status: 'valid' }>
      | (Extract<ParsedStorageType, { status: 'invalid' }> & { rawSavedStorageType: string })
      | { status: 'missing' } {
      const text = storage?.getItem(key) ?? null;
      if (text === null) {
        return { status: 'missing' };
      }
      const parsed = StorageTypeDtoSchema.safeParse(text);
      if (parsed.success) {
        return { status: 'valid', savedStorageType: parsed.data };
      }
      return { status: 'invalid', rawSavedStorageType: text, savedStorageTypeValidationError: parsed.error };
    },
    write({ storage, type }: { storage: Pick<Storage, 'setItem'>, type: StorageType }): void {
      storage.setItem(key, type);
    },
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
export const TEST_ONLY = {
};
