import {
  EncryptedOpfsDescriptorSchemaDto,
  type EncryptedOpfsDescriptorDto,
} from '@/00-storage/00-dto/encrypted-opfs.dto';
import type { EncryptedOpfsBackingStore } from '@/00-storage/service/encrypted-opfs/backing-store/backing-store';
import { createEncryptedOpfsStableId, validateEncryptedOpfsStableId } from '@/00-storage/service/encrypted-opfs/id';

const DESCRIPTOR_PATH = ['descriptor.json'] as const;

function encodeDescriptor({ descriptor }: {
  descriptor: EncryptedOpfsDescriptorDto;
}): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(descriptor, undefined, 2)}\n`);
}

export async function createEncryptedOpfsDescriptor({ backingStore }: {
  backingStore: EncryptedOpfsBackingStore;
}): Promise<EncryptedOpfsDescriptorDto> {
  if (await backingStore.read({ path: DESCRIPTOR_PATH }) !== undefined) {
    throw new Error('EncryptedOpfs descriptor already exists');
  }
  const descriptor: EncryptedOpfsDescriptorDto = {
    formatVersion: 1,
    fileSystemId: createEncryptedOpfsStableId(),
  };
  await backingStore.write({
    path: DESCRIPTOR_PATH,
    bytes: encodeDescriptor({ descriptor }),
  });
  return descriptor;
}

export async function readEncryptedOpfsDescriptor({ backingStore }: {
  backingStore: EncryptedOpfsBackingStore;
}): Promise<EncryptedOpfsDescriptorDto | undefined> {
  const bytes = await backingStore.read({ path: DESCRIPTOR_PATH });
  if (bytes === undefined) {
    return undefined;
  }

  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch (error) {
    throw new Error('EncryptedOpfs descriptor is invalid UTF-8 JSON', { cause: error });
  }
  const descriptor = EncryptedOpfsDescriptorSchemaDto.parse(raw);
  validateEncryptedOpfsStableId({
    value: descriptor.fileSystemId,
    fieldName: 'EncryptedOpfs fileSystemId',
  });
  return descriptor;
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
