import type { ZodError } from 'zod';
import type { StorageType } from '@/01-models/types';
import { STORAGE_BOOTSTRAP_KEY } from '@/constants';
import { StorageTypeSchemaDto } from '@/00-storage/00-dto/dto';

function parseStorageType({
  rawStorageType,
}: {
  rawStorageType: string,
}):
  | { status: 'valid', savedStorageType: StorageType }
  | { status: 'invalid', savedStorageTypeValidationError: ZodError } {
  const parsedStorageType = StorageTypeSchemaDto.safeParse(rawStorageType);
  if (parsedStorageType.success) {
    return {
      status: 'valid',
      savedStorageType: parsedStorageType.data,
    };
  }

  return {
    status: 'invalid',
    savedStorageTypeValidationError: parsedStorageType.error,
  };
}

export function readStoredBootstrapStorageType(): {
  rawSavedStorageType: string | null,
  parsedSavedStorageType:
    | { status: 'valid', savedStorageType: StorageType }
    | { status: 'invalid', savedStorageTypeValidationError: ZodError }
    | { status: 'missing' },
    } {
  const rawSavedStorageType = typeof localStorage !== 'undefined'
    ? localStorage.getItem(STORAGE_BOOTSTRAP_KEY)
    : null;

  if (rawSavedStorageType === null) {
    return {
      rawSavedStorageType,
      parsedSavedStorageType: { status: 'missing' },
    };
  }

  return {
    rawSavedStorageType,
    parsedSavedStorageType: parseStorageType({ rawStorageType: rawSavedStorageType }),
  };
}

export function parseBootstrapStorageTypeOverride({
  rawStorageType,
}: {
  rawStorageType: string,
}):
  | { status: 'valid', savedStorageType: StorageType }
  | { status: 'invalid', savedStorageTypeValidationError: ZodError } {
  return parseStorageType({ rawStorageType });
}
