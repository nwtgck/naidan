import {
  HizoFSDescriptorSchemaDto,
  type HizoFSDescriptorDto,
} from '@/00-storage/00-dto/hizofs.dto';
import type { HizoFSBackingStore } from '@/00-storage/service/hizofs/backing-store/backing-store';
import { createHizoFSStableId, validateHizoFSStableId } from '@/00-storage/service/hizofs/id';

const DESCRIPTOR_PATH = ['descriptor.json'] as const;

function encodeDescriptor({ descriptor }: {
  descriptor: HizoFSDescriptorDto;
}): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(descriptor, undefined, 2)}\n`);
}

export async function createHizoFSDescriptor({ backingStore }: {
  backingStore: HizoFSBackingStore;
}): Promise<HizoFSDescriptorDto> {
  if (await backingStore.read({ path: DESCRIPTOR_PATH }) !== undefined) {
    throw new Error('HizoFS descriptor already exists');
  }
  const descriptor: HizoFSDescriptorDto = {
    format: 'hizofs',
    formatVersion: 1,
    fileSystemId: createHizoFSStableId(),
  };
  await backingStore.write({
    path: DESCRIPTOR_PATH,
    bytes: encodeDescriptor({ descriptor }),
  });
  return descriptor;
}

export async function readHizoFSDescriptor({ backingStore }: {
  backingStore: HizoFSBackingStore;
}): Promise<HizoFSDescriptorDto | undefined> {
  const bytes = await backingStore.read({ path: DESCRIPTOR_PATH });
  if (bytes === undefined) {
    return undefined;
  }

  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch (error) {
    throw new Error('HizoFS descriptor is invalid UTF-8 JSON', { cause: error });
  }
  const descriptor = HizoFSDescriptorSchemaDto.parse(raw);
  validateHizoFSStableId({
    value: descriptor.fileSystemId,
    fieldName: 'HizoFS fileSystemId',
  });
  return descriptor;
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
