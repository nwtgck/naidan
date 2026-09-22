import { z } from 'zod';
import { createWorkerBlobContext, type WorkerBlobReadHost } from '@/utils/worker-blob-context';
import { LlamaCppBrowserError } from '@/features/llama-cpp-browser/types';

const probeIdSchema = z.uuid();
function probeName({ probeId }: { probeId: string }): string {
  return `.naidan-llama-shared-probe-${probeIdSchema.parse(probeId)}`;
}

/** Worker endpoint: never accepts an arbitrary model path or reads model data. */
// eslint-disable-next-line local-rules-named-args/require-named-args -- Comlink reverse proxies must be independent top-level arguments.
export async function verifyStorage({ probeId }: { probeId: string }, blobReadHost?: WorkerBlobReadHost): Promise<boolean> {
  // Only this startup RPC owns the reader. Resident model operations do not
  // borrow its context, and every exit releases its reverse proxy.
  const blobs = createWorkerBlobContext({ host: blobReadHost });
  try {
    const name = probeName({ probeId });
    const root = await navigator.storage.getDirectory();
    const handle = await root.getFileHandle(name);
    const file = await handle.getFile();
    // Resolve the nonce in this Worker's OPFS before delegating byte reads. Asking
    // the host to open the path would test the host against itself, not storage sharing.
    if (file.size !== probeId.length) return false;
    return await blobs.fromNative({ blob: file }).text() === probeId;
  } finally {
    blobs.dispose();
  }
}

/** A Blob Worker's file:// storage key must actually agree with the window's.
 * The temporary file is separate from model directories and is always removed. */
export async function verifySharedStorage({ verify, signal }: {
  verify: ({ probeId }: { probeId: string }) => Promise<boolean>,
  signal: AbortSignal | undefined,
}): Promise<void> {
  let root: FileSystemDirectoryHandle | undefined;
  let created = false;
  const probeId = crypto.randomUUID();
  const name = probeName({ probeId });
  const check = (): void => {
    if (signal?.aborted) throw new LlamaCppBrowserError({ code: 'aborted' });
  };
  try {
    check();
    root = await navigator.storage.getDirectory();
    check();
    const file = await root.getFileHandle(name, { create: true });
    created = true;
    check();
    const writer = await file.createWritable();
    try {
      check();
      await writer.write(probeId);
      await writer.close();
    } catch (error) {
      await writer.abort().catch(() => {});
      throw error;
    }
    check();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let abort: (() => void) | undefined;
    try {
      const verified = await Promise.race([
        verify({ probeId }),
        new Promise<never>((_resolve, reject) => {
          abort = () => reject(new LlamaCppBrowserError({ code: 'aborted' }));
          signal?.addEventListener('abort', abort, { once: true });
          timeout = setTimeout(() => reject(new LlamaCppBrowserError({ code: 'worker-failed' })), 10_000);
          if (signal?.aborted) abort();
        }),
      ]);
      if (verified !== true) throw new LlamaCppBrowserError({ code: 'unavailable' });
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
      if (abort) signal?.removeEventListener('abort', abort);
    }
  } catch (error) {
    if (error instanceof LlamaCppBrowserError) throw error;
    throw new LlamaCppBrowserError({ code: 'unavailable' });
  } finally {
    if (created && root) await root.removeEntry(name);
  }
}
export const TEST_ONLY = {
};
