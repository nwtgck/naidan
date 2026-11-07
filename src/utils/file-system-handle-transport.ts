import { FILE_SYSTEM_HANDLE_CLONING_REQUIRES_SUCCESSFUL_RUNTIME_FEATURE_DETECTION } from './worker-transport-capabilities';
import { prepareWorkerCapability, type WorkerCapability } from './worker-transport';
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

export function isDataCloneError({ error }: { error: unknown }): boolean {
  return typeof error === 'object'
    && error !== null
    && 'name' in error
    && error.name === 'DataCloneError';
}

/** Probe before application work. In particular, a DataCloneError returned by
 * an already running Worker must not cause a second init/write operation. */
export async function runWithFileSystemHandleCloneFallback<T, Request extends object>({
  request, direct, fallback,
}: {
  request: Request,
  direct: ({ request }: { request: WorkerCapability<Request, typeof FILE_SYSTEM_HANDLE_CLONING_REQUIRES_SUCCESSFUL_RUNTIME_FEATURE_DETECTION> }) => Promise<T>,
  fallback: () => Promise<T>,
}): Promise<T> {
  const prepared = await prepareWorkerCapability({
    value: request,
    capability: FILE_SYSTEM_HANDLE_CLONING_REQUIRES_SUCCESSFUL_RUNTIME_FEATURE_DETECTION,
    fallback: async () => undefined,
  });
  return prepared === undefined ? fallback() : direct({ request: prepared });
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
};
