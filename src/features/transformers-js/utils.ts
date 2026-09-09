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
      if (first === 'user' || first === 'local' || first === 'models') {
        let startIndex = 0;
        switch (first) {
        case 'models':
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
        const resolved = `models/user/${cleanParts.join('/')}`;
        return resolved;
      }
      return null;
    }

    const resolved = `models/${parsed.hostname}/${pathParts.join('/')}`;
    return resolved;
  } catch {
    const parts = url.split('/').filter(p => !!p);
    const first = parts[0];
    if (first === 'user' || first === 'local' || first === 'models') {
      let startIndex = 0;
      switch (first) {
      case 'models':
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
      const resolved = `models/user/${parts.slice(startIndex).join('/')}`;
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
}): Promise<number> {
  if (!('createWritable' in fileHandle)) {
    throw new Error('OPFS file handle does not support createWritable');
  }
  const writable = await (fileHandle as unknown as FileSystemFileHandleWithWritable).createWritable();
  if (response.body !== null) {
    let receivedByteLength = 0;
    await response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        receivedByteLength += chunk.byteLength;
        controller.enqueue(chunk);
      },
    })).pipeTo(writable);
    return receivedByteLength;
  }
  const bytes = await response.arrayBuffer();
  await writable.write(bytes);
  await writable.close();
  return bytes.byteLength;
}

/**
 * Length checks and transfer progress must describe the bytes exposed by fetch,
 * not the encoded HTTP payload. Native fetch can retain compression headers
 * after decoding the body, so that Content-Length cannot verify an OPFS file.
 */
export function expectedDecodedResponseByteLength({ response }: { response: Response }): number | undefined {
  const encoding = response.headers.get('content-encoding')?.trim().toLowerCase();
  if (encoding !== undefined && encoding !== '' && encoding !== 'identity') return undefined;
  const header = response.headers.get('content-length');
  if (header === null || !/^\d+$/u.test(header.trim())) return undefined;
  const value = Number(header);
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/** Full-file persistence never promotes a range or an unsuccessful response. */
export function fullResourceResponseError({ response }: { response: Response }): Error | undefined {
  if (!response.ok) return new Error(`HTTP ${response.status} ${response.statusText}`);
  if (response.status !== 200) return new Error(`Full resource response requires HTTP 200, received HTTP ${response.status}`);
  if (response.headers.has('Content-Range')) return new Error('Full resource response must not include Content-Range');
  return undefined;
}

export const REJECTED_RESOURCE_RESPONSE_CLEANUP_TIMEOUT_MS = 1_000;

/** Reject before writes; bound cleanup of unread or tee-branch response bodies. */
export async function rejectResourceResponse({ response, error }: { response: Response, error: Error }): Promise<never> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.resolve().then(() => response.body?.cancel()).catch(() => undefined),
      new Promise<void>(resolve => {
        timeout = setTimeout(resolve, REJECTED_RESOURCE_RESPONSE_CLEANUP_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
  // The original validation error always wins. The deadline cannot certify a
  // response as complete or prove transport termination; the caller still owns
  // its Worker. Normal successful responses never enter this cleanup wait.
  throw error;
}

export async function assertFullResourceResponse({ response }: { response: Response }): Promise<void> {
  const error = fullResourceResponseError({ response });
  if (error !== undefined) await rejectResourceResponse({ response, error });
}

/**
 * Writes a response body directly to its final OPFS path. This is the normal
 * Transformers.js custom-cache write path uses one response stream and one final
 * write. Completion is published only after the closed file passes verification;
 * the old marker must not certify replacement bytes when verification fails.
 */
export async function writeToOpfs({ path, response }: { path: string, response: Response }): Promise<void> {
  await assertFullResourceResponse({ response });
  const pathParts = path.split('/');
  const fileName = pathParts.pop()!;

  const root = await navigator.storage.getDirectory();
  let currentDir = root;
  for (const part of pathParts) {
    if (!part) continue;
    currentDir = await currentDir.getDirectoryHandle(part, { create: true });
  }

  const fileHandle = await currentDir.getFileHandle(fileName, { create: true });
  if (!('createWritable' in fileHandle)) {
    throw new Error('OPFS file handle does not support createWritable');
  }
  const markerName = `.${fileName}.complete`;
  await removeEntryIfPresent({ directory: currentDir, name: markerName });
  const receivedByteLength = await writeResponseBody({ fileHandle, response });
  const file = await fileHandle.getFile();
  const expectedByteLength = expectedDecodedResponseByteLength({ response });
  if (file.size === 0) throw new Error(`OPFS file is empty: ${path}`);
  if (file.size !== receivedByteLength) {
    throw new Error(`OPFS byte length mismatch for ${path}: consumed ${receivedByteLength}, stored ${file.size}`);
  }
  if (expectedByteLength !== undefined && file.size !== expectedByteLength) {
    throw new Error(`OPFS byte length mismatch for ${path}: expected ${expectedByteLength}, received ${file.size}`);
  }
  await currentDir.getFileHandle(markerName, { create: true });
}

/**
 * Writes through a unique staging file, verifies the staged bytes, then promotes
 * them to the final path. This is reserved for explicit prefetch/repair where an
 * existing completion marker must not survive a failed repair.
 */
export async function writeToOpfsWithStaging({ path, response }: { path: string, response: Response }): Promise<{ byteLength: number }> {
  await assertFullResourceResponse({ response });
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
    const receivedByteLength = await writeResponseBody({ fileHandle: stagingHandle, response });
    const stagedFile = await stagingHandle.getFile();
    const expectedByteLength = expectedDecodedResponseByteLength({ response });
    if (stagedFile.size === 0) throw new Error(`Staged OPFS file is empty: ${path}`);
    if (stagedFile.size !== receivedByteLength) {
      throw new Error(`Staged OPFS byte length mismatch for ${path}: consumed ${receivedByteLength}, stored ${stagedFile.size}`);
    }
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
