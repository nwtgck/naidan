import {
  HizoFSDescriptorSchemaDto,
  type HizoFSDescriptorDto,
} from '@/00-storage/00-dto/hizofs.dto';
import type { HizoFSBackingStore } from '@/00-storage/service/hizofs/backing-store/backing-store';
import {
  validateHizoFSStableId,
} from '@/00-storage/service/hizofs/id';
import { ZodError } from 'zod';

const DESCRIPTOR_PATH = ['descriptor.json'] as const;

export class HizoFSDescriptorCorruptionError extends Error {
  constructor({ message, cause }: {
    message: string;
    cause: unknown;
  }) {
    super(message, { cause });
    this.name = 'HizoFSDescriptorCorruptionError';
  }
}

function createCanonicalDescriptor({ instanceId }: {
  instanceId: string;
}): HizoFSDescriptorDto {
  return {
    format: 'hizofs',
    formatVersion: 1,
    instanceId,
  };
}


function encodeDescriptor({ descriptor }: {
  descriptor: HizoFSDescriptorDto;
}): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(descriptor, undefined, 2)}\n`);
}

async function assertBackingStoreIsEmpty({ backingStore }: {
  backingStore: HizoFSBackingStore;
}): Promise<void> {
  for await (const entry of backingStore.list({ path: [] })) {
    throw new Error(
      `HizoFS backing directory must be empty before creation: ${entry.name}`,
    );
  }
}

export async function createHizoFSDescriptor({ backingStore, instanceId }: {
  backingStore: HizoFSBackingStore;
  instanceId: string;
}): Promise<HizoFSDescriptorDto> {
  // The complete directory is owned by one HizoFS instance. Requiring an empty
  // directory prevents descriptor loss from turning old encrypted objects into
  // an apparently valid newly-created filesystem.
  await assertBackingStoreIsEmpty({ backingStore });
  validateHizoFSStableId({
    value: instanceId,
    fieldName: 'HizoFS descriptor instanceId',
  });
  const descriptor = createCanonicalDescriptor({ instanceId });
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
    throw new HizoFSDescriptorCorruptionError({
      message: 'HizoFS descriptor is invalid UTF-8 JSON',
      cause: error,
    });
  }
  try {
    const descriptor = HizoFSDescriptorSchemaDto.parse(raw);
    validateHizoFSStableId({
      value: descriptor.instanceId,
      fieldName: 'HizoFS descriptor instanceId',
    });
    return descriptor;
  } catch (error) {
    if (error instanceof ZodError) {
      throw new HizoFSDescriptorCorruptionError({
        message: `HizoFS descriptor is structurally invalid: ${error.message}`,
        cause: error,
      });
    }
    throw error;
  }
}


/**
 * Restores the non-secret format marker only after the caller has authenticated
 * a complete HizoFS generation with the root key. No key-domain information is
 * sourced from this file, so losing it cannot make the filesystem unreadable.
 */
export async function restoreHizoFSDescriptor({ backingStore, instanceId }: {
  backingStore: HizoFSBackingStore;
  instanceId: string;
}): Promise<HizoFSDescriptorDto> {
  validateHizoFSStableId({
    value: instanceId,
    fieldName: 'HizoFS descriptor instanceId',
  });
  try {
    const existing = await readHizoFSDescriptor({ backingStore });
    if (existing !== undefined) return existing;
  } catch (error) {
    if (!(error instanceof HizoFSDescriptorCorruptionError)) {
      throw error;
    }
  }
  const descriptor = createCanonicalDescriptor({ instanceId });
  await backingStore.write({
    path: DESCRIPTOR_PATH,
    bytes: encodeDescriptor({ descriptor }),
  });
  return descriptor;
}

export function getCanonicalHizoFSDescriptor({ instanceId }: {
  instanceId: string;
}): HizoFSDescriptorDto {
  validateHizoFSStableId({
    value: instanceId,
    fieldName: 'HizoFS descriptor instanceId',
  });
  return createCanonicalDescriptor({ instanceId });
}


// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
  DESCRIPTOR_PATH,
};
