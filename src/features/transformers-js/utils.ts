import { NAIDAN_OPFS_MODELS_DIRECTORY_NAME } from '@/00-storage/service/opfs/naidan-opfs-root-directory-registry';

/**
 * Interface to extend FileSystemFileHandle with the non-standard createWritable method.
 */
export interface FileSystemFileHandleWithWritable extends FileSystemFileHandle {
  createWritable(): Promise<FileSystemWritableFileStream>,
}

/**
 * Converts a URL (Hugging Face or local) to an OPFS path.
 */
export function urlToPath({ url }: { url: string }): string | null {
  try {
    const parsed = new URL(url);
    const pathParts = parsed.pathname.split('/').filter(p => !!p);

    const isLocalOrigin = parsed.origin === self.location.origin ||
                          parsed.hostname === 'localhost' ||
                          parsed.hostname === '127.0.0.1';

    if (isLocalOrigin) {
      const first = pathParts[0];
      if (first === 'user' || first === 'local' || first === NAIDAN_OPFS_MODELS_DIRECTORY_NAME) {
        let startIndex = 0;
        switch (first) {
        case NAIDAN_OPFS_MODELS_DIRECTORY_NAME:
          startIndex++;
          break;
        case 'user':
        case 'local':
          break;
        default: {
          const _ex: never = first;
          throw new Error(`Unhandled path part: ${_ex}`);
        }
        }
        if (pathParts[startIndex] === 'user' || pathParts[startIndex] === 'local') startIndex++;

        const cleanParts = pathParts.slice(startIndex);
        const resolved = `${NAIDAN_OPFS_MODELS_DIRECTORY_NAME}/user/${cleanParts.join('/')}`;
        return resolved;
      }
      return null;
    }

    const resolved = `${NAIDAN_OPFS_MODELS_DIRECTORY_NAME}/${parsed.hostname}/${pathParts.join('/')}`;
    return resolved;
  } catch {
    const parts = url.split('/').filter(p => !!p);
    const first = parts[0];
    if (first === 'user' || first === 'local' || first === NAIDAN_OPFS_MODELS_DIRECTORY_NAME) {
      let startIndex = 0;
      switch (first) {
      case NAIDAN_OPFS_MODELS_DIRECTORY_NAME:
        startIndex++;
        break;
      case 'user':
      case 'local':
        break;
      default: {
        const _ex: never = first;
        throw new Error(`Unhandled path part: ${_ex}`);
      }
      }
      if (parts[startIndex] === 'user' || parts[startIndex] === 'local') startIndex++;
      const resolved = `${NAIDAN_OPFS_MODELS_DIRECTORY_NAME}/user/${parts.slice(startIndex).join('/')}`;
      return resolved;
    }
    return null;
  }
}

/**
 * Removes an OPFS entry when it exists while preserving unexpected failures.
 */
async function removeEntryIfPresent({ directory, name }: {
  directory: FileSystemDirectoryHandle,
  name: string,
}): Promise<void> {
  try {
    await directory.removeEntry(name);
  } catch (error) {
    if (error instanceof Error && error.name === 'NotFoundError') return;
    throw error;
  }
}

async function writeResponseBody({ fileHandle, response }: {
  fileHandle: FileSystemFileHandle,
  response: Response,
}): Promise<void> {
  if (!('createWritable' in fileHandle)) {
    throw new Error('OPFS file handle does not support createWritable');
  }
  const writable = await (fileHandle as unknown as FileSystemFileHandleWithWritable).createWritable();
  if (response.body !== null) {
    await response.body.pipeTo(writable);
    return;
  }
  await writable.write(await response.arrayBuffer());
  await writable.close();
}

function expectedResponseByteLength({ response }: { response: Response }): number | undefined {
  const header = response.headers.get('content-length');
  if (header === null) return undefined;
  const value = Number(header);
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/**
 * Writes a response body directly to its final OPFS path. This is the normal
 * Transformers.js custom-cache write path and intentionally preserves the
 * pre-investigation production behavior: one response stream, one final write,
 * then the completion marker.
 */
export async function writeToOpfs({ path, response }: { path: string, response: Response }): Promise<void> {
  const pathParts = path.split('/');
  const fileName = pathParts.pop()!;

  const root = await navigator.storage.getDirectory();
  let currentDir = root;
  for (const part of pathParts) {
    if (!part) continue;
    currentDir = await currentDir.getDirectoryHandle(part, { create: true });
  }

  const fileHandle = await currentDir.getFileHandle(fileName, { create: true });
  if ('createWritable' in fileHandle) {
    const writable = await (fileHandle as unknown as FileSystemFileHandleWithWritable).createWritable();
    if (response.body !== null) {
      await response.body.pipeTo(writable);
    } else {
      await writable.write(await response.arrayBuffer());
      await writable.close();
    }
    await currentDir.getFileHandle(`.${fileName}.complete`, { create: true });
  }
}

/**
 * Writes through a unique staging file, verifies the staged bytes, then promotes
 * them to the final path. This is reserved for explicit prefetch/repair where an
 * existing completion marker must not survive a failed repair.
 */
export async function writeToOpfsWithStaging({ path, response }: { path: string, response: Response }): Promise<{ byteLength: number }> {
  const pathParts = path.split('/');
  const fileName = pathParts.pop()!;
  const markerName = `.${fileName}.complete`;
  const stagingName = `.${fileName}.staging-${crypto.randomUUID()}`;

  const root = await navigator.storage.getDirectory();
  let currentDir = root;
  for (const part of pathParts) {
    if (!part) continue;
    currentDir = await currentDir.getDirectoryHandle(part, { create: true });
  }

  let promotionStarted = false;
  try {
    const stagingHandle = await currentDir.getFileHandle(stagingName, { create: true });
    await writeResponseBody({ fileHandle: stagingHandle, response });
    const stagedFile = await stagingHandle.getFile();
    const expectedByteLength = expectedResponseByteLength({ response });
    if (stagedFile.size === 0) throw new Error(`Staged OPFS file is empty: ${path}`);
    if (expectedByteLength !== undefined && stagedFile.size !== expectedByteLength) {
      throw new Error(`Staged OPFS byte length mismatch for ${path}: expected ${expectedByteLength}, received ${stagedFile.size}`);
    }

    promotionStarted = true;
    await removeEntryIfPresent({ directory: currentDir, name: markerName });
    const finalHandle = await currentDir.getFileHandle(fileName, { create: true });
    await writeResponseBody({
      fileHandle: finalHandle,
      response: new Response(stagedFile.stream(), {
        headers: { 'Content-Length': String(stagedFile.size) },
      }),
    });
    const finalFile = await finalHandle.getFile();
    if (finalFile.size !== stagedFile.size) {
      throw new Error(`Promoted OPFS byte length mismatch for ${path}: expected ${stagedFile.size}, received ${finalFile.size}`);
    }
    await currentDir.getFileHandle(markerName, { create: true });
    return { byteLength: finalFile.size };
  } catch (error) {
    if (promotionStarted) {
      try {
        await removeEntryIfPresent({ directory: currentDir, name: markerName });
        await removeEntryIfPresent({ directory: currentDir, name: fileName });
      } catch (cleanupError) {
        console.error('[transformersJs] Failed to clean a partially promoted OPFS file', cleanupError);
      }
    }
    throw error;
  } finally {
    try {
      await removeEntryIfPresent({ directory: currentDir, name: stagingName });
    } catch (cleanupError) {
      console.warn('[transformersJs] Failed to remove an OPFS staging file', cleanupError);
    }
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
