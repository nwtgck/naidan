import { z } from 'zod';

const opfsPathSegmentSchema = z.string()
  .min(1)
  .refine(segment => segment !== '.' && segment !== '..' && !segment.includes('/') && !segment.includes('\\'), {
    message: 'Invalid OPFS path segment',
  });

export const opfsDirectoryHandleLocatorSchema = z.object({
  kind: z.literal('opfs-directory'),
  pathSegments: z.array(opfsPathSegmentSchema).max(256),
});

function isFileSystemDirectoryHandle(value: unknown): value is FileSystemDirectoryHandle {
  return typeof value === 'object'
    && value !== null
    && 'kind' in value
    && value.kind === 'directory'
    && 'getDirectoryHandle' in value
    && typeof value.getDirectoryHandle === 'function';
}

export const fileSystemDirectoryHandleReferenceSchema = z.union([
  z.custom<FileSystemDirectoryHandle>(isFileSystemDirectoryHandle),
  opfsDirectoryHandleLocatorSchema,
]);

export type OpfsDirectoryHandleLocator = z.infer<typeof opfsDirectoryHandleLocatorSchema>;
export type FileSystemDirectoryHandleReference = z.infer<typeof fileSystemDirectoryHandleReferenceSchema>;

type FileSystemHandleCloneCapability = 'unknown' | 'supported' | 'unsupported';

let fileSystemHandleCloneCapability: FileSystemHandleCloneCapability = 'unknown';

export function isDataCloneError({ error }: { error: unknown }): boolean {
  return typeof error === 'object'
    && error !== null
    && 'name' in error
    && error.name === 'DataCloneError';
}

export async function runWithFileSystemHandleCloneFallback<T>({
  direct,
  fallback,
}: {
  direct: () => Promise<T>,
  fallback: () => Promise<T>,
}): Promise<T> {
  switch (fileSystemHandleCloneCapability) {
  case 'unsupported':
    return fallback();
  case 'unknown':
  case 'supported':
    break;
  default: {
    const _ex: never = fileSystemHandleCloneCapability;
    throw new Error(`Unhandled file system handle clone capability: ${String(_ex)}`);
  }
  }

  try {
    const result = await direct();
    fileSystemHandleCloneCapability = 'supported';
    return result;
  } catch (error) {
    if (!isDataCloneError({ error })) {
      throw error;
    }
    fileSystemHandleCloneCapability = 'unsupported';
    return fallback();
  }
}

export async function createOpfsDirectoryHandleLocator({
  opfsRoot,
  handle,
}: {
  opfsRoot: FileSystemDirectoryHandle,
  handle: FileSystemDirectoryHandle,
}): Promise<OpfsDirectoryHandleLocator> {
  const pathSegments = await opfsRoot.resolve(handle);
  if (pathSegments === null) {
    throw new DOMException(
      'The directory handle cannot be reconstructed in a Worker because it is not inside OPFS.',
      'NotSupportedError',
    );
  }
  return opfsDirectoryHandleLocatorSchema.parse({
    kind: 'opfs-directory',
    pathSegments,
  });
}

export function createFileSystemDirectoryHandleReferenceResolver(): {
  resolve({ reference }: {
    reference: FileSystemDirectoryHandleReference,
  }): Promise<FileSystemDirectoryHandle>,
  } {
  let opfsRootPromise: Promise<FileSystemDirectoryHandle> | undefined;

  return {
    async resolve({ reference }) {
      if (isFileSystemDirectoryHandle(reference)) {
        return reference;
      }

      const locator = opfsDirectoryHandleLocatorSchema.parse(reference);
      opfsRootPromise ??= navigator.storage.getDirectory();
      let current = await opfsRootPromise;
      for (const segment of locator.pathSegments) {
        current = await current.getDirectoryHandle(segment);
      }
      return current;
    },
  };
}

export const TEST_ONLY = {
  resetFileSystemHandleCloneCapability() {
    fileSystemHandleCloneCapability = 'unknown';
  },
};
